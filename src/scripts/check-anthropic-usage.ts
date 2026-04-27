/**
 * Anthropic API 使用量監視スクリプト
 *
 * ⚠️ 現在このスクリプトは **未稼働（保留中）** です。
 *
 * 【保留理由】
 * Anthropic Admin API は Team / Enterprise プランの組織でのみ Admin API Key を発行可能。
 * 現在は Individual Organization のため Admin Key が発行できず、本スクリプトの稼働条件を満たせない。
 * 当面は https://console.anthropic.com/settings/cost をブラウザで手動確認する運用で凌ぐ。
 *
 * 【再開条件】
 * - Team プランへのアップグレード（月額 +$25〜/メンバー）
 * - Anthropic Console で Admin Key を発行し、VPS の .env に ANTHROPIC_ADMIN_API_KEY を追加
 * - PM2 で reload するだけで本スクリプトが稼働開始する
 *
 * 【仕様】
 * 毎日決まった時刻に Anthropic Admin API から今月の累計コストを取得し、
 * 閾値（デフォルト $80）を超えた場合に Discord の #5-10_executive チャンネルへ
 * 白電伝虫から通知を投稿する。PM2 cron から実行される前提で、単発で走って終了。
 *
 * 【必要な環境変数】
 *   DISCORD_TOKEN                     Discord Bot のトークン（白電伝虫）
 *   ANTHROPIC_ADMIN_API_KEY           Anthropic Console で発行する Admin API Key
 *   API_USAGE_THRESHOLD_USD           通知する閾値（デフォルト 80）
 *   API_USAGE_LIMIT_USD               ブロックが発生する上限（デフォルト 100）
 *   EXECUTIVE_CHANNEL_ID              通知先チャンネルID（デフォルト #5-10_executive = 1491962675968606230）
 *   SENDER_NAME                       メッセージ冒頭に付ける名前（デフォルト 千葉実佑）
 *   API_USAGE_STATE_FILE              重複通知防止のstateファイル（デフォルト .api-usage-state.json）
 */

import dotenv from "dotenv";
import { Client, GatewayIntentBits, TextChannel } from "discord.js";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Config ──────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ANTHROPIC_ADMIN_API_KEY = process.env.ANTHROPIC_ADMIN_API_KEY;
const USAGE_THRESHOLD = parseFloat(process.env.API_USAGE_THRESHOLD_USD || "80");
const USAGE_LIMIT = parseFloat(process.env.API_USAGE_LIMIT_USD || "100");
const EXECUTIVE_CHANNEL_ID = process.env.EXECUTIVE_CHANNEL_ID || "1491962675968606230";
const SENDER_NAME = process.env.SENDER_NAME || "千葉実佑";
const STATE_FILE = process.env.API_USAGE_STATE_FILE ||
  path.join(__dirname, "..", "..", ".api-usage-state.json");

if (!DISCORD_TOKEN) {
  console.error("[check-anthropic-usage] DISCORD_TOKEN is not set");
  process.exit(1);
}
if (!ANTHROPIC_ADMIN_API_KEY) {
  console.error("[check-anthropic-usage] ANTHROPIC_ADMIN_API_KEY is not set — 使用量取得をスキップ");
  process.exit(0);
}

// ─── State (重複通知防止) ─────────────────────────────────
interface UsageState {
  lastNotificationDate: string; // YYYY-MM-DD
  lastNotifiedBucketUsd: number; // 5ドル刻みで直近通知済のバケット
}

async function loadState(): Promise<UsageState> {
  try {
    const content = await fs.readFile(STATE_FILE, "utf8");
    return JSON.parse(content);
  } catch {
    return { lastNotificationDate: "", lastNotifiedBucketUsd: 0 };
  }
}

