/**
 * Daily Task Scan — 全businessチャンネル横断でスタックしているタスクを検出し、
 * 当事者メンション付きで各チャンネル・DM・#6-20_okabe-midori-chiba に配信する。
 *
 * 毎朝 8:00 JST に PM2 cron で実行される前提。
 *
 * 【検出対象】
 * - 3日以上返答なし
 * - 期限超過 or 24時間以内接近
 * - アサインなしで浮いているタスク
 * - ブロッキング(後続待ち)
 *
 * 【配信先】
 * - 各business系チャンネル(#01〜#10 + #04-3) ← 当事者メンション付き
 * - 各メンバーDM ← 自分宛タスク一覧
 * - 岡部DM ← 判断待ち一覧
 * - #6-20_okabe-midori-chiba ← 拾うべき候補サマリー
 *
 * 【必要な環境変数】
 *   DISCORD_TOKEN         白電伝虫(千葉専用) のトークン
 *   TASK_SCAN_LOOKBACK_DAYS   メッセージ収集期間(デフォルト14日)
 *   TASK_SCAN_STATE_FILE      重複検出回避のstateファイル
 *
 * 【現状】
 * v0 骨組み段階。メッセージ収集までは動くが、判定ロジック(L1-L3)は
 * 緑川さんのルール草案v2確定待ちでTODOに置いている。
 */

import dotenv from "dotenv";
import { Client, GatewayIntentBits, TextChannel, Message } from "discord.js";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Config ──────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const LOOKBACK_DAYS = parseInt(process.env.TASK_SCAN_LOOKBACK_DAYS || "14", 10);
const STATE_FILE = process.env.TASK_SCAN_STATE_FILE ||
  path.join(__dirname, "..", "..", ".task-scan-state.json");

if (!DISCORD_TOKEN) {
  console.error("[daily-task-scan] DISCORD_TOKEN is not set");
  process.exit(1);
}

// ─── チャンネル・メンバー定義 ──────────────────────────────
// 当面のところ index.ts と重複するのでそのままハードコード。
// 将来的に config.json に切り出す。

interface ChannelConfig {
  id: string;
  name: string;
  category: string;
}

const BUSINESS_CHANNELS: ChannelConfig[] = [
  { id: "1491962527758946304", name: "#2-05_company-group-ma", category: "business" },
  { id: "1493128095589470301", name: "#2-10_psol-ma",         category: "business" },
  { id: "1491962293905264832", name: "#2-15_skilled-worker",  category: "business" },
  { id: "1491959139369222154", name: "#2-20_dev-internal",  category: "business" },
  { id: "1491959190388998265", name: "#04-2_dev-client",    category: "business" },
  { id: "1495575864816046262", name: "#2-30_dev-jtn",       category: "business" },
  { id: "1493129040197058630", name: "#2-35_group-sales",     category: "business" },
  { id: "1491962491381481628", name: "#2-40_portal-site",     category: "business" },
  { id: "1491962387278860409", name: "#2-45_sns-team",        category: "business" },
  { id: "1491961018472202421", name: "#2-50_recruiting",      category: "business" },
  { id: "1493131647409979402", name: "#2-55_back-office",     category: "business" },
  { id: "1493881818502402198", name: "#2-60_kc-vietnam",      category: "business" },
];

const SUMMARY_CHANNEL_ID = "1493881566630379650"; // #6-20_okabe-midori-chiba
const CEO_USER_ID = "716252853941043230"; // 岡部洋佑

interface MemberConfig {
  id: string;
  name: string;
  short: string; // 議事録等で使う表記
}

const MEMBERS: MemberConfig[] = [
  { id: "716252853941043230",  name: "岡部洋佑",      short: "岡部"   },
  { id: "1271652114975817798", name: "千葉実佑",      short: "千葉"   },
  { id: "1492054775695675412", name: "櫻井正美",      short: "櫻井"   },
  { id: "1493785666880934029", name: "飯田恵理子",    short: "飯田"   },
  { id: "1493410917763780698", name: "野々山ありさ",  short: "野々山" },
  { id: "1492050661859397782", name: "井原奏夢",      short: "井原"   },
  { id: "1493147089918627912", name: "吉川真緒梨",    short: "吉川"   },
  { id: "1493524866551382026", name: "山本淳嗣",      short: "山本"   },
  { id: "1493138615369339005", name: "江原功平",      short: "江原"   },
  { id: "1492061651644448958", name: "緑川果琳",      short: "緑川"   },
  { id: "1493169883565916180", name: "石沢",          short: "石沢"   },
];

