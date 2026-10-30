import type { Client, InStatement } from "@libsql/client";
import type { Db } from "./db.js";

// Keeps a copy of the database in Turso, for hosts without a lasting disk (Render free).
//
// The local SQLite file stays the working database: every queue change is still one synchronous
// transaction, which is what keeps the queue rules race-free. Turso only stores a copy:
//   - on boot with an empty local database, everything is restored from Turso;
//   - every second, rows changed since the last push (tracked by `rev`, see db.ts) are upserted.
// A crash can lose at most the last second of changes; a normal shutdown flushes first.

const TABLES = {
  channels: ["id", "slug", "display_name", "chatroom_id", "owner_id", "settings", "opened_at", "created_at"],
  sessions: ["id", "channel_id", "expires_at"],
  items: [
    "id", "channel_id", "queue", "provider", "clip_id", "url", "start", "title", "thumbnail", "author", "duration",
    "media_url", "requester_id", "requester_name", "requester_color", "message_id", "status", "position",
    "created_at", "finished_at",
  ],
  bans: ["id", "channel_id", "username", "user_id", "until", "created_at"],
  bot_tokens: ["id", "access_token", "refresh_token", "expires_at"],
} as const;
type Table = keyof typeof TABLES;
/** Parents first, so restored rows satisfy the local foreign keys. */
const ORDER: Table[] = ["channels", "sessions", "items", "bans", "bot_tokens"];

const REMOTE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS channels (id INTEGER PRIMARY KEY, slug TEXT, display_name TEXT, chatroom_id INTEGER,
     owner_id INTEGER, settings TEXT, opened_at INTEGER, created_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, channel_id INTEGER, expires_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, channel_id INTEGER, queue TEXT, provider TEXT, clip_id TEXT,
     url TEXT, start INTEGER, title TEXT, thumbnail TEXT, author TEXT, duration REAL, media_url TEXT, requester_id INTEGER,
     requester_name TEXT, requester_color TEXT, message_id TEXT, status TEXT, position INTEGER, created_at INTEGER,
     finished_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS bans (id INTEGER PRIMARY KEY, channel_id INTEGER, username TEXT, user_id INTEGER, until INTEGER,
     created_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS bot_tokens (id INTEGER PRIMARY KEY, access_token TEXT, refresh_token TEXT, expires_at INTEGER)`,
];

/**
 * Restored item and ban ids jump ahead by this much. While Render swaps instances during a deploy, the old
 * one can still add items for a few seconds; the gap keeps the new one from reusing their ids.
 */
const ID_GAP = 10_000;
const BATCH = 200;

type Log = { info: (m: string) => void; warn: (m: string) => void };

export class TursoSync {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private failures = 0;
  private nextTryAt = 0;

  constructor(
    private readonly db: Db,
    private readonly remote: Client,
    private readonly log: Log,
  ) {}

  /**
   * Create the Turso tables if needed and, when the local database is empty, copy everything from
   * Turso. Throws if Turso can't be reached: starting empty and pushing would overwrite good data.
   */
  async init() {
    await this.remote.batch(REMOTE_SCHEMA, "write");
    const localRows = (this.db.prepare(`SELECT COUNT(*) AS n FROM channels`).get() as { n: number }).n;
    if (localRows > 0) {
      this.log.info("turso: local database has data, keeping it and pushing changes");
      return;
    }

    const rows: Record<Table, Record<string, unknown>[]> = { channels: [], sessions: [], items: [], bans: [], bot_tokens: [] };
    for (const t of ORDER) {
      const res = await this.remote.execute(`SELECT ${TABLES[t].join(", ")} FROM ${t}`);
      rows[t] = res.rows.map((r) => Object.fromEntries(TABLES[t].map((c) => [c, r[c] ?? null])));
    }

    this.db.transaction(() => {
      for (const t of ORDER) {
        const cols = TABLES[t];
        const insert = this.db.prepare(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map((c) => "@" + c).join(", ")})`);
        for (const row of rows[t]) insert.run(row);
      }
      for (const t of ["items", "bans"] as const) {
        const maxId = rows[t].reduce((m, r) => Math.max(m, Number(r.id)), 0);
        this.db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(t);
        this.db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)`).run(t, maxId + ID_GAP);
      }
      // Everything local now matches Turso.
      this.db.prepare(`UPDATE sync_clock SET pushed = seq`).run();
      this.db.prepare(`DELETE FROM sync_deletes`).run();
    })();
    this.log.info(`turso: restored ${rows.channels.length} channels, ${rows.items.length} items, ${rows.sessions.length} sessions, ${rows.bans.length} bans`);
  }

  /** Push changes every second until stop(). */
  start(intervalMs = 1000) {
    this.timer ??= setInterval(() => void this.tick(), intervalMs);
  }

  /** Stop the timer and push whatever is left. */
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  /** Push until nothing is pending (or it keeps failing). */
  async flush() {
    for (let i = 0; i < 5 && (this.inFlight || this.pending()); i++) {
      await (this.inFlight ?? this.push());
    }
  }

  pending(): boolean {
    const c = this.clock();
    return c.seq > c.pushed;
  }

  private tick() {
    if (this.inFlight || !this.pending() || Date.now() < this.nextTryAt) return;
    void this.push();
  }

  private push(): Promise<void> {
    const run = async () => {
      // One synchronous read, so the snapshot is consistent: nothing can change between these queries.
      const { seq, pushed } = this.clock();
      const stmts: InStatement[] = [];
      for (const t of ORDER) {
        const cols = TABLES[t];
        const changed = this.db.prepare(`SELECT ${cols.join(", ")} FROM ${t} WHERE rev > ? AND rev <= ?`).all(pushed, seq) as Record<string, unknown>[];
        const sql = `INSERT OR REPLACE INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
        for (const row of changed) stmts.push({ sql, args: cols.map((c) => row[c] as never) });
      }
      const deletes = this.db.prepare(`SELECT tbl, key FROM sync_deletes WHERE rev > ? AND rev <= ?`).all(pushed, seq) as { tbl: Table; key: string }[];
      for (const d of deletes) stmts.push({ sql: `DELETE FROM ${d.tbl} WHERE id = ?`, args: [d.key] });

      try {
        for (let i = 0; i < stmts.length; i += BATCH) await this.remote.batch(stmts.slice(i, i + BATCH), "write");
      } catch (err) {
        this.failures++;
        this.nextTryAt = Date.now() + Math.min(60_000, 1000 * 2 ** this.failures);
        this.log.warn(`turso: push failed (${this.failures}x), retrying: ${String(err)}`);
        return;
      }
      this.failures = 0;
      this.nextTryAt = 0;
      this.db.prepare(`UPDATE sync_clock SET pushed = ? WHERE pushed < ?`).run(seq, seq);
      this.db.prepare(`DELETE FROM sync_deletes WHERE rev <= ?`).run(seq);
    };
    this.inFlight = run().finally(() => (this.inFlight = null));
    return this.inFlight;
  }

  private clock() {
    return this.db.prepare(`SELECT seq, pushed FROM sync_clock`).get() as { seq: number; pushed: number };
  }
}