async function saveState(state: UsageState): Promise<void> {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

// ─── Anthropic Admin API ─────────────────────────────────
async function fetchMonthlyCostUsd(): Promise<number> {
  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const startingAt = startOfMonth.toISOString();

  const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
  url.searchParams.set("starting_at", startingAt);
  url.searchParams.set("limit", "31");

  const res = await fetch(url.toString(), {
    headers: {
      "x-api-key": ANTHROPIC_ADMIN_API_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic cost_report API ${res.status}: ${body.slice(0, 300)}`);
  }

  const json: any = await res.json();
  // レスポンス構造: { data: [{ starting_at, ending_at, results: [{ amount, currency, ... }] }] }
  let totalUsd = 0;
  const days = Array.isArray(json?.data) ? json.data : [];
  for (const day of days) {
    const results = Array.isArray(day?.results) ? day.results : [];
    for (const r of results) {
      const amt = Number(r?.amount ?? 0);
      const cur = (r?.currency ?? "USD").toUpperCase();
      if (cur === "USD" && Number.isFinite(amt)) totalUsd += amt;
    }
  }
  return totalUsd;
}

// ─── Message formatter ───────────────────────────────────
function formatAlert(currentUsd: number): string {
  const now = new Date();
  const day = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const projected = day > 0 ? (currentUsd / day) * daysInMonth : currentUsd;
  const ratio = USAGE_LIMIT > 0 ? (currentUsd / USAGE_LIMIT) * 100 : 0;

  const over = currentUsd >= USAGE_LIMIT;
  const header = over
    ? "🛑 **Anthropic API 上限到達 — 送信ブロック発生中**"
    : "⚠️ **Anthropic API 使用量アラート**";

  return `【${SENDER_NAME}】${header}

## 📊 今月の使用状況
- 現在: **$${currentUsd.toFixed(2)}** (${ratio.toFixed(0)}%)
- 閾値: $${USAGE_THRESHOLD.toFixed(0)}
- 上限: $${USAGE_LIMIT.toFixed(0)}${over ? " ← **到達済み**" : ""}
- 月末予測: **$${projected.toFixed(2)}**（現ペース維持時）

## 🔧 推奨アクション
- Anthropic Console で上限引き上げ検討: https://console.anthropic.com/settings/limits
- 長時間セッションのリセット / Prompt Cache 利用状況の確認
- 不要なエージェント・cron ジョブの一時停止

> 次回チェック: 本日 21:00（PM2 cron 実行）`;
}

// ─── Discord送信 ──────────────────────────────────────────
async function postToExecutive(text: string): Promise<void> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
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
    const channel = await client.channels.fetch(EXECUTIVE_CHANNEL_ID);
    if (!channel || !("send" in channel)) {
      throw new Error(`Channel ${EXECUTIVE_CHANNEL_ID} is not a text channel`);
    }
    await (channel as TextChannel).send(text);
    console.log(`[check-anthropic-usage] Posted to #5-10_executive (${EXECUTIVE_CHANNEL_ID})`);
  } finally {
    await client.destroy();
  }
}

// ─── Main ────────────────────────────────────────────────
async function main() {
  const startedAt = new Date();
  console.log(`[check-anthropic-usage] start ${startedAt.toISOString()}`);

  let currentUsd = 0;
  try {
    currentUsd = await fetchMonthlyCostUsd();
  } catch (e: any) {
    console.error(`[check-anthropic-usage] Failed to fetch usage: ${e.message}`);
    process.exit(1);
  }
  console.log(`[check-anthropic-usage] current cost = $${currentUsd.toFixed(2)}`);

  if (currentUsd < USAGE_THRESHOLD) {
    console.log(`[check-anthropic-usage] below threshold ($${USAGE_THRESHOLD}) — no alert`);
    process.exit(0);
  }

  // 重複通知防止: 同日かつ直近通知バケット（$5刻み）以下なら送らない
  const state = await loadState();
  const today = todayStr();
  const currentBucket = Math.floor(currentUsd / 5) * 5;

  if (state.lastNotificationDate === today && currentBucket <= state.lastNotifiedBucketUsd) {
    console.log(
      `[check-anthropic-usage] already notified today at bucket $${state.lastNotifiedBucketUsd} (current $${currentBucket}) — skip`,
    );
    process.exit(0);
  }

  const message = formatAlert(currentUsd);
  try {
    await postToExecutive(message);
  } catch (e: any) {
    console.error(`[check-anthropic-usage] Discord post failed: ${e.message}`);
    process.exit(1);
  }

  await saveState({
    lastNotificationDate: today,
    lastNotifiedBucketUsd: currentBucket,
  });

  console.log(`[check-anthropic-usage] done`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`[check-anthropic-usage] fatal: ${e.message}`);
  process.exit(1);
});
