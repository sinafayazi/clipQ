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
  // The streamer's Kick tokens (chat:write), so the bot can reply in their chat.
  `
  CREATE TABLE bot_tokens (
    id             INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,  -- channel id
    access_token   TEXT NOT NULL,
    refresh_token  TEXT NOT NULL,
    expires_at     INTEGER NOT NULL,     -- ms
    rev            INTEGER NOT NULL DEFAULT 1
  );

  ${revTriggers("bot_tokens")}

  CREATE TRIGGER bot_tokens_tombstone AFTER DELETE ON bot_tokens BEGIN
    UPDATE sync_clock SET seq = seq + 1;
    INSERT INTO sync_deletes VALUES ((SELECT seq FROM sync_clock), 'bot_tokens', OLD.id);
  END;
  `,
  // Viewers logged in on the song page (to see and change their own songs). Not synced to Turso:
  // after a restart on a wiped disk they just log in again.
  `
  CREATE TABLE viewer_sessions (
    id          TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    username    TEXT NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  `,
  // Mods a streamer lets into their dashboard, and who each dashboard session belongs to (a session's
  // channel_id is the channel being controlled, which for a mod isn't their own).
  `
  ALTER TABLE sessions ADD COLUMN user_id INTEGER;   -- NULL: an older session, always the owner's
  ALTER TABLE sessions ADD COLUMN username TEXT;

  CREATE TABLE channel_editors (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    username    TEXT NOT NULL,          -- lowercase Kick username
    created_at  INTEGER NOT NULL,
    rev         INTEGER NOT NULL DEFAULT 1,
    UNIQUE (channel_id, username)
  );

  ${revTriggers("channel_editors")}

  CREATE TRIGGER channel_editors_tombstone AFTER DELETE ON channel_editors BEGIN
    UPDATE sync_clock SET seq = seq + 1;
    INSERT INTO sync_deletes VALUES ((SELECT seq FROM sync_clock), 'channel_editors', OLD.id);
  END;
  `,
  // How loud YouTube measured each song (dB), so quiet ones can be turned up.
  `
  ALTER TABLE items ADD COLUMN loudness REAL;
  `,
  // Song-page logins go to Turso too, so a wake-up on Render's wiped disk doesn't log every viewer out.
  `
  ALTER TABLE viewer_sessions ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;

  ${revTriggers("viewer_sessions")}

  CREATE TRIGGER viewer_sessions_tombstone AFTER DELETE ON viewer_sessions BEGIN
    UPDATE sync_clock SET seq = seq + 1;
    INSERT INTO sync_deletes VALUES ((SELECT seq FROM sync_clock), 'viewer_sessions', OLD.id);
  END;
  `,
  // Kick moderators, as seen by their badge in each channel's chat (Kick won't tell us otherwise).
  // They may reorder songs on the song page. Dropped when they chat again without the badge.
  `
  CREATE TABLE kick_mods (
    id          TEXT PRIMARY KEY,           -- "<channel_id>:<user_id>"
    channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL,
    username    TEXT NOT NULL,
    seen_at     INTEGER NOT NULL,
    rev         INTEGER NOT NULL DEFAULT 1
  );

  ${revTriggers("kick_mods")}

  CREATE TRIGGER kick_mods_tombstone AFTER DELETE ON kick_mods BEGIN
    UPDATE sync_clock SET seq = seq + 1;
    INSERT INTO sync_deletes VALUES ((SELECT seq FROM sync_clock), 'kick_mods', OLD.id);
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
