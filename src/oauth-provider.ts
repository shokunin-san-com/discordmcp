import { Response } from "express";
import { randomUUID, randomBytes } from "crypto";
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

const ACCESS_TOKEN_TTL_SEC = 60 * 60; // 1 hour
const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60; // 30 days

export interface ProviderOptions {
  userName: string;
  userSecret: string;
  publicBaseUrl: string;
}

export class InMemoryOAuthProvider implements OAuthServerProvider {
  private clients = new Map<string, OAuthClientInformationFull>();
  private codes = new Map<string, AuthCodeEntry>();
  private tokens = new Map<string, AccessTokenEntry>();
  private refreshTokens = new Map<string, RefreshTokenEntry>();
  private pending = new Map<
    string,
    { client: OAuthClientInformationFull; params: AuthorizationParams }
  >();

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

  constructor(private opts: ProviderOptions) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId: string) => this.clients.get(clientId),
      registerClient: async (client) => {
        const clientId = `mcp-${randomUUID()}`;
        const now = Math.floor(Date.now() / 1000);
        const full: OAuthClientInformationFull = {
          ...client,
          client_id: clientId,
          client_id_issued_at: now,
        };
        this.clients.set(clientId, full);
        return full;
      },
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
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
    secret: string
  ): Promise<{ ok: boolean; redirectUrl?: string; error?: string }> {
    const pending = this.pending.get(sessionId);
    if (!pending) {
      return { ok: false, error: "セッションの有効期限が切れました。Claude からやり直してください。" };
    }
    if (secret !== this.opts.userSecret) {
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
    if (entry.clientId !== client.client_id) {
      throw new InvalidClientError("client mismatch");
    }
    // Rotation: 古い refresh_token を無効化し、新しい access + refresh を発行
    this.refreshTokens.delete(refreshToken);
    return this.issueTokenPair(
      entry.clientId,
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
