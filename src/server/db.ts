import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

// Append-only. Each entry runs once, in order, tracked by PRAGMA user_version.
const MIGRATIONS = [
  `
  CREATE TABLE channels (
    id            INTEGER PRIMARY KEY,           -- Kick channel id
    slug          TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    chatroom_id   INTEGER,
    owner_id      INTEGER NOT NULL,              -- Kick user id of the broadcaster
    settings      TEXT NOT NULL DEFAULT '{}',
    opened_at     INTEGER NOT NULL DEFAULT 0,    -- last time the queue was opened; scopes "no repeats"
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,
    channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    expires_at  INTEGER NOT NULL
  );

  -- One row per request. "queue" separates clip requests from future queues (song requests).
  CREATE TABLE items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id      INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    queue           TEXT NOT NULL DEFAULT 'clips',
    provider        TEXT NOT NULL,
    clip_id         TEXT NOT NULL,
    url             TEXT NOT NULL,
    start           INTEGER,
    title           TEXT,
    thumbnail       TEXT,
    author          TEXT,
    duration        REAL,
    media_url       TEXT,
    requester_id    INTEGER NOT NULL,
    requester_name  TEXT NOT NULL,
    requester_color TEXT,
    message_id      TEXT,
    status          TEXT NOT NULL,
    position        INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    finished_at     INTEGER
  );
  CREATE INDEX items_by_status ON items (channel_id, queue, status, position);
  CREATE INDEX items_by_clip ON items (channel_id, queue, provider, clip_id);
  CREATE INDEX items_by_message ON items (channel_id, message_id);
  `,
  // Change tracking for the Turso copy (see sync.ts). Every insert/update stamps the row with the
  // next number from sync_clock; deleted sessions leave a tombstone. Existing rows start at 1 so
  // they are pushed once.
  `
  ALTER TABLE channels ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE sessions ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE items ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;

  CREATE TABLE sync_clock (
    id      INTEGER PRIMARY KEY CHECK (id = 1),
    seq     INTEGER NOT NULL,   -- last rev handed out
    pushed  INTEGER NOT NULL    -- every rev up to this is in Turso
  );
  INSERT INTO sync_clock VALUES (1, 1, 0);

  CREATE TABLE sync_deletes (rev INTEGER NOT NULL, tbl TEXT NOT NULL, key TEXT NOT NULL);

  ${revTriggers("channels")}
  ${revTriggers("sessions")}
  ${revTriggers("items")}

  CREATE TRIGGER sessions_tombstone AFTER DELETE ON sessions BEGIN
    UPDATE sync_clock SET seq = seq + 1;
    INSERT INTO sync_deletes VALUES ((SELECT seq FROM sync_clock), 'sessions', OLD.id);
  END;
  `,
  // Per-channel bans and timeouts (clipQ only; nothing is sent to Kick).
  `
  CREATE TABLE bans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    username    TEXT NOT NULL,          -- lowercase
    user_id     INTEGER,                -- Kick user id, when we've seen it
    until       INTEGER,                -- ms; NULL = permanent
    created_at  INTEGER NOT NULL,
    rev         INTEGER NOT NULL DEFAULT 1,
    UNIQUE (channel_id, username)
  );

  ${revTriggers("bans")}

  CREATE TRIGGER bans_tombstone AFTER DELETE ON bans BEGIN
    UPDATE sync_clock SET seq = seq + 1;
    INSERT INTO sync_deletes VALUES ((SELECT seq FROM sync_clock), 'bans', OLD.id);
  END;
  `,
];

function revTriggers(table: string) {
  const stamp = `UPDATE sync_clock SET seq = seq + 1; UPDATE ${table} SET rev = (SELECT seq FROM sync_clock) WHERE rowid = NEW.rowid;`;
  return `
  CREATE TRIGGER ${table}_rev_ins AFTER INSERT ON ${table} BEGIN ${stamp} END;
  CREATE TRIGGER ${table}_rev_upd AFTER UPDATE ON ${table} WHEN NEW.rev = OLD.rev BEGIN ${stamp} END;`;
}

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  const version = db.pragma("user_version", { simple: true }) as number;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]!);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
  return db;
}
