import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { randomUUID } from "node:crypto";
import {
  Client,
  GatewayIntentBits,
  TextChannel,
  User,
  DMChannel,
  Partials,
} from "discord.js";
import { z } from "zod";

// Load environment variables
dotenv.config();

// ─── Config ──────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SENDER_NAME = process.env.SENDER_NAME || "";
const MCP_TRANSPORT = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();
const MCP_PORT = parseInt(process.env.MCP_PORT || "3100", 10);

if (!DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN environment variable is not set");
  process.exit(1);
}

// ─── Discord Client ──────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel], // Required for DM support
});

// ─── Helpers ─────────────────────────────────────────────

/** Prepend sender name to message if configured */
function prependSenderName(message: string, senderNameOverride?: string): string {
  const name = senderNameOverride || SENDER_NAME;
  if (!name) return message;
  return `【${name}】${message}`;
}

async function findGuild(guildIdentifier?: string) {
  if (!guildIdentifier) {
    if (client.guilds.cache.size === 1) {
      return client.guilds.cache.first()!;
    }
    const guildList = Array.from(client.guilds.cache.values())
      .map((g) => `"${g.name}"`)
      .join(", ");
    throw new Error(
      `Bot is in multiple servers. Please specify server name or ID. Available servers: ${guildList}`
    );
  }

  try {
    const guild = await client.guilds.fetch(guildIdentifier);
    if (guild) return guild;
  } catch {
    const guilds = client.guilds.cache.filter(
      (g) => g.name.toLowerCase() === guildIdentifier.toLowerCase()
    );
    if (guilds.size === 0) {
      const available = Array.from(client.guilds.cache.values())
        .map((g) => `"${g.name}"`)
        .join(", ");
      throw new Error(
        `Server "${guildIdentifier}" not found. Available servers: ${available}`
      );
    }
    if (guilds.size > 1) {
      const list = guilds.map((g) => `${g.name} (ID: ${g.id})`).join(", ");
      throw new Error(
        `Multiple servers found with name "${guildIdentifier}": ${list}. Please specify the server ID.`
      );
    }
    return guilds.first()!;
  }
  throw new Error(`Server "${guildIdentifier}" not found`);
}

async function findChannel(
  channelIdentifier: string,
  guildIdentifier?: string
): Promise<TextChannel> {
  const guild = await findGuild(guildIdentifier);

  try {
    const channel = await client.channels.fetch(channelIdentifier);
    if (channel instanceof TextChannel && channel.guild.id === guild.id) {
      return channel;
    }
  } catch {
    const channels = guild.channels.cache.filter(
      (channel): channel is TextChannel =>
        channel instanceof TextChannel &&
        (channel.name.toLowerCase() === channelIdentifier.toLowerCase() ||
          channel.name.toLowerCase() ===
            channelIdentifier.toLowerCase().replace("#", ""))
    );
    if (channels.size === 0) {
      const available = guild.channels.cache
        .filter((c): c is TextChannel => c instanceof TextChannel)
        .map((c) => `"#${c.name}"`)
        .join(", ");
      throw new Error(
        `Channel "${channelIdentifier}" not found in server "${guild.name}". Available channels: ${available}`
      );
    }
    if (channels.size > 1) {
      const list = channels.map((c) => `#${c.name} (${c.id})`).join(", ");
      throw new Error(
        `Multiple channels found with name "${channelIdentifier}" in server "${guild.name}": ${list}. Please specify the channel ID.`
      );
    }
    return channels.first()!;
  }
  throw new Error(
    `Channel "${channelIdentifier}" is not a text channel or not found in server`
  );
}

async function findUser(userIdentifier: string): Promise<User> {
  // Try fetch by ID first
  try {
    const user = await client.users.fetch(userIdentifier);
    if (user) return user;
  } catch {
    // Not a valid ID
  }

  // Try to find by username across guilds
  for (const guild of client.guilds.cache.values()) {
    const members = await guild.members.fetch({ query: userIdentifier, limit: 5 });
    const match = members.find(
      (m) =>
        m.user.username.toLowerCase() === userIdentifier.toLowerCase() ||
        m.displayName.toLowerCase() === userIdentifier.toLowerCase()
    );
    if (match) return match.user;
  }

  throw new Error(
    `User "${userIdentifier}" not found. Please provide a valid user ID or exact username.`
  );
}

// ─── Zod Schemas ─────────────────────────────────────────

