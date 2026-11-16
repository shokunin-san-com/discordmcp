import { Response } from "express";
import { randomUUID, randomBytes, createHash, timingSafeEqual } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidClientError,
  InvalidTokenError,
  InvalidClientMetadataError,
  InvalidRequestError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

interface AuthCodeEntry {
  client: OAuthClientInformationFull;
  codeChallenge: string;
  redirectUri: string;
  userId: string;
  resource?: URL;
  expiresAt: number;
}

interface AccessTokenEntry {
  clientId: string;
  userId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

interface RefreshTokenEntry {
  clientId: string;
  userId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// 戻り先（redirect_uri）の許可リスト（2026-11-16）
// 以前は /register で誰でも好きな戻り先を登録でき、そのリンクでシークレットを
// 入れさせると認可コードが攻撃者のサイトへ送られる作りだった。
// 許すのは Claude の公式のコールバックと、自分の PC（loopback・ポートは任意）だけ。
// 追加が要るときは MCP_OAUTH_EXTRA_REDIRECT_URIS にカンマ区切りで完全一致の URI を書く。
// ---------------------------------------------------------------------------
const ALLOWED_REDIRECT_URIS = new Set<string>([
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  ...(process.env.MCP_OAUTH_EXTRA_REDIRECT_URIS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isAllowedRedirectUri(uri: string): boolean {
  if (ALLOWED_REDIRECT_URIS.has(uri)) return true;
  try {
    const u = new URL(uri);
    // RFC 8252 §7.3：自分の PC へのループバックは http・任意のポートを許す
    return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname) && !u.username && !u.password;
  } catch {
    return false;
  }
}

// シークレットの入力の回数制限（総当たり対策）
const CONFIRM_WINDOW_MS = 15 * 60 * 1000;
const CONFIRM_MAX_FAILS_PER_IP = 5;
const CONFIRM_MAX_FAILS_TOTAL = 30;

function sha256(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

const ACCESS_TOKEN_TTL_SEC = 24 * 60 * 60; // 24 hours - re-auth頻度を下げるため
const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60; // 30 days

export interface ProviderOptions {
  userName: string;
  userSecret: string;
  publicBaseUrl: string;
  persistPath?: string; // ファイル永続化パス。未指定なら揮発的（メモリのみ）
}

export class InMemoryOAuthProvider implements OAuthServerProvider {
  private clients = new Map<string, OAuthClientInformationFull>();
  private codes = new Map<string, AuthCodeEntry>();
  private tokens = new Map<string, AccessTokenEntry>();
  private refreshTokens = new Map<string, RefreshTokenEntry>();
  private confirmFails: { ip: string; at: number }[] = [];
  private pending = new Map<
    string,
    { client: OAuthClientInformationFull; params: AuthorizationParams }
  >();

  private loadPersisted(): void {
    if (!this.opts.persistPath) return;
    if (!existsSync(this.opts.persistPath)) return;
    try {
      const raw = readFileSync(this.opts.persistPath, "utf8");
      const data = JSON.parse(raw);
      if (data.clients) this.clients = new Map(data.clients);
      if (data.tokens) this.tokens = new Map(data.tokens);
      if (data.refreshTokens) this.refreshTokens = new Map(data.refreshTokens);
      this.sweepExpired();
      console.error(
        `[oauth] loaded from ${this.opts.persistPath}: clients=${this.clients.size} access=${this.tokens.size} refresh=${this.refreshTokens.size}`
      );
    } catch (e) {
      console.error("[oauth] persist load failed:", e);
    }
  }

  private persist(): void {
    if (!this.opts.persistPath) return;
    try {
      const dir = dirname(this.opts.persistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const data = {
        clients: Array.from(this.clients.entries()),
        tokens: Array.from(this.tokens.entries()),
        refreshTokens: Array.from(this.refreshTokens.entries()),
      };
      writeFileSync(this.opts.persistPath, JSON.stringify(data), "utf8");
    } catch (e) {
      console.error("[oauth] persist save failed:", e);
    }
  }

  private issueTokenPair(
    clientId: string,
    userId: string,
    scopes: string[],
    resource?: string
  ): OAuthTokens {
    const accessToken = randomBytes(32).toString("base64url");
    const refreshToken = randomBytes(32).toString("base64url");
    const now = Date.now();
    // setTimeout による自動削除は Node の int32 制約（~24.8日）を超えると
    // 即時発火に丸められてしまうため使用しない。expiry は access 時にチェック。
    // メモリ肥大化対策として発行時に期限切れのエントリを sweep する。
    this.sweepExpired();
    this.tokens.set(accessToken, {
      clientId,
      userId,
      scopes,
      resource,
      expiresAt: now + ACCESS_TOKEN_TTL_SEC * 1000,
    });
    this.refreshTokens.set(refreshToken, {
      clientId,
      userId,
      scopes,
      resource,
      expiresAt: now + REFRESH_TOKEN_TTL_SEC * 1000,
    });
    this.persist();
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SEC,
      refresh_token: refreshToken,
    };
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.tokens) {
      if (v.expiresAt < now) this.tokens.delete(k);
    }
    for (const [k, v] of this.refreshTokens) {
      if (v.expiresAt < now) this.refreshTokens.delete(k);
    }
    for (const [k, v] of this.codes) {
      if (v.expiresAt < now) this.codes.delete(k);
    }
  }

  constructor(private opts: ProviderOptions) {
    this.loadPersisted();
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId: string) => {
        const existing = this.clients.get(clientId);
        if (existing) return existing;
        // 未知の client_id は自動で受け入れ、最低限の client_info を返す。
        // DCR状態がサーバ側で消失した場合（永続化導入直後、データ破損時等）でも
        // クライアントが再登録せずにそのまま認可フローを続行できるようにする。
        // 認可の実体はシークレット検証側で行うのでセキュリティ観点でも影響小。
        if (!clientId.startsWith("mcp-")) return undefined;
        const now = Math.floor(Date.now() / 1000);
        const synthesized: OAuthClientInformationFull = {
          client_id: clientId,
          client_id_issued_at: now,
          // 永続化前 DCR 済みの既知クライアント群をカバー:
          // - Claude.ai Web
          // - mcp-remote (loopback URIs per RFC 8252 §7.3、ポートは任意でマッチ)
          redirect_uris: [
            "https://claude.ai/api/mcp/auth_callback",
            "http://localhost/oauth/callback",
            "http://127.0.0.1/oauth/callback",
            "http://[::1]/oauth/callback",
          ],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        };
        this.clients.set(clientId, synthesized);
        this.persist();
        console.error(`[oauth] auto-accepted unknown client_id=${clientId}`);
        return synthesized;
      },
      registerClient: async (client) => {
        const uris = client.redirect_uris || [];
        const bad = uris.filter((u) => !isAllowedRedirectUri(String(u)));
        if (uris.length === 0 || bad.length > 0) {
          console.error(`[oauth] rejected client registration redirect_uris=${JSON.stringify(uris)}`);
          throw new InvalidClientMetadataError("redirect_uri is not allowed");
        }
        const clientId = `mcp-${randomUUID()}`;
        const now = Math.floor(Date.now() / 1000);
        const full: OAuthClientInformationFull = {
          ...client,
          client_id: clientId,
          client_id_issued_at: now,
        };
        this.clients.set(clientId, full);
        this.persist();
        return full;
      },
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    // 登録済みのクライアントでも、許可リスト外の戻り先には進ませない（念のための二重の確認）
    if (!isAllowedRedirectUri(params.redirectUri)) {
      console.error(`[oauth] rejected authorize redirect_uri=${params.redirectUri}`);
      throw new InvalidRequestError("redirect_uri is not allowed");
    }
    const redirectHost = (() => {
      try {
        return new URL(params.redirectUri).host;
      } catch {
        return params.redirectUri;
      }
    })();
    const sessionId = randomUUID();
    this.pending.set(sessionId, { client, params });
    setTimeout(() => this.pending.delete(sessionId), 10 * 60 * 1000);

    const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MCP 認証 (${this.opts.userName})</title>
<style>
  body { font-family: -apple-system, "Helvetica Neue", sans-serif; max-width: 420px; margin: 80px auto; padding: 0 24px; color: #1a1a1a; }
  h1 { font-size: 18px; margin: 0 0 8px; color: #8c6d1f; letter-spacing: 0.02em; }
  p.sub { font-size: 12px; color: #999; margin: 0 0 32px; }
  label { display: block; font-size: 13px; margin: 16px 0 8px; color: #555; }
  input[type=password] { width: 100%; padding: 10px 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px; box-sizing: border-box; font-family: "SF Mono", monospace; }
  button { margin-top: 20px; padding: 10px 20px; background: #1a1a1a; color: white; border: 0; border-radius: 4px; cursor: pointer; font-size: 14px; }
  button:hover { background: #333; }
  .err { background: #fdecea; color: #b02a1b; padding: 10px 12px; border-radius: 4px; font-size: 13px; margin-bottom: 16px; }
  .hint { font-size: 11px; color: #999; margin-top: 32px; line-height: 1.6; border-top: 1px solid #eee; padding-top: 16px; }
  .client { font-family: "SF Mono", monospace; color: #666; font-size: 11px; }
</style>
</head>
<body>
  <h1>Discord MCP 認証</h1>
  <p class="sub">ユーザー: <strong>${this.opts.userName}</strong> / クライアント: <span class="client">${escapeHtml(client.client_name || client.client_id)}</span></p>
  <p class="sub">認証のあとの戻り先: <strong>${escapeHtml(redirectHost)}</strong><br>Claude から自分で始めた接続のときだけ入力してください。届いたリンクから開いた画面には入力しないでください。</p>
  <form method="POST" action="${this.opts.publicBaseUrl}/authorize/confirm">
    <input type="hidden" name="session" value="${sessionId}">
    <label for="secret">アクセスシークレット</label>
    <input type="password" id="secret" name="secret" autocomplete="off" autofocus>
    <button type="submit">認証する</button>
  </form>
  <p class="hint">${this.opts.userName} さんにのみ共有された MCP アクセス用シークレットを入力してください。<br>シークレットは MCP サーバ管理者から別経路で配布されます。</p>
</body>
</html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  }

  async handleAuthorizeConfirm(
    sessionId: string,
    secret: string,
    clientIp = "unknown"
  ): Promise<{ ok: boolean; redirectUrl?: string; error?: string }> {
    const now = Date.now();
    this.confirmFails = this.confirmFails.filter((f) => now - f.at < CONFIRM_WINDOW_MS);
    const ipFails = this.confirmFails.filter((f) => f.ip === clientIp).length;
    if (ipFails >= CONFIRM_MAX_FAILS_PER_IP || this.confirmFails.length >= CONFIRM_MAX_FAILS_TOTAL) {
      console.error(`[oauth] confirm rate-limited ip=${clientIp} ipFails=${ipFails} total=${this.confirmFails.length}`);
      return { ok: false, error: "失敗が続いたため、しばらく受け付けを止めています。15分ほど待ってからやり直してください。" };
    }
    const pending = this.pending.get(sessionId);
    if (!pending) {
      return { ok: false, error: "セッションの有効期限が切れました。Claude からやり直してください。" };
    }
    // 長さや中身で比べる時間が変わらないよう、ハッシュにしてから一定時間で比べる
    if (!timingSafeEqual(sha256(secret), sha256(this.opts.userSecret))) {
      this.confirmFails.push({ ip: clientIp, at: now });
      console.error(`[oauth] confirm failed ip=${clientIp}`);
      return { ok: false, error: "シークレットが一致しません。" };
    }
    this.pending.delete(sessionId);

    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, {
      client: pending.client,
      codeChallenge: pending.params.codeChallenge,
      redirectUri: pending.params.redirectUri,
      userId: this.opts.userName,
      resource: pending.params.resource,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    setTimeout(() => this.codes.delete(code), 10 * 60 * 1000);

    const url = new URL(pending.params.redirectUri);
    url.searchParams.set("code", code);
    if (pending.params.state) url.searchParams.set("state", pending.params.state);
    return { ok: true, redirectUrl: url.toString() };
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const entry = this.codes.get(authorizationCode);
    if (!entry || entry.expiresAt < Date.now()) {
      throw new InvalidGrantError("invalid or expired code/refresh token");
    }
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string,
    _resource?: URL
  ): Promise<OAuthTokens> {
    const entry = this.codes.get(authorizationCode);
    if (!entry || entry.expiresAt < Date.now()) {
      throw new InvalidGrantError("invalid or expired code/refresh token");
    }
    if (entry.client.client_id !== client.client_id) {
      throw new InvalidClientError("client mismatch");
    }
    this.codes.delete(authorizationCode);

    return this.issueTokenPair(
      client.client_id,
      entry.userId,
      [],
      entry.resource?.toString()
    );
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    _resource?: URL
  ): Promise<OAuthTokens> {
    const entry = this.refreshTokens.get(refreshToken);
    if (!entry || entry.expiresAt < Date.now()) {
      throw new InvalidGrantError("invalid or expired code/refresh token");
    }
    // client_id は DCR で毎回変わる可能性があるので一致チェックしない。
    // 認可時のユーザー検証で十分、再発行は refresh_token 自体の有効性のみで判定。
    // Rotation: 古い refresh_token を無効化し、新しい access + refresh を発行
    this.refreshTokens.delete(refreshToken);
    return this.issueTokenPair(
      client.client_id, // 最新の client_id で再発行
      entry.userId,
      entry.scopes,
      entry.resource
    );
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const entry = this.tokens.get(token);
    if (!entry || entry.expiresAt < Date.now()) {
      throw new InvalidTokenError("invalid or expired access token");
    }
    return {
      token,
      clientId: entry.clientId,
      scopes: entry.scopes,
      expiresAt: Math.floor(entry.expiresAt / 1000),
      resource: entry.resource ? new URL(entry.resource) : undefined,
      extra: { userId: entry.userId },
    };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