// ─── State (重複通知防止) ─────────────────────────────────
interface TaskState {
  lastScanDate: string;   // YYYY-MM-DD
  notifiedTaskIds: string[]; // 既に通知したメッセージID集合
}

async function loadState(): Promise<TaskState> {
  try {
    const content = await fs.readFile(STATE_FILE, "utf8");
    return JSON.parse(content);
  } catch {
    return { lastScanDate: "", notifiedTaskIds: [] };
  }
}

async function saveState(state: TaskState): Promise<void> {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

// ─── メッセージ収集 ────────────────────────────────────────
interface CollectedMessage {
  id: string;
  channelId: string;
  channelName: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: Date;
  mentions: string[];  // メンション先ユーザーID配列
  reactions: string[]; // リアクション絵文字配列
  replyToId: string | null;
}

async function collectMessages(
  client: Client,
  channel: ChannelConfig,
  sinceDate: Date,
): Promise<CollectedMessage[]> {
  const ch = await client.channels.fetch(channel.id);
  if (!ch || !ch.isTextBased()) {
    console.warn(`[daily-task-scan] ${channel.name}: text channel not found`);
    return [];
  }
  const textCh = ch as TextChannel;

  const collected: CollectedMessage[] = [];
  let lastId: string | undefined;
  // Discord APIは1回最大100件取得。ページング。
  while (true) {
    const batch = await textCh.messages.fetch({ limit: 100, before: lastId });
    if (batch.size === 0) break;

    for (const msg of batch.values()) {
      if (msg.createdAt < sinceDate) {
        return collected; // 収集期間超えたら終了
      }
      collected.push(toCollectedMessage(msg, channel));
    }
    lastId = batch.last()?.id;
    if (!lastId) break;
  }
  return collected;
}

function toCollectedMessage(msg: Message, channel: ChannelConfig): CollectedMessage {
  const mentions = Array.from(msg.mentions.users.keys());
  const reactions = msg.reactions.cache.map((r) => r.emoji.name || r.emoji.id || "?");
  return {
    id: msg.id,
    channelId: channel.id,
    channelName: channel.name,
    authorId: msg.author.id,
    authorName: msg.author.username,
    content: msg.content,
    timestamp: msg.createdAt,
    mentions,
    reactions,
    replyToId: msg.reference?.messageId ?? null,
  };
}

// ─── タスク抽出・判定 (TODO: 緑川ルールv2実装) ─────────────
interface ExtractedTask {
  messageId: string;
  channelId: string;
  channelName: string;
  assigneeUserId: string | null;
  assigneeShort: string;
  senderShort: string;
  content: string;
  deadline: Date | null;
  createdAt: Date;
  status: "pending" | "overdue" | "stale" | "unassigned" | "blocked";
  confidence: "L1" | "L2" | "L3";
  rule: string; // どのルールでヒットしたか
}

/**
 * TODO: 緑川さんの判定ルール草案v2確定後に本実装する。
 *
 * v1 骨組みでは以下のダミー判定を行う:
 * - 冒頭が【名前】+ <@ID> → L1-1: メンション先が担当
 * - 本文に「お願いします」「してください」含む → 依頼タスク
 */
function extractTasks(messages: CollectedMessage[]): ExtractedTask[] {
  // TODO: 判定ルールv2実装
  return [];
}

/**
 * TODO: 判定後のタスクに対して「スタック」判定を行う。
 * - 3日以上返答なし
 * - 期限超過 or 24h以内接近
 * - 未アサイン
 * - ブロッキング（先行タスク待ち）
 */
function detectStuckTasks(tasks: ExtractedTask[], _messages: CollectedMessage[]): ExtractedTask[] {
  // TODO: スタック判定実装
  return tasks;
}

// ─── 出力フォーマット (TODO: 確定) ──────────────────────────
function formatChannelNotice(tasks: ExtractedTask[]): string {
  if (tasks.length === 0) return "";
  const lines = tasks.map((t, i) => {
    const assignee = t.assigneeUserId ? `<@${t.assigneeUserId}>` : "(未アサイン)";
    return `${i + 1}. ${assignee} ${t.content.slice(0, 120)}`;
  });
  return [
    "## 🕗 スタック中タスク検出",
    ...lines,
    "",
    "期限切れ / 3日以上無反応 / 未アサイン のいずれかに該当するタスクです。",
    "対応 or 状況共有をお願いします。",
  ].join("\n");
}

function formatPersonalDM(memberName: string, tasks: ExtractedTask[]): string {
  if (tasks.length === 0) return "";
  const lines = tasks.map((t, i) => {
    return `${i + 1}. [#${t.channelName}] ${t.content.slice(0, 100)}`;
  });
  return [
    `## 📬 ${memberName}さん宛の要対応タスク`,
    ...lines,
    "",
    "対応 or「対応不可」「保留希望」を関連チャンネルで表明してください。",
  ].join("\n");
}

function formatCEODigest(byPerson: Record<string, ExtractedTask[]>): string {
  const lines: string[] = ["## 🎯 本日の判断待ち一覧", ""];
  for (const [name, tasks] of Object.entries(byPerson)) {
    lines.push(`### ${name}`);
    for (const t of tasks.slice(0, 10)) {
      lines.push(`- [#${t.channelName}] ${t.content.slice(0, 100)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function formatSummary(allTasks: ExtractedTask[]): string {
  const byChannel: Record<string, number> = {};
  for (const t of allTasks) {
    byChannel[t.channelName] = (byChannel[t.channelName] || 0) + 1;
  }
  const lines = Object.entries(byChannel)
    .sort((a, b) => b[1] - a[1])
    .map(([ch, n]) => `- ${ch}: ${n}件`);
  return [
    "## 📊 全チャンネル スタックタスク検出サマリー",
    `総検出件数: ${allTasks.length}件`,
    "",
    ...lines,
  ].join("\n");
}

// ─── 配信 ──────────────────────────────────────────────────
async function postToChannel(client: Client, channelId: string, content: string) {
  const ch = await client.channels.fetch(channelId);
  if (!ch || !("send" in ch)) return;
  await (ch as TextChannel).send(`【千葉実佑】\n${content}`);
}

async function sendDM(client: Client, userId: string, content: string) {
  const user = await client.users.fetch(userId);
  await user.send(`【千葉実佑】\n${content}`);
}

// ─── Main ────────────────────────────────────────────────
async function main() {
  console.log(`[daily-task-scan] start ${new Date().toISOString()}`);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMessageReactions,
    ],
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Discord login timeout")),
      20_000,
    );
    client.once("ready", () => {
      clearTimeout(timer);
      resolve();
    });
    client.login(DISCORD_TOKEN).catch(reject);
  });

  try {
    const sinceDate = new Date(Date.now() - LOOKBACK_DAYS * 24 * 3600 * 1000);
    console.log(`[daily-task-scan] lookback since ${sinceDate.toISOString()}`);

    // Phase 1: 全チャンネルのメッセージ収集
    const allMessages: CollectedMessage[] = [];
    for (const ch of BUSINESS_CHANNELS) {
      const msgs = await collectMessages(client, ch, sinceDate);
      console.log(`[daily-task-scan] ${ch.name}: ${msgs.length} messages`);
      allMessages.push(...msgs);
    }
    console.log(`[daily-task-scan] total ${allMessages.length} messages collected`);

    // Phase 2: タスク抽出（TODO）
    const extractedTasks = extractTasks(allMessages);
    console.log(`[daily-task-scan] ${extractedTasks.length} tasks extracted`);

    // Phase 3: スタック判定（TODO）
    const stuckTasks = detectStuckTasks(extractedTasks, allMessages);
    console.log(`[daily-task-scan] ${stuckTasks.length} stuck tasks`);

    if (stuckTasks.length === 0) {
      console.log(`[daily-task-scan] no stuck tasks — skip distribution`);
      return;
    }

    // Phase 4: 配信（現状スキップ、実装完了後に有効化）
    if (process.env.TASK_SCAN_DRY_RUN === "true") {
      console.log(`[daily-task-scan] DRY_RUN mode — not posting`);
      console.log(formatSummary(stuckTasks));
    } else {
      // TODO: 以下を実装
      // - チャンネル別に通知
      // - 各メンバーDM
      // - 岡部DM (判断待ち)
      // - #6-20_okabe-midori-chiba サマリー
      console.log(`[daily-task-scan] distribution not yet implemented`);
    }

    // State 更新
    await saveState({
      lastScanDate: todayStr(),
      notifiedTaskIds: stuckTasks.map((t) => t.messageId),
    });

    console.log(`[daily-task-scan] done`);
  } finally {
    await client.destroy();
  }
}

main().catch((e) => {
  console.error(`[daily-task-scan] fatal: ${e.message}`);
  process.exit(1);
});