const SendMessageSchema = z.object({
  server: z.string().optional().describe("Server name or ID"),
  channel: z.string().describe('Channel name (e.g., "general") or ID'),
  message: z.string().describe("Message content to send"),
  sender_name: z.string().optional().describe("Override sender name for this message"),
  reply_to: z.coerce.string().optional().describe("Message ID to reply to (creates a thread-style reply)"),
});

const ReadMessagesSchema = z.object({
  server: z.string().optional().describe("Server name or ID"),
  channel: z.string().describe('Channel name (e.g., "general") or ID'),
  limit: z.number().min(1).max(100).default(50),
});

const SendDmSchema = z.object({
  user_id: z.string().describe("Discord user ID or username to send DM to"),
  message: z.string().describe("Message content to send"),
  sender_name: z.string().optional().describe("Override sender name for this message"),
});

const ReadDmSchema = z.object({
  user_id: z.string().describe("Discord user ID or username to read DMs from"),
  limit: z.number().min(1).max(100).default(50),
});

// ─── MCP Server Factory ─────────────────────────────────

function createMcpServer(): Server {
  const server = new Server(
    { name: "discord", version: "1.1.0" },
    { capabilities: { tools: {} } }
  );

  // ── List Tools ─────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "send-message",
        description: "Send a message to a Discord channel",
        inputSchema: {
          type: "object" as const,
          properties: {
            server: { type: "string", description: "Server name or ID (optional if bot is only in one server)" },
            channel: { type: "string", description: 'Channel name (e.g., "general") or ID' },
            message: { type: "string", description: "Message content to send" },
            sender_name: { type: "string", description: "Override sender name (optional, uses SENDER_NAME env if omitted)" },
            reply_to: { type: "string", description: "Message ID to reply to (creates a thread-style reply)" },
          },
          required: ["channel", "message"],
        },
      },
      {
        name: "read-messages",
        description: "Read recent messages from a Discord channel",
        inputSchema: {
          type: "object" as const,
          properties: {
            server: { type: "string", description: "Server name or ID (optional if bot is only in one server)" },
            channel: { type: "string", description: 'Channel name (e.g., "general") or ID' },
            limit: { type: "number", description: "Number of messages to fetch (max 100)", default: 50 },
          },
          required: ["channel"],
        },
      },
      {
        name: "send-dm",
        description: "Send a direct message (DM) to a Discord user",
        inputSchema: {
          type: "object" as const,
          properties: {
            user_id: { type: "string", description: "Discord user ID or username" },
            message: { type: "string", description: "Message content to send" },
            sender_name: { type: "string", description: "Override sender name (optional)" },
          },
          required: ["user_id", "message"],
        },
      },
      {
        name: "read-dm",
        description: "Read recent direct messages (DM) with a Discord user",
        inputSchema: {
          type: "object" as const,
          properties: {
            user_id: { type: "string", description: "Discord user ID or username" },
            limit: { type: "number", description: "Number of messages to fetch (max 100)", default: 50 },
          },
          required: ["user_id"],
        },
      },
    ],
  }));

  // ── Call Tool ───────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        // ── send-message ──────────────────────────
        case "send-message": {
          const { channel: chId, message, sender_name, server: srv, reply_to } =
            SendMessageSchema.parse(args);
          const channel = await findChannel(chId, srv);
          const finalMsg = prependSenderName(message, sender_name);
          let sent;
          if (reply_to) {
            const targetMsg = await channel.messages.fetch(reply_to);
            sent = await targetMsg.reply(finalMsg);
          } else {
            sent = await channel.send(finalMsg);
          }
          return {
            content: [
              {
                type: "text",
                text: `Message sent to #${channel.name} in ${channel.guild.name}. Message ID: ${sent.id}`,
              },
            ],
          };
        }

        // ── read-messages ─────────────────────────
        case "read-messages": {
          const { channel: chId, limit, server: srv } =
            ReadMessagesSchema.parse(args);
          const channel = await findChannel(chId, srv);
          const messages = await channel.messages.fetch({ limit });
          const formatted = Array.from(messages.values()).map((msg) => ({
            id: msg.id,
            channel: `#${channel.name}`,
            server: channel.guild.name,
            author: msg.author.tag,
            authorId: msg.author.id,
            content: msg.content,
            timestamp: msg.createdAt.toISOString(),
          }));
          return {
            content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }],
          };
        }

        // ── send-dm ───────────────────────────────
        case "send-dm": {
          const { user_id, message, sender_name } = SendDmSchema.parse(args);
          const user = await findUser(user_id);
          const finalMsg = prependSenderName(message, sender_name);
          const dmChannel = await user.createDM();
          const sent = await dmChannel.send(finalMsg);
          return {
            content: [
              {
                type: "text",
                text: `DM sent to ${user.tag} (${user.id}). Message ID: ${sent.id}`,
              },
            ],
          };
        }

        // ── read-dm ───────────────────────────────
        case "read-dm": {
          const { user_id, limit } = ReadDmSchema.parse(args);
          const user = await findUser(user_id);
          const dmChannel = await user.createDM();
          const messages = await dmChannel.messages.fetch({ limit });
          const formatted = Array.from(messages.values()).map((msg) => ({
            author: msg.author.tag,
            content: msg.content,
            timestamp: msg.createdAt.toISOString(),
            isBot: msg.author.bot,
          }));
          return {
            content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }],
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      console.error(`[MCP TOOL ERROR] tool=${name} error=${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof z.ZodError) {
        throw new Error(
          `Invalid arguments: ${error.errors
            .map((e) => `${e.path.join(".")}: ${e.message}`)
            .join(", ")}`
        );
      }
      throw error;
    }
  });

  return server;
}

// ─── Transport: stdio ────────────────────────────────────

async function startStdio() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Discord MCP Server running on stdio");
}

// ─── Transport: Streamable HTTP ──────────────────────────

async function startHttp() {
  const app = express();
  app.use(cors());

  app.use(express.json());

  // Fix: claude.ai Web sends Accept: application/json only,
  // but MCP SDK requires both application/json and text/event-stream.
  // Patch at raw IncomingMessage level so @hono/node-server picks it up.
  function patchAcceptHeader(req: express.Request): void {
    const accept = req.headers["accept"] || "";
    if (!accept.includes("text/event-stream")) {
      const newAccept = accept
        ? `${accept}, text/event-stream`
        : "application/json, text/event-stream";
      req.headers["accept"] = newAccept;
      // Also patch rawHeaders for @hono/node-server compatibility
      const raw = req.rawHeaders;
      for (let i = 0; i < raw.length; i += 2) {
        if (raw[i].toLowerCase() === "accept") {
          raw[i + 1] = newAccept;
          return;
        }
      }
      raw.push("Accept", newAccept);
    }
  }

  // Session → transport map
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", transport: "http", discord: client.isReady() });
  });

  // ── POST /mcp ──────────────────────────────────────
  app.post("/mcp", async (req, res) => {
    patchAcceptHeader(req);
    // Debug: log incoming request details
    console.error(`[MCP POST] session=${req.headers["mcp-session-id"] || "none"} accept=${req.headers["accept"]} body=${JSON.stringify(req.body)?.substring(0, 200)}`);
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (sessionId && !transports[sessionId]) {
      // Stale session: tell client to re-initialize
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Session expired. Please reconnect." },
        id: req.body?.id ?? null,
      });
      return;
    } else if (isInitializeRequest(req.body)) {
      // Allow initialize with or without session ID
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          delete transports[sid];
        }
      };
      const server = createMcpServer();
      await server.connect(transport);
    } else {
      res.status(400).json({ error: "Bad request: no valid session" });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  });

  // ── GET /mcp (SSE stream) ──────────────────────────
  app.get("/mcp", async (req, res) => {
    patchAcceptHeader(req);
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res);
    } else {
      // Return 405 Method Not Allowed for GET without session
      // This tells claude.ai to use POST instead
      res.status(405).set("Allow", "POST, DELETE").json({
        error: "Method Not Allowed: use POST to initialize",
      });
    }
  });

  // ── DELETE /mcp (close session) ────────────────────
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).json({ error: "Invalid or missing session ID" });
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  app.listen(MCP_PORT, () => {
    console.error(`Discord MCP Server (HTTP) listening on port ${MCP_PORT}`);
    console.error(`Endpoint: http://0.0.0.0:${MCP_PORT}/mcp`);
  });
}

// ─── Main ────────────────────────────────────────────────

async function main() {
  // Wait for Discord to be ready
  await client.login(DISCORD_TOKEN);
  await new Promise<void>((resolve) => {
    if (client.isReady()) return resolve();
    client.once("ready", () => {
      console.error("Discord bot is ready!");
      resolve();
    });
  });

  if (MCP_TRANSPORT === "http") {
    await startHttp();
  } else {
    await startStdio();
  }
}

main().catch((err) => {
  console.error("Fatal error in main():", err);
  process.exit(1);
});
