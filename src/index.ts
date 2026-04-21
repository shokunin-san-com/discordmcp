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
  ThreadChannel,
  User,
  DMChannel,
  Partials,
  ChannelType,
  GuildMember,
  AttachmentBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { z } from "zod";
// pdf-parse is loaded lazily to avoid its debug mode test-file loading on module init
import mammoth from "mammoth";
import * as XLSX from "xlsx";

// Load environment variables
dotenv.config();

// ─── Config ──────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SENDER_NAME = process.env.SENDER_NAME || "";
const MCP_TRANSPORT = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();
const MCP_PORT = parseInt(process.env.MCP_PORT || "3100", 10);
const ENABLE_ADMIN_TOOLS = process.env.ENABLE_ADMIN_TOOLS === "true";
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";

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

const SearchMessagesSchema = z.object({
  server: z.string().optional().describe("Server name or ID"),
  query: z.string().describe("Search keyword"),
  channel: z.string().optional().describe("Channel name or ID to search in (searches all channels if omitted)"),
  limit: z.number().min(1).max(50).default(20),
});

const AddReactionSchema = z.object({
  server: z.string().optional().describe("Server name or ID"),
  channel: z.string().describe("Channel name or ID"),
  message_id: z.coerce.string().describe("Message ID to react to"),
  emoji: z.string().describe("Emoji to add (e.g. 👍, ✅, or custom emoji name)"),
});

const EditMessageSchema = z.object({
  server: z.string().optional().describe("Server name or ID"),
  channel: z.string().describe("Channel name or ID"),
  message_id: z.coerce.string().describe("Message ID to edit (must be a message sent by this bot)"),
  new_content: z.string().describe("New message content"),
});

const DeleteMessageSchema = z.object({
  server: z.string().optional().describe("Server name or ID"),
  channel: z.string().describe("Channel name or ID"),
  message_id: z.coerce.string().describe("Message ID to delete (must be a message sent by this bot)"),
});

const GrantChannelAccessSchema = z.object({
  server: z.string().optional().describe("Server name or ID"),
  user_id: z.coerce.string().describe("User or Bot ID to grant access to"),
  channel: z.string().optional().describe("Channel name or ID (if omitted, grants access to ALL channels)"),
});

const SendFileSchema = z.object({
  server: z.string().optional().describe("Server name or ID"),
  channel: z.string().describe('Channel name (e.g., "general") or ID'),
  filename: z.string().describe("Filename to display (e.g., 'report.pdf')"),
  url: z.string().optional().describe("URL to fetch the file from"),
  content: z.string().optional().describe("Text content (for .txt/.md files)"),
  base64: z.string().optional().describe("Base64-encoded file content"),
  message: z.string().optional().describe("Optional message to include with the file"),
  sender_name: z.string().optional().describe("Override sender name"),
});

const ReadAttachmentSchema = z.object({
  server: z.string().optional().describe("Server name or ID"),
  channel: z.string().describe("Channel name or ID"),
  message_id: z.coerce.string().describe("Message ID containing the attachment"),
  attachment_index: z.number().min(0).default(0).describe("Which attachment to read (0-indexed, default first)"),
});

const ListChannelsSchema = z.object({
  server: z.string().optional().describe("Server name or ID"),
});

const ReadThreadSchema = z.object({
  server: z.string().optional().describe("Server name or ID"),
  channel: z.string().describe("Channel name or ID where the thread exists"),
  thread: z.string().describe("Thread name or ID"),
  limit: z.number().min(1).max(100).default(50),
});

const ListMembersSchema = z.object({
  server: z.string().optional().describe("Server name or ID"),
  limit: z.number().min(1).max(100).default(50),
});

// ─── MCP Server Factory ─────────────────────────────────

