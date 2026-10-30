import type { Db } from "../db.js";
import { refreshTokens, type OAuthConfig, type Tokens } from "./oauth.js";

// Replies in a streamer's chat through Kick's public API, as the bot account of the clipQ app
// (`type: "bot"`). Needs the streamer's token with chat:write, saved when they log in.
// Docs: https://docs.kick.com/apis/chat

const CHAT = "https://api.kick.com/public/v1/chat";
const INTROSPECT = "https://id.kick.com/oauth/token/introspect";
/** Refresh a little before the token runs out. */
const REFRESH_EARLY_MS = 60_000;
const MAX_LENGTH = 500;

type Log = { info: (m: string) => void; warn: (m: string) => void };

interface TokenRow {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export class KickBot {
  private refreshing = new Map<number, Promise<string | null>>();

  constructor(
    private readonly db: Db,
    private readonly oauth: OAuthConfig | null,
    private readonly log: Log,
  ) {}

  saveTokens(channelId: number, t: Tokens) {
    this.db
      .prepare(
        `INSERT INTO bot_tokens (id, access_token, refresh_token, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET access_token = excluded.access_token,
           refresh_token = excluded.refresh_token, expires_at = excluded.expires_at`,
      )
      .run(channelId, t.accessToken, t.refreshToken, t.expiresAt);
  }

  /** Can clipQ post in this channel's chat? */
  linked(channelId: number): boolean {
    return this.oauth !== null && this.row(channelId) !== undefined;
  }

  /** Send a chat message. Never throws; returns whether Kick accepted it. */
  async say(channelId: number, content: string): Promise<boolean> {
    return (await this.send(channelId, content)) === null;
  }

  /** Send a chat message. Returns null when Kick accepted it, otherwise why not (for the dashboard). */
  async send(channelId: number, content: string): Promise<string | null> {
    const text = [...content].slice(0, MAX_LENGTH).join("");
    if (!this.linked(channelId)) {
      this.log.info(`bot: not linked to channel ${channelId}, would say: ${text}`);
      return this.oauth ? "Not linked: log out and log in again, and allow sending chat messages." : "Kick login isn't configured.";
    }
    try {
      let token = await this.token(channelId, false);
      if (!token) return "The Kick login expired: log out and log in again.";
      let res = await this.post(token, text);
      if (res.status === 401) {
        token = await this.token(channelId, true);
        if (!token) return "The Kick login expired: log out and log in again.";
        res = await this.post(token, text);
      }
      const body = (await res.text()).slice(0, 300);
      if (!res.ok) {
        this.log.warn(`bot: Kick refused the message (${res.status}): ${body}`);
        return `Kick refused the message (${res.status}): ${body || res.statusText}`;
      }
      // 200 can still mean "not sent".
      if (/"is_sent"\s*:\s*false/.test(body)) {
        this.log.warn(`bot: Kick didn't send the message: ${body}`);
        return `Kick didn't send the message: ${body}`;
      }
      return null;
    } catch (err) {
      this.log.warn(`bot: sending failed: ${String(err)}`);
      return `Sending failed: ${String(err)}`;
    }
  }

  /** The scopes Kick actually granted this channel's token (null if unknown). */
  async scopes(channelId: number): Promise<string | null> {
    const token = await this.token(channelId, false).catch(() => null);
    if (!token) return null;
    try {
      const res = await fetch(INTROSPECT, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json()) as { data?: { scope?: string } };
      return body.data?.scope ?? null;
    } catch {
      return null;
    }
  }

  private post(token: string, content: string) {
    return fetch(CHAT, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ type: "bot", content }),
      signal: AbortSignal.timeout(10_000),
    });
  }

  /** A usable access token, refreshed when it's (nearly) expired or `force`d. One refresh at a time. */
  private async token(channelId: number, force: boolean): Promise<string | null> {
    const row = this.row(channelId);
    if (!row || !this.oauth) return null;
    if (!force && row.expires_at - REFRESH_EARLY_MS > Date.now()) return row.access_token;

    let pending = this.refreshing.get(channelId);
    if (!pending) {
      const oauth = this.oauth;
      pending = refreshTokens(oauth, row.refresh_token)
        .then((t) => {
          this.saveTokens(channelId, t);
          return t.accessToken;
        })
        .catch((err) => {
          // Usually a revoked or expired refresh token: the streamer has to log in again.
          this.log.warn(`bot: token refresh failed for channel ${channelId}: ${String(err)}`);
          if (/\b(400|401)\b/.test(String(err))) this.db.prepare(`DELETE FROM bot_tokens WHERE id = ?`).run(channelId);
          return null;
        })
        .finally(() => this.refreshing.delete(channelId));
      this.refreshing.set(channelId, pending);
    }
    return pending;
  }

  private row(channelId: number) {
    return this.db.prepare(`SELECT access_token, refresh_token, expires_at FROM bot_tokens WHERE id = ?`).get(channelId) as
      | TokenRow
      | undefined;
  }
}
