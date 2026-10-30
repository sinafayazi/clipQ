import { EventEmitter } from "node:events";
import { z } from "zod";
import {
  ACCESS_GROUPS,
  DEFAULT_SETTINGS,
  PROVIDERS,
  type AccessGroup,
  type Ban,
  type ChannelInfo,
  type ClipRef,
  type ItemStatus,
  type Provider,
  type QueueItem,
  type QueueSettings,
  type QueueState,
  type Requester,
} from "../../shared/types.js";
import type { Resolved } from "../clips/resolve.js";
import type { Db } from "../db.js";
import { RecentSet } from "../kick/chat.js";

export const settingsSchema = z.object({
  open: z.boolean(),
  maxSize: z.number().int().min(1).max(1000),
  perUserLimit: z.number().int().min(0).max(100),
  providers: z.array(z.enum(PROVIDERS)),
  autoAdvance: z.boolean(),
  access: z.record(z.enum(PROVIDERS), z.array(z.enum(ACCESS_GROUPS)).min(1)),
  voteSkip: z.number().int().min(0).max(1000),
});

export type VoteResult =
  | { status: "off" | "nothing_playing" }
  | { status: "counted" | "already_voted" | "skipped"; votes: number; needed: number; item: QueueItem };

/** Longest timeout accepted, so a typo can't become a near-permanent ban. */
export const MAX_TIMEOUT_MS = 30 * 24 * 3600 * 1000;

/** Kick badge types that count as each access group. */
const GROUP_BADGES: Record<Exclude<AccessGroup, "everyone">, string[]> = {
  subscriber: ["subscriber", "founder", "sub_gifter"],
  og: ["og"],
  vip: ["vip"],
  moderator: ["moderator"],
};

/** May a viewer with these badges post links for this platform? */
export function hasAccess(settings: QueueSettings, provider: Provider, badges: readonly string[]): boolean {
  const groups = settings.access[provider];
  if (!groups || groups.includes("everyone") || badges.includes("broadcaster")) return true;
  return groups.some((g) => g !== "everyone" && GROUP_BADGES[g].some((b) => badges.includes(b)));
}

export type RejectReason =
  | "closed"
  | "provider_disabled"
  | "not_allowed"
  | "banned"
  | "full"
  | "user_limit"
  | "duplicate"
  | "not_found"
  | "unplayable"
  | "moderated";

/** The sender of a link, as far as the rules care. */
interface Viewer {
  id: number;
  username: string;
  badges: readonly string[];
}

/** Kick usernames are case-insensitive; people also type them with an @. */
export function normalizeName(username: string): string {
  return username.trim().replace(/^@/, "").toLowerCase();
}

export type SubmitResult ={ ok: true; item: QueueItem } | { ok: false; reason: RejectReason };

const QUEUE = "clips";const HISTORY_LIMIT = 50;
/** A ban this recent also drops that user's links that are still being looked up. */
const BAN_WINDOW_MS = 60_000;

interface ItemRow {
  id: number;
  channel_id: number;
  provider: Provider;
  clip_id: string;
  url: string;
  start: number | null;
  title: string | null;
  thumbnail: string | null;
  author: string | null;
  duration: number | null;
  media_url: string | null;
  requester_id: number;
  requester_name: string;
  requester_color: string | null;
  message_id: string | null;
  status: ItemStatus;
  position: number;
  created_at: number;
  finished_at: number | null;
}

interface ChannelRow {
  id: number;
  slug: string;
  display_name: string;
  chatroom_id: number | null;
  owner_id: number;
  settings: string;
  opened_at: number;
}

/**
 * Owns every queue. All state lives in SQLite and every mutation is a synchronous transaction, so two
 * chat messages or two dashboard clicks can never interleave halfway through a change.
 */
export class QueueService extends EventEmitter<{ changed: [channelId: number] }> {
  private deletedMessages = new RecentSet(5000);
  private recentBans = new Map<string, number>();
  private lastTicket = new Map<number, number>();
  /** Per channel: who voted to skip which clip. Votes for any other clip are stale. */
  private votes = new Map<number, { itemId: number; voters: Set<number> }>();