function createMcpServer(): Server {
  const server = new Server(
    { name: "discord", version: "1.4.0" },
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
      {
        name: "search-messages",
        description: "Search messages by keyword across channels",
        inputSchema: {
          type: "object" as const,
          properties: {
            server: { type: "string", description: "Server name or ID (optional)" },
            query: { type: "string", description: "Search keyword" },
            channel: { type: "string", description: "Channel name or ID to search in (optional, searches all if omitted)" },
            limit: { type: "number", description: "Max results (max 50)", default: 20 },
          },
          required: ["query"],
        },
      },
      {
        name: "add-reaction",
        description: "Add an emoji reaction to a message",
        inputSchema: {
          type: "object" as const,
          properties: {
            server: { type: "string", description: "Server name or ID (optional)" },
            channel: { type: "string", description: "Channel name or ID" },
            message_id: { type: "string", description: "Message ID to react to" },
            emoji: { type: "string", description: "Emoji to add (e.g. 👍, ✅)" },
          },
          required: ["channel", "message_id", "emoji"],
        },
      },
      {
        name: "edit-message",
        description: "Edit a message sent by this bot",
        inputSchema: {
          type: "object" as const,
          properties: {
            server: { type: "string", description: "Server name or ID (optional)" },
            channel: { type: "string", description: "Channel name or ID" },
            message_id: { type: "string", description: "Message ID to edit" },
            new_content: { type: "string", description: "New message content" },
          },
          required: ["channel", "message_id", "new_content"],
        },
      },
      {
        name: "delete-message",
        description: "Delete a message sent by this bot",
        inputSchema: {
          type: "object" as const,
          properties: {
            server: { type: "string", description: "Server name or ID (optional)" },
            channel: { type: "string", description: "Channel name or ID" },
            message_id: { type: "string", description: "Message ID to delete" },
          },
          required: ["channel", "message_id"],
        },
      },
      {
        name: "send-file",
        description: "Send a file to a Discord channel (from URL, text content, or base64)",
        inputSchema: {
          type: "object" as const,
          properties: {
            server: { type: "string", description: "Server name or ID (optional)" },
            channel: { type: "string", description: 'Channel name (e.g., "general") or ID' },
            filename: { type: "string", description: "Filename to display (e.g. 'report.pdf')" },
            url: { type: "string", description: "URL to fetch the file from (alternative to content/base64)" },
            content: { type: "string", description: "Text content (for .txt/.md/.csv files)" },
            base64: { type: "string", description: "Base64-encoded binary file content" },
            message: { type: "string", description: "Optional message to include with the file" },
            sender_name: { type: "string", description: "Override sender name" },
          },
          required: ["channel", "filename"],
        },
      },
      {
        name: "read-attachment",
        description: "Read and extract content from a file attached to a Discord message (PDF/DOCX/XLSX/PPTX/MD/TXT)",
        inputSchema: {
          type: "object" as const,
          properties: {
            server: { type: "string", description: "Server name or ID (optional)" },
            channel: { type: "string", description: "Channel name or ID" },
            message_id: { type: "string", description: "Message ID containing the attachment" },
            attachment_index: { type: "number", description: "Which attachment to read (0-indexed)", default: 0 },
          },
          required: ["channel", "message_id"],
        },
      },
      ...(ENABLE_ADMIN_TOOLS ? [{
        name: "grant-channel-access",
        description: "[ADMIN] Grant a user or bot access to a specific channel (or all channels if channel is omitted)",
        inputSchema: {
          type: "object" as const,
          properties: {
            server: { type: "string", description: "Server name or ID (optional)" },
            user_id: { type: "string", description: "User or Bot ID to grant access to" },
            channel: { type: "string", description: "Channel name or ID (if omitted, grants access to ALL channels)" },
          },
          required: ["user_id"],
        },
      }] : []),
      {
        name: "list-channels",
        description: "List all text channels in the Discord server",
        inputSchema: {
          type: "object" as const,
          properties: {
            server: { type: "string", description: "Server name or ID (optional if bot is only in one server)" },
          },
          required: [],
        },
      },
      {
        name: "read-thread",
        description: "Read messages from a thread in a Discord channel",
        inputSchema: {
          type: "object" as const,
          properties: {
            server: { type: "string", description: "Server name or ID (optional if bot is only in one server)" },
            channel: { type: "string", description: "Channel name or ID where the thread exists" },
            thread: { type: "string", description: "Thread name or ID" },
            limit: { type: "number", description: "Number of messages to fetch (max 100)", default: 50 },
          },
          required: ["channel", "thread"],
        },
      },
      {
        name: "list-members",
        description: "List members in the Discord server",
        inputSchema: {
          type: "object" as const,
          properties: {
            server: { type: "string", description: "Server name or ID (optional if bot is only in one server)" },
            limit: { type: "number", description: "Number of members to fetch (max 100)", default: 50 },
          },
          required: [],
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

        // ── list-channels ─────────────────────────
        // ── search-messages ───────────────────────
        case "search-messages": {
          const { query, channel: chId, limit, server: srv } =
            SearchMessagesSchema.parse(args);
          const guild = await findGuild(srv);
          const queryLower = query.toLowerCase();

          let channelsToSearch: TextChannel[];
          if (chId) {
            channelsToSearch = [await findChannel(chId, srv)];
          } else {
            channelsToSearch = Array.from(
              guild.channels.cache
                .filter((c): c is TextChannel => c instanceof TextChannel)
                .values()
            );
          }

          const results: Array<{
            id: string;
            channel: string;
            author: string;
            authorId: string;
            content: string;
            timestamp: string;
          }> = [];

          for (const channel of channelsToSearch) {
            if (results.length >= limit) break;
            try {
              const messages = await channel.messages.fetch({ limit: 100 });
              for (const msg of messages.values()) {
                if (results.length >= limit) break;
                if (msg.content.toLowerCase().includes(queryLower)) {
                  results.push({
                    id: msg.id,
                    channel: `#${channel.name}`,
                    author: msg.author.tag,
                    authorId: msg.author.id,
                    content: msg.content,
                    timestamp: msg.createdAt.toISOString(),
                  });
                }
              }
            } catch {
              // Skip channels we can't read
            }
          }

          return {
            content: [{
              type: "text",
              text: results.length > 0
                ? JSON.stringify(results, null, 2)
                : `No messages found matching "${query}"`,
            }],
          };
        }

        // ── add-reaction ─────────────────────────
        case "add-reaction": {
          const { channel: chId, message_id, emoji, server: srv } =
            AddReactionSchema.parse(args);
          const channel = await findChannel(chId, srv);
          const msg = await channel.messages.fetch(message_id);
          await msg.react(emoji);
          return {
            content: [{
              type: "text",
              text: `Reaction ${emoji} added to message ${message_id} in #${channel.name}`,
            }],
          };
        }

        // ── edit-message ─────────────────────────
        case "edit-message": {
          const { channel: chId, message_id, new_content, server: srv } =
            EditMessageSchema.parse(args);
          const channel = await findChannel(chId, srv);
          const msg = await channel.messages.fetch(message_id);
          if (msg.author.id !== client.user?.id) {
            throw new Error("Can only edit messages sent by this bot");
          }
          await msg.edit(new_content);
          return {
            content: [{
              type: "text",
              text: `Message ${message_id} edited in #${channel.name}`,
            }],
          };
        }

        // ── delete-message ───────────────────────
        case "delete-message": {
          const { channel: chId, message_id, server: srv } =
            DeleteMessageSchema.parse(args);
          const channel = await findChannel(chId, srv);
          const msg = await channel.messages.fetch(message_id);
          if (msg.author.id !== client.user?.id) {
            throw new Error("Can only delete messages sent by this bot");
          }
          await msg.delete();
          return {
            content: [{
              type: "text",
              text: `Message ${message_id} deleted from #${channel.name}`,
            }],
          };
        }

        // ── send-file ────────────────────────────
        case "send-file": {
          const { channel: chId, filename, url, content, base64, message, sender_name, server: srv } =
            SendFileSchema.parse(args);
          const channel = await findChannel(chId, srv);

          let buffer: Buffer;
          if (url) {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Failed to fetch URL: ${res.statusText}`);
            buffer = Buffer.from(await res.arrayBuffer());
          } else if (content !== undefined) {
            buffer = Buffer.from(content, "utf-8");
          } else if (base64) {
            buffer = Buffer.from(base64, "base64");
          } else {
            throw new Error("One of: url, content, or base64 must be provided");
          }

          const attachment = new AttachmentBuilder(buffer, { name: filename });
          const finalMsg = message ? prependSenderName(message, sender_name) : undefined;
          const sent = await channel.send({
            ...(finalMsg ? { content: finalMsg } : {}),
            files: [attachment],
          });

          return {
            content: [{
              type: "text",
              text: `File "${filename}" (${buffer.length} bytes) sent to #${channel.name}. Message ID: ${sent.id}`,
            }],
          };
        }

        // ── read-attachment ─────────────────────
        case "read-attachment": {
          const { channel: chId, message_id, attachment_index, server: srv } =
            ReadAttachmentSchema.parse(args);
          const channel = await findChannel(chId, srv);
          const msg = await channel.messages.fetch(message_id);
          const attachments = Array.from(msg.attachments.values());

          if (attachments.length === 0) {
            throw new Error("This message has no attachments");
          }
          if (attachment_index >= attachments.length) {
            throw new Error(`Attachment index ${attachment_index} out of range (0-${attachments.length - 1})`);
          }

          const attachment = attachments[attachment_index];
          const filename = attachment.name?.toLowerCase() || "";
          const ext = filename.split(".").pop() || "";

          const res = await fetch(attachment.url);
          const buffer = Buffer.from(await res.arrayBuffer());

          let extractedText: string;
          let metadata: Record<string, unknown> = {
            filename: attachment.name,
            size: attachment.size,
            contentType: attachment.contentType || "unknown",
          };

          switch (ext) {
            case "pdf": {
              // Use internal lib path to avoid pdf-parse's debug entry
              // @ts-ignore
              const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default as (buffer: Buffer) => Promise<{ text: string; numpages: number }>;
              const data = await pdfParse(buffer);
              extractedText = data.text.trim();
              metadata.pages = data.numpages;
              metadata.fileType = "PDF";
              break;
            }
            case "docx": {
              const result = await mammoth.extractRawText({ buffer });
              extractedText = result.value.trim();
              metadata.fileType = "Word Document";
              break;
            }
            case "xlsx":
            case "xls": {
              const workbook = XLSX.read(buffer, { type: "buffer" });
              const sheets = workbook.SheetNames;
              const allSheets = sheets.map((sheetName) => {
                const sheet = workbook.Sheets[sheetName];
                const csv = XLSX.utils.sheet_to_csv(sheet);
                return `=== Sheet: ${sheetName} ===\n${csv}`;
              });
              extractedText = allSheets.join("\n\n");
              metadata.fileType = "Excel";
              metadata.sheets = sheets;
              break;
            }
            case "md":
            case "markdown":
            case "txt":
            case "csv":
            case "json":
            case "yaml":
            case "yml":
            case "xml":
            case "html":
              extractedText = buffer.toString("utf-8");
              metadata.fileType = ext.toUpperCase();
              break;
            case "pptx":
            case "ppt": {
              const JSZip = (await import("jszip")).default;
              const zip = await JSZip.loadAsync(buffer);
              const slideFiles = Object.keys(zip.files)
                .filter((name) => /ppt\/slides\/slide\d+\.xml$/.test(name))
                .sort((a, b) => {
                  const numA = parseInt(a.match(/slide(\d+)/)?.[1] ?? "0");
                  const numB = parseInt(b.match(/slide(\d+)/)?.[1] ?? "0");
                  return numA - numB;
                });
              const textParts: string[] = [];
              for (const slideFile of slideFiles) {
                const xml = await zip.files[slideFile].async("text");
                const matches = xml.match(/<a:t[^>]*>([^<]+)<\/a:t>/g) ?? [];
                const slideText = matches.map((m) => m.replace(/<[^>]+>/g, "")).join(" ");
                if (slideText.trim()) {
                  const slideNum = slideFile.match(/slide(\d+)/)?.[1];
                  textParts.push(`=== Slide ${slideNum} ===\n${slideText.trim()}`);
                }
              }
              extractedText = textParts.join("\n\n") || "(テキストコンテンツなし)";
              metadata.fileType = "PowerPoint";
              metadata.slides = slideFiles.length;
              break;
            }
            default:
              throw new Error(`Unsupported file type: .${ext}. Supported: PDF, DOCX, XLSX, PPTX, MD, TXT, CSV, JSON, etc.`);
          }

          return {
            content: [{
              type: "text",
              text: JSON.stringify({ ...metadata, content: extractedText }, null, 2),
            }],
          };
        }

        // ── grant-channel-access (admin) ─────────
        case "grant-channel-access": {
          if (!ENABLE_ADMIN_TOOLS) {
            throw new Error("Admin tools are not enabled on this MCP instance");
          }
          const { user_id, channel: chId, server: srv } = GrantChannelAccessSchema.parse(args);
          const guild = await findGuild(srv);

          const permissions = {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
            EmbedLinks: true,
            AttachFiles: true,
          };

          // Resolve the user/bot first
          const targetUser = await client.users.fetch(user_id);

          if (chId) {
            const channel = await findChannel(chId, srv);
            await channel.permissionOverwrites.edit(targetUser, permissions);
            return {
              content: [{ type: "text", text: `Granted access to ${targetUser.tag} on #${channel.name}` }],
            };
          } else {
            // Grant access to all text channels
            const results: string[] = [];
            const errors: string[] = [];
            for (const ch of guild.channels.cache.values()) {
              if (ch.type !== ChannelType.GuildText) continue;
              try {
                await (ch as TextChannel).permissionOverwrites.edit(targetUser, permissions);
                results.push(`#${ch.name}`);
              } catch (err) {
                errors.push(`#${ch.name}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  user: targetUser.tag,
                  granted: results,
                  errors,
                  total: results.length + errors.length,
                }, null, 2),
              }],
            };
          }
        }

        case "list-channels": {
          const { server: srv } = ListChannelsSchema.parse(args);
          const guild = await findGuild(srv);
          const channels = guild.channels.cache
            .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildForum)
            .map((c) => ({
              id: c.id,
              name: `#${c.name}`,
              type: c.type === ChannelType.GuildForum ? "forum" : "text",
              category: c.parent?.name || "none",
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
          return {
            content: [{ type: "text", text: JSON.stringify(channels, null, 2) }],
          };
        }

        // ── read-thread ──────────────────────────
        case "read-thread": {
          const { channel: chId, thread: threadId, limit, server: srv } =
            ReadThreadSchema.parse(args);
          const channel = await findChannel(chId, srv);

          // Fetch active threads
          const activeThreads = await channel.threads.fetchActive();
          const archivedThreads = await channel.threads.fetchArchived();
          const allThreads = [
            ...activeThreads.threads.values(),
            ...archivedThreads.threads.values(),
          ];

          // Find thread by ID or name
          const thread = allThreads.find(
            (t) =>
              t.id === threadId ||
              t.name.toLowerCase() === threadId.toLowerCase()
          );

          if (!thread) {
            const available = allThreads.map((t) => `"${t.name}" (${t.id})`).join(", ");
            throw new Error(
              `Thread "${threadId}" not found in #${channel.name}. Available threads: ${available || "none"}`
            );
          }

          const messages = await thread.messages.fetch({ limit });
          const formatted = Array.from(messages.values()).map((msg) => ({
            id: msg.id,
            thread: thread.name,
            channel: `#${channel.name}`,
            author: msg.author.tag,
            authorId: msg.author.id,
            content: msg.content,
            timestamp: msg.createdAt.toISOString(),
          }));
          return {
            content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }],
          };
        }

        // ── list-members ─────────────────────────
        case "list-members": {
          const { server: srv, limit } = ListMembersSchema.parse(args);
          const guild = await findGuild(srv);
          // Use cache first, fetch only if cache is empty
          let members = guild.members.cache;
          if (members.size === 0) {
            members = await guild.members.fetch({ limit, time: 10000 });
          }
          const sorted = Array.from(members.values()).slice(0, limit);
          const formatted = sorted.map((m: GuildMember) => ({
            id: m.id,
            username: m.user.username,
            displayName: m.displayName,
            tag: m.user.tag,
            isBot: m.user.bot,
            roles: m.roles.cache
              .filter((r) => r.name !== "@everyone")
              .map((r) => r.name),
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

  // Health check (always public, no auth required)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", transport: "http", discord: client.isReady() });
  });

  // Bearer token auth on /mcp routes only.
  // When MCP_AUTH_TOKEN is empty, auth is disabled (backward compat for shared bots).
  // When set, all /mcp requests must present Authorization: Bearer <token>.
  if (MCP_AUTH_TOKEN) {
    app.use("/mcp", (req, res, next) => {
      const header = req.headers["authorization"] || "";
      const match = /^Bearer\s+(.+)$/i.exec(Array.isArray(header) ? header[0] : header);
      const provided = match ? match[1].trim() : "";
      if (provided !== MCP_AUTH_TOKEN) {
        res.status(401).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized: invalid or missing token" },
          id: (req.body && typeof req.body === "object" && "id" in req.body) ? (req.body as any).id : null,
        });
        return;
      }
      next();
    });
    console.error(`[auth] MCP_AUTH_TOKEN enabled (length=${MCP_AUTH_TOKEN.length})`);
  } else {
    console.error(`[auth] MCP_AUTH_TOKEN not set — /mcp is open (no auth)`);
  }

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
      // Stale session: return 404 to trigger client reconnection
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session not found. Please reconnect." },
        id: req.body?.id ?? null,
      });
      return;
    } else if (isInitializeRequest(req.body)) {
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
