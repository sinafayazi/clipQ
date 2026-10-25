import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import type { Db } from "./db.js";

export const SESSION_COOKIE = "clipq_session";
const TTL_MS = 30 * 24 * 3600 * 1000;

export class Sessions {
  constructor(private readonly db: Db) {
    db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(Date.now());
  }

  create(reply: FastifyReply, channelId: number) {
    const id = randomBytes(32).toString("base64url");
    const expires = Date.now() + TTL_MS;
    this.db.prepare(`INSERT INTO sessions (id, channel_id, expires_at) VALUES (?, ?, ?)`).run(id, channelId, expires);
    reply.setCookie(SESSION_COOKIE, id, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: config.secureCookies,
      expires: new Date(expires),
    });
  }

  /** Channel id for the request's session, or null. */
  channelId(req: FastifyRequest): number | null {
    const id = req.cookies[SESSION_COOKIE];
    if (!id) return null;
    const row = this.db.prepare(`SELECT channel_id, expires_at FROM sessions WHERE id = ?`).get(id) as
      | { channel_id: number; expires_at: number }
      | undefined;
    if (!row || row.expires_at < Date.now()) return null;
    return row.channel_id;
  }

  destroy(req: FastifyRequest, reply: FastifyReply) {
    const id = req.cookies[SESSION_COOKIE];
    if (id) this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
  }
}