  constructor(
    private readonly db: Db,
    private readonly resolve: (ref: ClipRef) => Promise<Resolved>,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  // ---- channels -------------------------------------------------------------------------------

  upsertChannel(info: ChannelInfo, ownerId: number) {
    this.db
      .prepare(
        `INSERT INTO channels (id, slug, display_name, chatroom_id, owner_id, created_at)
         VALUES (@id, @slug, @displayName, @chatroomId, @ownerId, @now)
         ON CONFLICT (id) DO UPDATE SET
           slug = excluded.slug,
           display_name = excluded.display_name,
           chatroom_id = COALESCE(excluded.chatroom_id, channels.chatroom_id),
           owner_id = excluded.owner_id`,
      )
      .run({ ...info, ownerId, now: this.now() });
    this.changed(info.id);
  }

  setChatroom(channelId: number, chatroomId: number) {
    this.db.prepare(`UPDATE channels SET chatroom_id = ? WHERE id = ?`).run(chatroomId, channelId);
    this.changed(channelId);
  }

  channel(channelId: number): ChannelInfo | null {
    const row = this.channelRow(channelId);
    return row ? toChannel(row) : null;
  }

  channelByChatroom(chatroomId: number): ChannelInfo | null {
    const row = this.db.prepare(`SELECT * FROM channels WHERE chatroom_id = ?`).get(chatroomId) as ChannelRow | undefined;
    return row ? toChannel(row) : null;
  }

  channels(): ChannelInfo[] {
    return (this.db.prepare(`SELECT * FROM channels`).all() as ChannelRow[]).map(toChannel);
  }

  settings(channelId: number): QueueSettings {
    const row = this.channelRow(channelId);
    if (!row) throw new Error(`unknown channel ${channelId}`);
    return readSettings(row.settings);
  }

  updateSettings(channelId: number, patch: Partial<QueueSettings>): QueueSettings {
    return this.tx(channelId, () => {
      const before = this.settings(channelId);
      const next = settingsSchema.parse({ ...before, ...patch });
      this.db.prepare(`UPDATE channels SET settings = ? WHERE id = ?`).run(JSON.stringify(next), channelId);
      return next;
    });
  }

  state(channelId: number, chatConnected: boolean): QueueState {
    const row = this.channelRow(channelId);
    if (!row) throw new Error(`unknown channel ${channelId}`);
    const rows = (status: string, order: string, limit = -1) =>
      (
        this.db
          .prepare(`SELECT * FROM items WHERE channel_id = ? AND queue = ? AND status IN (${status}) ORDER BY ${order} LIMIT ?`)
          .all(channelId, QUEUE, limit) as ItemRow[]
      ).map(toItem);

    const current = rows(`'playing'`, "id DESC", 1)[0] ?? null;
    return {
      channel: toChannel(row),
      settings: readSettings(row.settings),
      chatConnected,
      current,
      queue: rows(`'queued'`, "position, id"),
      history: rows(`'played','skipped'`, "finished_at DESC, id DESC", HISTORY_LIMIT),
      bans: this.bans(channelId),
      skipVotes: current ? this.voteCount(channelId, current.id) : 0,
      botLinked: this.db.prepare(`SELECT 1 FROM bot_tokens WHERE id = ?`).get(channelId) !== undefined,
    };
  }

  // ---- vote skip ------------------------------------------------------------------------------

  /** A viewer votes to skip the playing clip; enough votes skip it. One vote per viewer per clip. */
  voteSkip(channelId: number, userId: number): VoteResult {
    return this.tx(channelId, () => {
      const needed = this.settings(channelId).voteSkip;
      if (needed === 0) return { status: "off" } as const;
      const id = this.currentId(channelId);
      const item = id === null ? null : this.item(channelId, id);
      if (!item) return { status: "nothing_playing" } as const;

      let v = this.votes.get(channelId);
      if (!v || v.itemId !== item.id) this.votes.set(channelId, (v = { itemId: item.id, voters: new Set() }));
      if (v.voters.has(userId)) return { status: "already_voted", votes: v.voters.size, needed, item } as const;
      v.voters.add(userId);
      const votes = v.voters.size;
      if (votes < needed) return { status: "counted", votes, needed, item } as const;
      this.votes.delete(channelId);
      this.next(channelId, "skipped");
      return { status: "skipped", votes, needed, item } as const;
    });
  }

  private voteCount(channelId: number, itemId: number): number {
    const v = this.votes.get(channelId);
    return v && v.itemId === itemId ? v.voters.size : 0;
  }

  // ---- submissions ----------------------------------------------------------------------------

  /** Rules that don't need the network. Run before the lookup to save requests, and again after. */
  check(channelId: number, ref: Pick<ClipRef, "provider" | "id">, who: Viewer): RejectReason | null {
    const early = this.checkOpen(channelId, ref.provider, who);
    if (early) return early;
    const row = this.channelRow(channelId)!;
    const s = readSettings(row.settings);
    const requesterId = who.id;

    const count = (sql: string, ...args: unknown[]) =>
      (this.db.prepare(`SELECT COUNT(*) AS n FROM items WHERE channel_id = ? AND queue = ? AND ${sql}`).get(channelId, QUEUE, ...args) as { n: number }).n;

    if (count(`provider = ? AND clip_id = ? AND status IN ('queued','playing')`, ref.provider, ref.id) > 0) return "duplicate";
    if (count(`status = 'queued'`) >= s.maxSize) return "full";
    if (s.perUserLimit > 0 && count(`status = 'queued' AND requester_id = ?`, requesterId) >= s.perUserLimit) return "user_limit";
    return null;
  }

  /** `badges` are the sender's Kick badge types (for per-platform access); they aren't stored. */
  async submit(
    channelId: number,
    ref: ClipRef,
    requester: Requester,
    messageId: string | null,
    badges: readonly string[] = [],
  ): Promise<SubmitResult> {
    const who: Viewer = { id: requester.id, username: requester.username, badges };
    // Short links don't have their real id yet, so the duplicate rule waits for the lookup.
    const early = ref.shortLink ? this.checkOpen(channelId, ref.provider, who) : this.check(channelId, ref, who);
    if (early) return { ok: false, reason: early };

    // Take a place in line now: lookups finish in any order, but chat order decides the queue.
    const position = this.ticket(channelId);
    const resolved = await this.resolve(ref);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };

    if (messageId && this.deletedMessages.has(`${channelId}:${messageId}`)) return { ok: false, reason: "moderated" };
    if (this.recentlyBanned(channelId, requester.id)) return { ok: false, reason: "moderated" };

    return this.tx(channelId, () => {
      // Settings or the queue may have changed while we waited on the network.
      const reason = this.check(channelId, resolved.ref, who);
      if (reason) return { ok: false, reason } as const;

      const { meta } = resolved;
      const info = this.db
        .prepare(
          `INSERT INTO items (channel_id, queue, provider, clip_id, url, start, title, thumbnail, author, duration, media_url,
             requester_id, requester_name, requester_color, message_id, status, position, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        )
        .run(
          channelId, QUEUE, resolved.ref.provider, resolved.ref.id, resolved.ref.url, resolved.ref.start ?? null,
          meta.title, meta.thumbnail, meta.author, meta.duration, meta.mediaUrl,
          requester.id, requester.username, requester.color, messageId, position, this.now(),
        );
      return { ok: true, item: this.item(channelId, Number(info.lastInsertRowid))! } as const;
    });
  }

  // ---- playback controls ----------------------------------------------------------------------

  /** Finish the current clip and start the first queued one. */
  next(channelId: number, as: "played" | "skipped" = "played") {
    this.tx(channelId, () => {
      this.finishCurrent(channelId, as);
      this.startFirstQueued(channelId);
    });
  }

  /** Put the current clip back at the front of the queue and replay the last finished one. */
  previous(channelId: number) {
    this.tx(channelId, () => {
      const last = this.db
        .prepare(`SELECT id FROM items WHERE channel_id = ? AND queue = ? AND status IN ('played','skipped') ORDER BY finished_at DESC, id DESC LIMIT 1`)
        .get(channelId, QUEUE) as { id: number } | undefined;
      if (!last) return;
      const current = this.currentId(channelId);
      if (current !== null) {
        this.db.prepare(`UPDATE items SET status = 'queued', position = ? WHERE id = ?`).run(this.minPosition(channelId) - 1, current);
      }
      this.db.prepare(`UPDATE items SET status = 'playing', finished_at = NULL WHERE id = ?`).run(last.id);
    });
  }

  /** Play a specific clip now, from the queue or the history. The interrupted clip goes back on top of the queue. */
  play(channelId: number, itemId: number): boolean {
    return this.tx(channelId, () => {
      const item = this.item(channelId, itemId);
      if (!item || item.status === "removed" || item.status === "playing") return item?.status === "playing";
      const current = this.currentId(channelId);
      this.db.prepare(`UPDATE items SET status = 'playing', finished_at = NULL WHERE id = ?`).run(itemId);
      if (current !== null) {
        this.db.prepare(`UPDATE items SET status = 'queued', position = ? WHERE id = ?`).run(this.minPosition(channelId) - 1, current);
      }
      return true;
    });
  }

  remove(channelId: number, itemId: number): boolean {
    return this.tx(channelId, () => this.removeWhere(channelId, `id = ?`, itemId) > 0);
  }

  /** Move a queued clip to a 0-based index in the queue. */
  move(channelId: number, itemId: number, toIndex: number): boolean {
    return this.tx(channelId, () => {
      const ids = (
        this.db.prepare(`SELECT id FROM items WHERE channel_id = ? AND queue = ? AND status = 'queued' ORDER BY position, id`).all(channelId, QUEUE) as { id: number }[]
      ).map((r) => r.id);
      const from = ids.indexOf(itemId);
      if (from < 0) return false;
      ids.splice(from, 1);
      ids.splice(Math.max(0, Math.min(toIndex, ids.length)), 0, itemId);
      // Renumber from the current lowest position so no number grows past a pending ticket.
      const base = this.minPosition(channelId);
      const set = this.db.prepare(`UPDATE items SET position = ? WHERE id = ?`);
      ids.forEach((id, i) => set.run(base + i, id));
      return true;
    });
  }

  clear(channelId: number) {
    this.tx(channelId, () => {
      this.db.prepare(`UPDATE items SET status = 'removed', finished_at = ? WHERE channel_id = ? AND queue = ? AND status = 'queued'`).run(this.now(), channelId, QUEUE);
    });
  }

  // ---- bans (clipQ only: the viewer can still chat, their links are just ignored) --------------

  /**
   * Ban a viewer for `durationMs`, or for good when null. Re-banning replaces the old ban. Their
   * waiting and playing clips are removed.
   */
  ban(channelId: number, username: string, durationMs: number | null): Ban | null {
    const name = normalizeName(username);
    if (!name) return null;
    if (durationMs !== null && !(durationMs > 0 && durationMs <= MAX_TIMEOUT_MS)) return null;
    return this.tx(channelId, () => {
      // Remember their Kick id if they've requested before, so a later rename doesn't dodge the ban.
      const seen = this.db
        .prepare(`SELECT requester_id AS id FROM items WHERE channel_id = ? AND lower(requester_name) = ? ORDER BY id DESC LIMIT 1`)
        .get(channelId, name) as { id: number } | undefined;
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO bans (channel_id, username, user_id, until, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (channel_id, username) DO UPDATE SET
             user_id = COALESCE(excluded.user_id, bans.user_id), until = excluded.until, created_at = excluded.created_at`,
        )
        .run(channelId, name, seen?.id ?? null, durationMs === null ? null : now + durationMs, now);
      this.removeWhere(channelId, `(lower(requester_name) = ? OR requester_id = ?)`, name, seen?.id ?? -1);
      return this.bans(channelId).find((b) => b.username === name) ?? null;
    });
  }

