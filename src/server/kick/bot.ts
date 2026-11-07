import type { Db } from "../db.js";
import { refreshTokens, type OAuthConfig, type Tokens } from "./oauth.js";

// Replies in a streamer's chat through Kick's public API, as the bot account of the clipQ app
// (`type: "bot"`). Needs the streamer's token with chat:write, saved when they log in.
// Docs: https://docs.kick.com/apis/chat

const CHAT = "https://api.kick.com/public/v1/chat";
const BANS = "https://api.kick.com/public/v1/moderation/bans";
const CHANNELS = "https://api.kick.com/public/v1/channels";
export const MODERATION_SCOPE = "moderation:ban";
const MAX_TIMEOUT_MINUTES = 7 * 24 * 60;
/** What the bot says when the streamer's login can't time people out. */
export const NEEDS_MODERATION = "clipQ can't time people out yet: the streamer has to log in to clipQ again and allow moderation.";
const INTROSPECT = "https://id.kick.com/oauth/token/introspect";
/** Refresh a little before the token runs out. */
const REFRESH_EARLY_MS = 60_000;
const MAX_LENGTH = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  /**
   * Send a chat message, as a reply to `replyTo` (a Kick message id) when given. Never throws;
   * returns whether Kick accepted it.
   */
  async say(channelId: number, content: string, replyTo?: string): Promise<boolean> {
    return (await this.send(channelId, content, replyTo)) === null;
  }

  /** Send a chat message. Returns null when Kick accepted it, otherwise why not (for the dashboard). */
  async send(channelId: number, content: string, replyTo?: string): Promise<string | null> {
    const text = [...content].slice(0, MAX_LENGTH).join("");
    // Kick's message ids are UUIDs; anything else (dev chat) can't be replied to.
    const reply = replyTo && UUID.test(replyTo) ? replyTo : undefined;
    if (!this.linked(channelId)) {
      this.log.info(`bot: not linked to channel ${channelId}, would ${reply ? `reply to ${reply}` : "say"}: ${text}`);
      return this.oauth ? "Not linked: log out and log in again, and allow sending chat messages." : "Kick login isn't configured.";
    }
    try {
      let token = await this.token(channelId, false);
      if (!token) return "The Kick login expired: log out and log in again.";
      let res = await this.post(token, text, reply);
      if (res.status === 401) {
        token = await this.token(channelId, true);
        if (!token) return "The Kick login expired: log out and log in again.";
        res = await this.post(token, text, reply);
      }
      // The message replied to may be gone (deleted by a mod): send the answer on its own instead.
      if (reply && (res.status === 400 || res.status === 404 || res.status === 422)) {
        this.log.warn(`bot: Kick refused the reply (${res.status}), sending without it`);
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

  /** Can this channel's login time viewers out? null if unknown (not linked, Kick didn't say). */
  async canModerate(channelId: number): Promise<boolean | null> {
    if (!this.linked(channelId)) return false;
    const scopes = await this.scopes(channelId);
    return scopes === null ? null : scopes.split(/\s+/).includes(MODERATION_SCOPE);
  }

  /**
   * Time a viewer out on Kick (1 minute to 7 days), with the streamer's own login: as the broadcaster,
   * so clipQ's bot doesn't need to be a mod. Returns null when done, otherwise why not.
   */
  timeout(channelId: number, userId: number, minutes: number, reason: string): Promise<string | null> {
    const duration = Math.min(MAX_TIMEOUT_MINUTES, Math.max(1, Math.round(minutes)));
    return this.moderate(channelId, "POST", { broadcaster_user_id: channelId, user_id: userId, duration, reason: reason.slice(0, 100) });
  }

  /** Lift a viewer's timeout (or ban: callers make sure it's a timeout). Returns null when done, otherwise why not. */
  untimeout(channelId: number, userId: number): Promise<string | null> {
    return this.moderate(channelId, "DELETE", { broadcaster_user_id: channelId, user_id: userId });
  }

  /** A Kick user's id from their name, through their channel (a channel's slug is its owner's name). */
  async userId(channelId: number, username: string): Promise<number | null> {
    const slug = username.trim().replace(/^@/, "").toLowerCase().replace(/_/g, "-");
    if (!/^[a-z0-9-]{1,25}$/.test(slug)) return null;
    const token = await this.token(channelId, false).catch(() => null);
    if (!token) return null;
    try {
      const res = await fetch(`${CHANNELS}?slug=${encodeURIComponent(slug)}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: { broadcaster_user_id?: number; slug?: string }[] };
      const id = body.data?.find((c) => c.slug?.toLowerCase() === slug)?.broadcaster_user_id;
      return typeof id === "number" ? id : null;
    } catch {
      return null;
    }
  }

  private async moderate(channelId: number, method: "POST" | "DELETE", body: object): Promise<string | null> {
    if (!this.linked(channelId)) return this.oauth ? NEEDS_MODERATION : "Kick login isn't configured.";
    const call = (token: string) =>
      fetch(BANS, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    try {
      let token = await this.token(channelId, false);
      if (!token) return NEEDS_MODERATION;
      let res = await call(token);
      if (res.status === 401) {
        token = await this.token(channelId, true);
        if (!token) return NEEDS_MODERATION;
        res = await call(token);
      }
      if (res.ok) return null;
      const text = (await res.text()).slice(0, 300);
      this.log.warn(`bot: Kick refused ${method === "POST" ? "the timeout" : "the untimeout"} (${res.status}): ${text}`);
      // Usually a login from before clipQ asked for moderation.
      if ((res.status === 401 || res.status === 403) && (await this.canModerate(channelId)) === false) return NEEDS_MODERATION;
      const message = /"message"\s*:\s*"([^"]*)"/.exec(text)?.[1];
      return `Kick refused it (${res.status}${message ? `: ${message}` : ""}).`;
    } catch (err) {
      this.log.warn(`bot: moderation failed: ${String(err)}`);
      return "Couldn't reach Kick.";
    }
  }

  private post(token: string, content: string, replyTo?: string) {
    return fetch(CHAT, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ type: "bot", content, ...(replyTo ? { reply_to_message_id: replyTo } : {}) }),
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
