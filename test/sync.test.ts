import { createClient, type Client } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClipRef } from "../src/shared/types.js";
import type { Resolved } from "../src/server/clips/resolve.js";
import { openDb, type Db } from "../src/server/db.js";
import { KickBot } from "../src/server/kick/bot.js";
import { QueueService } from "../src/server/queue/service.js";
import { TursoSync } from "../src/server/sync.js";

// A real libsql database file stands in for Turso: same client, same SQL.

const quiet = { info: () => {}, warn: () => {} };
const resolver = async (ref: ClipRef): Promise<Resolved> => ({
  ok: true,
  ref,
  meta: { title: `title ${ref.id}`, thumbnail: null, author: null, duration: 30, mediaUrl: null },
});
const yt = (id: string): ClipRef => ({ provider: "youtube", id: id.padEnd(11, "x"), url: `https://youtu.be/${id}` });
const alice = { id: 1, username: "alice", color: "#fff" };

let dir: string;
let remote: Client;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clipq-sync-"));
  remote = createClient({ url: `file:${join(dir, "remote.db")}` });
});

afterEach(() => {
  remote.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A fresh "instance": empty local disk, restored from the remote. */
async function boot() {
  const db = openDb(":memory:");
  const sync = new TursoSync(db, remote, quiet);
  await sync.init();
  const queues = new QueueService(db, resolver);
  return { db, sync, queues };
}

function sessionIds(db: Db) {
  return (db.prepare(`SELECT id FROM sessions ORDER BY id`).all() as { id: string }[]).map((r) => r.id);
}

describe("TursoSync", () => {
  it("restores the full queue state on a new instance", async () => {
    const a = await boot();
    a.queues.upsertChannel({ id: 100, slug: "erph", displayName: "Erph", chatroomId: 555 }, 100);
    a.queues.updateSettings(100, { open: true, perUserLimit: 0, maxSize: 42 });
    await a.queues.submit(100, yt("a"), alice, "m1");
    await a.queues.submit(100, yt("b"), alice, "m2");
    await a.queues.submit(100, yt("c"), alice, "m3");
    a.queues.next(100); // a playing
    a.queues.next(100, "skipped"); // a played, b playing
    a.db.prepare(`INSERT INTO sessions (id, channel_id, expires_at) VALUES ('s1', 100, 9e12)`).run();
    await a.sync.flush();
    const before = a.queues.state(100, true);

    const b = await boot();
    const after = b.queues.state(100, true);
    expect(after).toEqual(before);
    expect(after.settings.maxSize).toBe(42);
    expect(after.current?.clipId).toMatch(/^b/);
    expect(after.queue.map((i) => i.clipId[0])).toEqual(["c"]);
    expect(after.history[0]?.status).toBe("skipped");
    expect(sessionIds(b.db)).toEqual(["s1"]);
  });

  it("pushes only what changed, including updates to existing rows", async () => {
    const a = await boot();
    a.queues.upsertChannel({ id: 100, slug: "erph", displayName: "Erph", chatroomId: 555 }, 100);
    a.queues.updateSettings(100, { open: true });
    await a.queues.submit(100, yt("a"), alice, "m1");
    await a.sync.flush();
    expect(a.sync.pending()).toBe(false);

    a.queues.next(100);
    expect(a.sync.pending()).toBe(true);
    await a.sync.flush();
    const row = await remote.execute(`SELECT status FROM items`);
    expect(row.rows[0]?.status).toBe("playing");
  });

  it("propagates logouts (deleted sessions)", async () => {
    const a = await boot();
    a.queues.upsertChannel({ id: 100, slug: "erph", displayName: "Erph", chatroomId: 555 }, 100);
    a.db.prepare(`INSERT INTO sessions (id, channel_id, expires_at) VALUES ('s1', 100, 9e12), ('s2', 100, 9e12)`).run();
    await a.sync.flush();
    a.db.prepare(`DELETE FROM sessions WHERE id = 's1'`).run();
    await a.sync.flush();

    const b = await boot();
    expect(sessionIds(b.db)).toEqual(["s2"]);
  });

  it("new instances never reuse item ids", async () => {
    const a = await boot();
    a.queues.upsertChannel({ id: 100, slug: "erph", displayName: "Erph", chatroomId: 555 }, 100);
    a.queues.updateSettings(100, { open: true });
    const first = await a.queues.submit(100, yt("a"), alice, "m1");
    await a.sync.flush();

    const b = await boot();
    const second = await b.queues.submit(100, yt("b"), { ...alice, id: 2 }, "m2");
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.item.id).toBeGreaterThan(first.item.id + 1000);
  });

  it("changes made while a push is in flight go out in the next push", async () => {
    const a = await boot();
    a.queues.upsertChannel({ id: 100, slug: "erph", displayName: "Erph", chatroomId: 555 }, 100);
    a.queues.updateSettings(100, { open: true, perUserLimit: 0 });
    await a.queues.submit(100, yt("a"), alice, "m1");
    const flushing = a.sync.flush();
    await a.queues.submit(100, yt("b"), alice, "m2"); // lands while the first push is awaiting the remote
    await flushing;
    await a.sync.flush();
    expect(a.sync.pending()).toBe(false);
    const n = await remote.execute(`SELECT COUNT(*) AS n FROM items`);
    expect(Number(n.rows[0]?.n)).toBe(2);
  });

  it("keeps changes pending when the remote fails, and pushes them once it's back", async () => {
    const a = await boot();
    a.queues.upsertChannel({ id: 100, slug: "erph", displayName: "Erph", chatroomId: 555 }, 100);
    await a.sync.flush();

    const realBatch = remote.batch.bind(remote);
    remote.batch = (async () => {
      throw new Error("network down");
    }) as typeof remote.batch;
    a.queues.updateSettings(100, { open: true });
    await a.sync.flush();
    expect(a.sync.pending()).toBe(true);

    remote.batch = realBatch;
    await a.sync.flush();
    expect(a.sync.pending()).toBe(false);
    const b = await boot();
    expect(b.queues.settings(100).open).toBe(true);
  });

  it("bans and unbans survive a restart", async () => {
    const a = await boot();
    a.queues.upsertChannel({ id: 100, slug: "erph", displayName: "Erph", chatroomId: 555 }, 100);
    a.queues.ban(100, "alice", null);
    a.queues.ban(100, "bob", 3_600_000);
    await a.sync.flush();
    a.queues.unban(100, "bob");
    await a.sync.flush();

    const b = await boot();
    expect(b.queues.state(100, true).bans.map((x) => [x.username, x.until])).toEqual([["alice", null]]);
    expect(b.queues.isBanned(100, "alice", null)).toBe(true);
  });

  it("the bot's chat tokens survive a restart, and dropping them does too", async () => {
    const oauth = { clientId: "c", clientSecret: "s", redirectUri: "http://x/auth/callback" };
    const a = await boot();
    a.queues.upsertChannel({ id: 100, slug: "erph", displayName: "Erph", chatroomId: 555 }, 100);
    a.queues.upsertChannel({ id: 200, slug: "other", displayName: "Other", chatroomId: 666 }, 200);
    const bot = new KickBot(a.db, oauth, quiet);
    bot.saveTokens(100, { accessToken: "a1", refreshToken: "r1", expiresAt: 9e12 });
    bot.saveTokens(200, { accessToken: "a2", refreshToken: "r2", expiresAt: 9e12 });
    await a.sync.flush();
    a.db.prepare(`DELETE FROM bot_tokens WHERE id = 200`).run();
    await a.sync.flush();

    const b = await boot();
    expect(new KickBot(b.db, oauth, quiet).linked(100)).toBe(true);
    expect(b.queues.state(100, true).botLinked).toBe(true);
    expect(b.queues.state(200, true).botLinked).toBe(false);
  });

  it("refuses to start when the remote is unreachable", async () => {
    const db = openDb(":memory:");
    const broken = createClient({ url: "http://127.0.0.1:9" });
    await expect(new TursoSync(db, broken, quiet).init()).rejects.toThrow();
    broken.close();
  });

  it("an existing local database is kept and fully pushed", async () => {
    const db = openDb(join(dir, "local.db"));
    const queues = new QueueService(db, resolver);
    queues.upsertChannel({ id: 100, slug: "erph", displayName: "Erph", chatroomId: 555 }, 100);
    db.close();

    // Reopen as if the app had been running before Turso was configured.
    const reopened = openDb(join(dir, "local.db"));
    const sync = new TursoSync(reopened, remote, quiet);
    await sync.init();
    await sync.flush();
    reopened.close();

    const b = await boot();
    expect(b.queues.channel(100)?.slug).toBe("erph");
  });
});

describe("schema migration", () => {
  it("marks rows that existed before change tracking so they get pushed", async () => {
    // Build a version-1 database by hand, then let openDb migrate it.
    const Database = (await import("better-sqlite3")).default;
    const path = join(dir, "old.db");
    const old = new Database(path);
    old.exec(`
      CREATE TABLE channels (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, chatroom_id INTEGER,
        owner_id INTEGER NOT NULL, settings TEXT NOT NULL DEFAULT '{}', opened_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, channel_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER NOT NULL, queue TEXT NOT NULL DEFAULT 'clips',
        provider TEXT NOT NULL, clip_id TEXT NOT NULL, url TEXT NOT NULL, start INTEGER, title TEXT, thumbnail TEXT, author TEXT,
        duration REAL, media_url TEXT, requester_id INTEGER NOT NULL, requester_name TEXT NOT NULL, requester_color TEXT,
        message_id TEXT, status TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, finished_at INTEGER);
      INSERT INTO channels (id, slug, display_name, owner_id, created_at) VALUES (7, 'old', 'Old', 7, 1);
      PRAGMA user_version = 1;
    `);
    old.close();

    const db = openDb(path);
    const sync = new TursoSync(db, remote, quiet);
    await sync.init();
    expect(sync.pending()).toBe(true);
    await sync.flush();
    db.close();
    const b = await boot();
    expect(b.queues.channel(7)?.slug).toBe("old");
  });
});