  unban(channelId: number, username: string): boolean {
    const name = normalizeName(username);
    return this.tx(channelId, () => this.db.prepare(`DELETE FROM bans WHERE channel_id = ? AND username = ?`).run(channelId, name).changes > 0);
  }

  /** Active bans, newest first. Expired timeouts are cleaned up as a side effect. */
  bans(channelId: number): Ban[] {
    const now = this.now();
    const expired = this.db.prepare(`SELECT id FROM bans WHERE channel_id = ? AND until IS NOT NULL AND until <= ?`).all(channelId, now);
    if (expired.length) this.db.prepare(`DELETE FROM bans WHERE channel_id = ? AND until IS NOT NULL AND until <= ?`).run(channelId, now);
    return (
      this.db.prepare(`SELECT id, username, until, created_at FROM bans WHERE channel_id = ? ORDER BY created_at DESC, id DESC`).all(channelId) as {
        id: number;
        username: string;
        until: number | null;
        created_at: number;
      }[]
    ).map((b) => ({ id: b.id, username: b.username, until: b.until, createdAt: b.created_at }));
  }

  isBanned(channelId: number, username: string, userId: number | null): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM bans WHERE channel_id = ? AND (username = ? OR (user_id IS NOT NULL AND user_id = ?))
           AND (until IS NULL OR until > ?) LIMIT 1`,
      )
      .get(channelId, normalizeName(username), userId ?? -1, this.now());
    return row !== undefined;
  }

  // ---- moderation -----------------------------------------------------------------------------

  /** A moderator deleted the chat message: drop its clips, even ones still being looked up. */
  removeByMessage(channelId: number, messageId: string) {
    this.deletedMessages.add(`${channelId}:${messageId}`);
    this.tx(channelId, () => this.removeWhere(channelId, `message_id = ?`, messageId));
  }

  /** A user was banned or timed out: drop everything they have waiting. */
  removeByUser(channelId: number, userId: number) {
    const now = this.now();
    this.recentBans.set(`${channelId}:${userId}`, now);
    for (const [k, t] of this.recentBans) if (now - t > BAN_WINDOW_MS) this.recentBans.delete(k);
    this.tx(channelId, () => this.removeWhere(channelId, `requester_id = ?`, userId));
  }

  // ---- internals ------------------------------------------------------------------------------

  /** Removes matching queued/playing items. If the playing one goes, the next one starts. */
  private removeWhere(channelId: number, where: string, ...args: unknown[]): number {
    const current = this.currentId(channelId);
    const ids = (
      this.db
        .prepare(`SELECT id FROM items WHERE channel_id = ? AND queue = ? AND status IN ('queued','playing') AND ${where}`)
        .all(channelId, QUEUE, ...args) as { id: number }[]
    ).map((r) => r.id);
    if (!ids.length) return 0;
    const set = this.db.prepare(`UPDATE items SET status = 'removed', finished_at = ? WHERE id = ?`);
    for (const id of ids) set.run(this.now(), id);
    if (current !== null && ids.includes(current)) this.startFirstQueued(channelId);
    return ids.length;
  }

  private finishCurrent(channelId: number, as: ItemStatus) {
    this.db
      .prepare(`UPDATE items SET status = ?, finished_at = ? WHERE channel_id = ? AND queue = ? AND status = 'playing'`)
      .run(as, this.now(), channelId, QUEUE);
  }

  private startFirstQueued(channelId: number) {
    const first = this.db
      .prepare(`SELECT id FROM items WHERE channel_id = ? AND queue = ? AND status = 'queued' ORDER BY position, id LIMIT 1`)
      .get(channelId, QUEUE) as { id: number } | undefined;
    if (first) this.db.prepare(`UPDATE items SET status = 'playing' WHERE id = ?`).run(first.id);
  }

  private currentId(channelId: number): number | null {
    const row = this.db
      .prepare(`SELECT id FROM items WHERE channel_id = ? AND queue = ? AND status = 'playing' ORDER BY id DESC LIMIT 1`)
      .get(channelId, QUEUE) as { id: number } | undefined;
    return row?.id ?? null;
  }

  /** Next queue position, above everything queued and every ticket already handed out. */
  private ticket(channelId: number): number {
    const { m } = this.db
      .prepare(`SELECT COALESCE(MAX(position), 0) AS m FROM items WHERE channel_id = ? AND queue = ? AND status = 'queued'`)
      .get(channelId, QUEUE) as { m: number };
    const t = Math.max(m, this.lastTicket.get(channelId) ?? 0) + 1;
    this.lastTicket.set(channelId, t);
    return t;
  }

  private minPosition(channelId: number): number {
    const { m } = this.db
      .prepare(`SELECT COALESCE(MIN(position), 1) AS m FROM items WHERE channel_id = ? AND queue = ? AND status = 'queued'`)
      .get(channelId, QUEUE) as { m: number };
    return m;
  }

  private item(channelId: number, itemId: number): QueueItem | null {
    const row = this.db.prepare(`SELECT * FROM items WHERE id = ? AND channel_id = ?`).get(itemId, channelId) as ItemRow | undefined;
    return row ? toItem(row) : null;
  }

  /** Rules about the queue and the viewer, not the clip: open, platform on, viewer allowed, not banned. */
  private checkOpen(channelId: number, provider: Provider, who: Viewer): RejectReason | null {
    const row = this.channelRow(channelId);
    if (!row) return "closed";
    const s = readSettings(row.settings);
    if (!s.open) return "closed";
    if (!s.providers.includes(provider)) return "provider_disabled";
    if (this.isBanned(channelId, who.username, who.id)) return "banned";
    if (!hasAccess(s, provider, who.badges)) return "not_allowed";
    return null;
  }

  private recentlyBanned(channelId: number, userId: number) {
    const t = this.recentBans.get(`${channelId}:${userId}`);
    return t !== undefined && this.now() - t <= BAN_WINDOW_MS;
  }

  private channelRow(channelId: number) {
    return this.db.prepare(`SELECT * FROM channels WHERE id = ?`).get(channelId) as ChannelRow | undefined;
  }

  /** Run fn in a transaction and tell listeners the channel changed. */
  private tx<T>(channelId: number, fn: () => T): T {
    const result = this.db.transaction(fn)();
    this.changed(channelId);
    return result;
  }

  private changed(channelId: number) {
    this.emit("changed", channelId);
  }
}

function readSettings(json: string): QueueSettings {
  let stored: unknown = {};
  try {
    stored = JSON.parse(json);
  } catch {}
  const saved = (typeof stored === "object" && stored ? stored : {}) as Partial<QueueSettings>;
  const merged = { ...DEFAULT_SETTINGS, ...saved };
  // Settings saved before Instagram existed have no `access` field: turn Instagram on for them once.
  // After the next save, `access` is present and the streamer's choice sticks.
  if (saved.providers && !("access" in saved) && !merged.providers.includes("instagram")) {
    merged.providers = [...merged.providers, "instagram"];
  }
  const parsed = settingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : { ...DEFAULT_SETTINGS };
}

function toChannel(row: ChannelRow): ChannelInfo {
  return { id: row.id, slug: row.slug, displayName: row.display_name, chatroomId: row.chatroom_id };
}

function toItem(r: ItemRow): QueueItem {
  return {
    id: r.id,
    provider: r.provider,
    clipId: r.clip_id,
    url: r.url,
    start: r.start,
    title: r.title,
    thumbnail: r.thumbnail,
    author: r.author,
    duration: r.duration,
    mediaUrl: r.media_url,
    requestedBy: { id: r.requester_id, username: r.requester_name, color: r.requester_color },
    status: r.status,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}
