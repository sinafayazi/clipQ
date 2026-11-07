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
  type PlayerControl,
  type Provider,
  type PublicSong,
  type PublicSongs,
  type QueueItem,
  type QueueKind,
  type QueueSettings,
  type QueueState,
  type Requester,
} from "../../shared/types.js";
import type { Resolved } from "../clips/resolve.js";
import type { Db } from "../db.js";
import { RecentSet } from "../kick/chat.js";
import type { SongQuery, SongResolved, SongVideo } from "../songs/resolve.js";

export const songSettingsSchema = z.object({
  open: z.boolean(),
  maxSize: z.number().int().min(1).max(1000),
  perUserLimit: z.number().int().min(0).max(100),
  maxDuration: z.number().int().min(30).max(3 * 3600),
  voteSkip: z.number().int().min(0).max(1000),
  requestCooldown: z.number().int().min(0).max(3600),
  access: z.array(z.enum(ACCESS_GROUPS)).min(1),
  player: z.enum(["dashboard", "obs"]),
  priorityReward: z.string().trim().max(100),
});

export const settingsSchema = z.object({
  open: z.boolean(),
  maxSize: z.number().int().min(1).max(1000),
  perUserLimit: z.number().int().min(0).max(100),
  providers: z.array(z.enum(PROVIDERS)),
  autoAdvance: z.boolean(),
  access: z.record(z.enum(PROVIDERS), z.array(z.enum(ACCESS_GROUPS)).min(1)),
  voteSkip: z.number().int().min(0).max(1000),
  volume: z.number().int().min(0).max(100),
  normalize: z.boolean(),
  songs: songSettingsSchema,
});

/** How songs are looked up, and the OBS page link for a channel (it carries a secret key). */
export interface SongOptions {
  resolve: (q: SongQuery, maxDuration: number) => Promise<SongResolved>;
  obsUrl: (channelId: number) => string;
}

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
  return inGroups(settings.access[provider], badges);
}

/** Is a viewer with these badges in any of the groups? Missing or "everyone" lets anyone in. */
export function inGroups(groups: readonly AccessGroup[] | undefined, badges: readonly string[]): boolean {
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
  | "too_long"
  | "live"
  | "cooldown"
  | "moderated";

/** The sender of a link, as far as the rules care. */
interface Viewer {
  id: number;
  username: string;
  badges: readonly string[];
}

/** The channel owner (or a clipQ super user, who chats with that badge added): no limits, can't be banned. */
function isBroadcaster(who: Viewer) {
  return who.badges.includes("broadcaster");
}

/** Who is logged in to a dashboard. A null user is a session from before mods could log in: the owner. */
export interface DashboardLogin {
  userId: number | null;
  username: string | null;
}

/** Kick usernames are case-insensitive; people also type them with an @. */
export function normalizeName(username: string): string {
  return username.trim().replace(/^@/, "").toLowerCase();
}

/** `retryIn`: for "cooldown", seconds until the viewer may request again. */
export type SubmitResult = { ok: true; item: QueueItem } | { ok: false; reason: RejectReason; retryIn?: number };

const KINDS: QueueKind[] = ["clips", "songs"];
const HISTORY_LIMIT = 50;
/** A viewer's own song history on the song page. */
const MY_HISTORY_LIMIT = 30;
/** A "playing" report counts for this long; players repeat it more often than that. */
export const PLAYING_STALE_MS = 15_000;
/** Length assumed for a song with no known length, when working out wait times. */
const UNKNOWN_SONG_SECONDS = 240;
/** A ban this recent also drops that user's links that are still being looked up. */
const BAN_WINDOW_MS = 60_000;

interface ItemRow {
  id: number;
  channel_id: number;
  queue: QueueKind;
  provider: Provider;
  clip_id: string;
  url: string;
  start: number | null;
  title: string | null;
  thumbnail: string | null;
  author: string | null;
  duration: number | null;
  media_url: string | null;
  loudness: number | null;
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
  private lastTicket = new Map<string, number>();
  /** Per "channel:list": who voted to skip which item. Votes for any other item are stale. */
  private votes = new Map<string, { itemId: number; voters: Set<number> }>();
  /** When each playing item started, for "plays in about N min". In memory: lost on restart. */
  private startedAt = new Map<number, number>();
  /**
   * Per "channel:list": the item a player says is actually playing (not paused), and when it last said
   * so. Players repeat it every few seconds; a closed dashboard stops counting after PLAYING_STALE_MS.
   */
  private playing = new Map<string, { itemId: number; at: number; timer: NodeJS.Timeout }>();
  /** Per channel: the latest play/pause command for the players. */
  private controls = new Map<number, PlayerControl>();
  private controlSeq = 0;

  constructor(
    private readonly db: Db,
    private readonly resolve: (ref: ClipRef) => Promise<Resolved>,
    private readonly now: () => number = Date.now,
    private readonly songOpts: SongOptions = { resolve: async () => ({ ok: false, reason: "not_found" }), obsUrl: () => "" },
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

  channelBySlug(slug: string): ChannelInfo | null {
    const row = this.db.prepare(`SELECT * FROM channels WHERE slug = ?`).get(slug.toLowerCase()) as ChannelRow | undefined;
    return row ? toChannel(row) : null;
  }

  // ---- dashboard access (mods the streamer lets into their dashboard) ---------------------------

  editors(channelId: number): string[] {
    return (this.db.prepare(`SELECT username FROM channel_editors WHERE channel_id = ? ORDER BY username`).all(channelId) as { username: string }[]).map(
      (r) => r.username,
    );
  }

  addEditor(channelId: number, username: string): boolean {
    const name = normalizeName(username);
    if (!/^[a-z0-9_.-]{1,40}$/.test(name)) return false;
    this.tx(channelId, () =>
      this.db.prepare(`INSERT OR IGNORE INTO channel_editors (channel_id, username, created_at) VALUES (?, ?, ?)`).run(channelId, name, this.now()),
    );
    return true;
  }

  removeEditor(channelId: number, username: string): boolean {
    return this.tx(channelId, () => this.db.prepare(`DELETE FROM channel_editors WHERE channel_id = ? AND username = ?`).run(channelId, normalizeName(username)).changes > 0);
  }

  /**
   * Can this Kick user control this channel's dashboard? Its owner always can; others only while the
   * owner has them on the access list.
   */
  canControl(channelId: number, user: DashboardLogin): "owner" | "editor" | null {
    const row = this.channelRow(channelId);
    if (!row) return null;
    // Sessions from before mods existed have no user: only the owner could create them.
    if (user.userId === null || user.userId === row.owner_id) return "owner";
    if (!user.username) return null;
    const hit = this.db.prepare(`SELECT 1 FROM channel_editors WHERE channel_id = ? AND username = ?`).get(channelId, normalizeName(user.username));
    return hit ? "editor" : null;
  }

  /**
   * Remember who moderates a channel on Kick, from the badges on their chat messages: Kick has no way to
   * ask. A message without the badge means they were demoted. Writes only when that changes.
   */
  noteChatRole(channelId: number, userId: number, username: string, isMod: boolean) {
    const id = `${channelId}:${userId}`;
    const known = this.db.prepare(`SELECT username FROM kick_mods WHERE id = ?`).get(id) as { username: string } | undefined;
    if (isMod && known?.username !== username) {
      this.db
        .prepare(`INSERT INTO kick_mods (id, channel_id, user_id, username, seen_at) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT (id) DO UPDATE SET username = excluded.username, seen_at = excluded.seen_at`)
        .run(id, channelId, userId, username, this.now());
    } else if (!isMod && known) {
      this.db.prepare(`DELETE FROM kick_mods WHERE id = ?`).run(id);
    }
  }

  /** Has this user been seen with the moderator badge in the channel's chat (and not without it since)? */
  isKickMod(channelId: number, userId: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM kick_mods WHERE id = ?`).get(`${channelId}:${userId}`);
  }

  /** Every channel this user can control: their own first, then the ones they help with. */
  channelsFor(user: DashboardLogin): (ChannelInfo & { role: "owner" | "editor" })[] {
    const own = user.userId === null ? [] : (this.db.prepare(`SELECT * FROM channels WHERE owner_id = ?`).all(user.userId) as ChannelRow[]);
    const helping = user.username
      ? (this.db
          .prepare(`SELECT c.* FROM channels c JOIN channel_editors e ON e.channel_id = c.id WHERE e.username = ? ORDER BY c.display_name`)
          .all(normalizeName(user.username)) as ChannelRow[])
      : [];
    return [
      ...own.map((r) => ({ ...toChannel(r), role: "owner" as const })),
      ...helping.filter((r) => r.owner_id !== user.userId).map((r) => ({ ...toChannel(r), role: "editor" as const })),
    ];
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
    const clips = this.lists(channelId, "clips");
    const songs = this.lists(channelId, "songs");
    return {
      channel: toChannel(row),
      settings: readSettings(row.settings),
      chatConnected,
      ...clips,
      bans: this.bans(channelId),
      editors: this.editors(channelId),
      skipVotes: clips.current ? this.voteCount(channelId, "clips", clips.current.id) : 0,
      botLinked: this.db.prepare(`SELECT 1 FROM bot_tokens WHERE id = ?`).get(channelId) !== undefined,
      songs: {
        ...songs,
        skipVotes: songs.current ? this.voteCount(channelId, "songs", songs.current.id) : 0,
        startedAt: songs.current ? (this.startedAt.get(songs.current.id) ?? null) : null,
        obsUrl: this.songOpts.obsUrl(channelId),
      },
      playing: { clips: this.isPlaying(channelId, "clips"), songs: this.isPlaying(channelId, "songs") },
      control: this.controls.get(channelId) ?? null,
    };
  }

  /** What's playing, what's waiting and what played, for one list. */
  private lists(channelId: number, kind: QueueKind) {
    const rows = (status: string, order: string, limit = -1) =>
      (
        this.db
          .prepare(`SELECT * FROM items WHERE channel_id = ? AND queue = ? AND status IN (${status}) ORDER BY ${order} LIMIT ?`)
          .all(channelId, kind, limit) as ItemRow[]
      ).map(toItem);
    return {
      current: rows(`'playing'`, "id DESC", 1)[0] ?? null,
      queue: rows(`'queued'`, "position, id"),
      history: rows(`'played','skipped'`, "finished_at DESC, id DESC", HISTORY_LIMIT),
    };
  }

  // ---- what's actually playing (clips and songs never play over each other) --------------------

  /** A player reports that its item started playing (true) or paused/ended/closed (false). */
  reportPlaying(channelId: number, kind: QueueKind, itemId: number, playing: boolean) {
    const key = `${channelId}:${kind}`;
    const old = this.playing.get(key);
    const was = this.isPlaying(channelId, kind);
    if (old) clearTimeout(old.timer);
    if (playing) {
      // If the reports stop (tab closed), let the other list know once this goes stale.
      const timer = setTimeout(() => this.changed(channelId), PLAYING_STALE_MS + 100);
      timer.unref?.();
      this.playing.set(key, { itemId, at: this.now(), timer });
    } else if (!old || old.itemId === itemId) {
      this.playing.delete(key);
    } else {
      this.playing.set(key, old); // a stale "stopped" from an earlier item
    }
    if (this.isPlaying(channelId, kind) !== was) this.changed(channelId);
  }

  /** Is this list's current item playing right now (a player said so recently)? */
  isPlaying(channelId: number, kind: QueueKind): boolean {
    const p = this.playing.get(`${channelId}:${kind}`);
    return !!p && this.now() - p.at < PLAYING_STALE_MS && p.itemId === this.currentId(channelId, kind);
  }

  /**
   * Ask the players to play or pause what's current in one list (a mod's `!sr pause`). Returns why
   * not, or null: there's nothing up, or (for play) the other list is playing.
   */
  control(channelId: number, kind: QueueKind, action: "play" | "pause"): string | null {
    if (this.currentId(channelId, kind) === null) return kind === "songs" ? "No song is up right now." : "No clip is up right now.";
    if (action === "play") {
      const busy = this.busyReason(channelId, kind);
      if (busy) return busy;
    }
    this.controls.set(channelId, { seq: ++this.controlSeq, kind, action, at: this.now() });
    this.changed(channelId);
    return null;
  }

  /** Which list an item is in. */
  itemKind(channelId: number, itemId: number): QueueKind | null {
    return this.itemRow(channelId, itemId)?.queue ?? null;
  }

  /** Why `kind` can't be started by hand right now, or null if it can: the other list is playing. */
  busyReason(channelId: number, kind: QueueKind): string | null {
    const other: QueueKind = kind === "clips" ? "songs" : "clips";
    if (!this.isPlaying(channelId, other)) return null;
    return other === "songs" ? "A song is playing. Pause it first, then play the clip." : "A clip is playing. Pause it first, then play the song.";
  }

  // ---- vote skip ------------------------------------------------------------------------------

  /** A viewer votes to skip what's playing; enough votes skip it. One vote per viewer per clip or song. */
  voteSkip(channelId: number, userId: number, kind: QueueKind = "clips"): VoteResult {
    return this.tx(channelId, () => {
      const s = this.settings(channelId);
      const needed = kind === "songs" ? s.songs.voteSkip : s.voteSkip;
      if (needed === 0) return { status: "off" } as const;
      const id = this.currentId(channelId, kind);
      const item = id === null ? null : this.item(channelId, id);
      if (!item) return { status: "nothing_playing" } as const;

      const key = `${channelId}:${kind}`;
      let v = this.votes.get(key);
      if (!v || v.itemId !== item.id) this.votes.set(key, (v = { itemId: item.id, voters: new Set() }));
      if (v.voters.has(userId)) return { status: "already_voted", votes: v.voters.size, needed, item } as const;
      v.voters.add(userId);
      const votes = v.voters.size;
      if (votes < needed) return { status: "counted", votes, needed, item } as const;
      this.votes.delete(key);
      this.next(channelId, "skipped", kind);
      return { status: "skipped", votes, needed, item } as const;
    });
  }

  private voteCount(channelId: number, kind: QueueKind, itemId: number): number {
    const v = this.votes.get(`${channelId}:${kind}`);
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
      (this.db.prepare(`SELECT COUNT(*) AS n FROM items WHERE channel_id = ? AND queue = ? AND ${sql}`).get(channelId, "clips", ...args) as { n: number }).n;

    if (count(`provider = ? AND clip_id = ? AND status IN ('queued','playing')`, ref.provider, ref.id) > 0) return "duplicate";
    if (count(`status = 'queued'`) >= s.maxSize) return "full";
    if (s.perUserLimit > 0 && !isBroadcaster(who) && count(`status = 'queued' AND requester_id = ?`, requesterId) >= s.perUserLimit) return "user_limit";
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
    const position = this.ticket(channelId, "clips");
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
          `INSERT INTO items (channel_id, queue, provider, clip_id, url, start, title, thumbnail, author, duration, media_url, loudness,
             requester_id, requester_name, requester_color, message_id, status, position, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        )
        .run(
          channelId, "clips", resolved.ref.provider, resolved.ref.id, resolved.ref.url, resolved.ref.start ?? null,
          meta.title, meta.thumbnail, meta.author, meta.duration, meta.mediaUrl, meta.loudness ?? null,
          requester.id, requester.username, requester.color, messageId, position, this.now(),
        );
      return { ok: true, item: this.item(channelId, Number(info.lastInsertRowid))! } as const;
    });
  }

  // ---- song requests --------------------------------------------------------------------------

  /** Rules for a song request. Without `video` only the ones that don't need the lookup run. */
  checkSong(channelId: number, who: Viewer, video?: Pick<SongVideo, "id" | "duration">, replacing?: number): RejectReason | null {
    const s = this.settings(channelId).songs;
    if (!s.open) return "closed";
    if (!isBroadcaster(who) && this.isBanned(channelId, who.username, who.id)) return "banned";
    if (!inGroups(s.access, who.badges)) return "not_allowed";
    const count = (sql: string, ...args: unknown[]) =>
      (this.db.prepare(`SELECT COUNT(*) AS n FROM items WHERE channel_id = ? AND queue = 'songs' AND id != ? AND ${sql}`).get(channelId, replacing ?? -1, ...args) as { n: number }).n;
    if (replacing === undefined) {
      if (this.songCooldownLeft(channelId, who) > 0) return "cooldown";
      if (count(`status = 'queued'`) >= s.maxSize) return "full";
      if (s.perUserLimit > 0 && !isBroadcaster(who) && count(`status = 'queued' AND requester_id = ?`, who.id) >= s.perUserLimit) return "user_limit";
    }
    if (!video) return null;
    if (count(`clip_id = ? AND status IN ('queued','playing')`, video.id) > 0) return "duplicate";
    if (video.duration !== null && video.duration > s.maxDuration) return "too_long";
    return null;
  }

  /**
   * Seconds a viewer still has to wait before their next song request; 0 when they can go. Counts
   * from their latest request that's still around, so `!wrongsong` (or a mod removing it) frees them.
   */
  songCooldownLeft(channelId: number, who: Viewer): number {
    const wait = this.settings(channelId).songs.requestCooldown;
    if (wait === 0 || isBroadcaster(who) || who.badges.includes("moderator")) return 0;
    const { t } = this.db
      .prepare(`SELECT MAX(created_at) AS t FROM items WHERE channel_id = ? AND queue = 'songs' AND requester_id = ? AND status != 'removed'`)
      .get(channelId, who.id) as { t: number | null };
    if (t === null) return 0;
    const left = wait - (this.now() - t) / 1000;
    return left > 0 ? Math.ceil(left) : 0;
  }

  /** `!sr <link or name>`. Starts right away when nothing is playing. */
  async requestSong(
    channelId: number,
    query: SongQuery,
    requester: Requester,
    messageId: string | null,
    badges: readonly string[] = [],
  ): Promise<SubmitResult> {
    const who: Viewer = { id: requester.id, username: requester.username, badges };
    const fail = (reason: RejectReason) =>
      reason === "cooldown" ? { ok: false as const, reason, retryIn: this.songCooldownLeft(channelId, who) } : { ok: false as const, reason };
    const early = this.checkSong(channelId, who);
    if (early) return fail(early);

    const position = this.ticket(channelId, "songs");
    const found = await this.songOpts.resolve(query, this.settings(channelId).songs.maxDuration);
    if (!found.ok) return { ok: false, reason: found.reason };
    if (messageId && this.deletedMessages.has(`${channelId}:${messageId}`)) return { ok: false, reason: "moderated" };
    if (this.recentlyBanned(channelId, requester.id)) return { ok: false, reason: "moderated" };

    return this.tx(channelId, () => {
      const reason = this.checkSong(channelId, who, found.video);
      if (reason) return fail(reason);
      const v = found.video;
      const info = this.db
        .prepare(
          `INSERT INTO items (channel_id, queue, provider, clip_id, url, start, title, thumbnail, author, duration, media_url, loudness,
             requester_id, requester_name, requester_color, message_id, status, position, created_at)
           VALUES (?, 'songs', 'youtube', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        )
        .run(
          channelId, v.id, `https://www.youtube.com/watch?v=${v.id}`, v.start, v.title, v.thumbnail, v.author, v.duration, v.loudness,
          requester.id, requester.username, requester.color, messageId, position, this.now(),
        );
      const id = Number(info.lastInsertRowid);
      if (this.currentId(channelId, "songs") === null) this.startFirstQueued(channelId, "songs");
      return { ok: true, item: this.item(channelId, id)! } as const;
    });
  }

  /** A viewer swaps one of their waiting songs for another, keeping its place in line. */
  async replaceSong(channelId: number, itemId: number, viewer: { id: number; username: string }, query: SongQuery): Promise<SubmitResult> {
    const own = () => {
      const row = this.itemRow(channelId, itemId);
      return row && row.queue === "songs" && row.status === "queued" && row.requester_id === viewer.id ? row : null;
    };
    if (!own()) return { ok: false, reason: "not_found" };
    const found = await this.songOpts.resolve(query, this.settings(channelId).songs.maxDuration);
    if (!found.ok) return { ok: false, reason: found.reason };
    return this.tx(channelId, () => {
      if (!own()) return { ok: false, reason: "not_found" } as const;
      const reason = this.checkSong(channelId, { ...viewer, badges: [] }, found.video, itemId);
      // Access was checked when they first requested; a later badge change shouldn't block a swap.
      if (reason && reason !== "not_allowed") return { ok: false, reason } as const;
      const v = found.video;
      this.db
        .prepare(`UPDATE items SET clip_id = ?, url = ?, start = ?, title = ?, thumbnail = ?, author = ?, duration = ?, loudness = ? WHERE id = ?`)
        .run(v.id, `https://www.youtube.com/watch?v=${v.id}`, v.start, v.title, v.thumbnail, v.author, v.duration, v.loudness, itemId);
      return { ok: true, item: this.item(channelId, itemId)! } as const;
    });
  }

  /** A viewer removes one of their waiting songs. */
  removeOwnSong(channelId: number, itemId: number, userId: number): boolean {
    return this.tx(channelId, () => this.removeWhere(channelId, `id = ? AND queue = 'songs' AND status = 'queued' AND requester_id = ?`, itemId, userId) > 0);
  }

  /** `!sr remove <user>`: drop everything that viewer has waiting or playing in the song list. */
  removeSongsByName(channelId: number, username: string): number {
    return this.tx(channelId, () => this.removeWhere(channelId, `queue = 'songs' AND lower(requester_name) = ?`, normalizeName(username)));
  }

  /** `!wrongsong`: drop the viewer's most recent waiting song. */
  wrongSong(channelId: number, userId: number): QueueItem | null {
    return this.tx(channelId, () => {
      const row = this.db
        .prepare(`SELECT * FROM items WHERE channel_id = ? AND queue = 'songs' AND status = 'queued' AND requester_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
        .get(channelId, userId) as ItemRow | undefined;
      if (!row) return null;
      this.removeWhere(channelId, `id = ?`, row.id);
      return toItem(row);
    });
  }

  /**
   * The song queue with when each one should start: what's left of the playing song plus everything
   * ahead. Null once a song ahead has no known length.
   */
  songTimeline(channelId: number): { current: QueueItem | null; left: number | null; queue: { item: QueueItem; startsIn: number | null }[] } {
    const { current, queue } = this.lists(channelId, "songs");
    // A song YouTube gave no length for still needs a place on the clock: guess a typical song.
    const length = (i: QueueItem) => i.duration ?? UNKNOWN_SONG_SECONDS;
    let t = 0;
    let left: number | null = null;
    if (current) {
      const started = this.startedAt.get(current.id);
      // Unknown start (after a restart): assume it just began.
      t = started === undefined ? length(current) : Math.max(0, length(current) - (this.now() - started) / 1000);
      // "Time left" is only stated for a song whose real length we know.
      left = current.duration === null ? null : Math.round(t);
    }
    const out = queue.map((item) => {
      const startsIn = Math.round(t);
      t += length(item);
      return { item, startsIn };
    });
    return { current, left, queue: out };
  }

  /** The public song page: playing, waiting, and (if logged in) the viewer's own songs. */
  publicSongs(channelId: number, viewer: { id: number; username: string } | null): PublicSongs {
    const row = this.channelRow(channelId);
    if (!row) throw new Error(`unknown channel ${channelId}`);
    const tl = this.songTimeline(channelId);
    const pub = (i: QueueItem, startsIn: number | null = null): PublicSong => ({
      id: i.id,
      title: i.title,
      author: i.author,
      thumbnail: i.thumbnail,
      url: i.url,
      duration: i.duration,
      requestedBy: i.requestedBy.username,
      startsIn,
    });
    const queue = tl.queue.map((q) => pub(q.item, q.startsIn));
    let me: PublicSongs["me"] = null;
    if (viewer) {
      const history = (
        this.db
          .prepare(`SELECT * FROM items WHERE channel_id = ? AND queue = 'songs' AND requester_id = ? AND status IN ('played','skipped','playing') ORDER BY COALESCE(finished_at, created_at) DESC, id DESC LIMIT ?`)
          .all(channelId, viewer.id, MY_HISTORY_LIMIT) as ItemRow[]
      ).map((r) => pub(toItem(r)));
      me = {
        username: viewer.username,
        queued: tl.queue.filter((q) => q.item.requestedBy.id === viewer.id).map((q) => pub(q.item, q.startsIn)),
        history,
      };
    }
    return {
      channel: { slug: row.slug, displayName: row.display_name },
      open: readSettings(row.settings).songs.open,
      current: tl.current ? pub(tl.current) : null,
      queue,
      me,
      manage: false,
    };
  }

  // ---- playback controls ----------------------------------------------------------------------

  /** Finish what's playing and start the first queued one. */
  next(channelId: number, as: "played" | "skipped" = "played", kind: QueueKind = "clips") {
    this.tx(channelId, () => {
      this.finishCurrent(channelId, as, kind);
      this.startFirstQueued(channelId, kind);
    });
  }

  /** Put what's playing back at the front of the queue and replay the last finished one. */
  previous(channelId: number, kind: QueueKind = "clips") {
    this.tx(channelId, () => {
      const last = this.db
        .prepare(`SELECT id FROM items WHERE channel_id = ? AND queue = ? AND status IN ('played','skipped') ORDER BY finished_at DESC, id DESC LIMIT 1`)
        .get(channelId, kind) as { id: number } | undefined;
      if (!last) return;
      const current = this.currentId(channelId, kind);
      if (current !== null) {
        this.db.prepare(`UPDATE items SET status = 'queued', position = ? WHERE id = ?`).run(this.minPosition(channelId, kind) - 1, current);
      }
      this.setPlaying(last.id);
    });
  }

  /** Play a specific item now, from the queue or the history. The interrupted one goes back on top of its queue. */
  play(channelId: number, itemId: number): boolean {
    return this.tx(channelId, () => {
      const row = this.itemRow(channelId, itemId);
      if (!row || row.status === "removed" || row.status === "playing") return row?.status === "playing";
      const current = this.currentId(channelId, row.queue);
      this.setPlaying(itemId);
      if (current !== null) {
        this.db.prepare(`UPDATE items SET status = 'queued', position = ? WHERE id = ?`).run(this.minPosition(channelId, row.queue) - 1, current);
      }
      return true;
    });
  }

  remove(channelId: number, itemId: number): boolean {
    return this.tx(channelId, () => this.removeWhere(channelId, `id = ?`, itemId) > 0);
  }

  /** Move a queued item to a 0-based index in its queue. */
  move(channelId: number, itemId: number, toIndex: number): boolean {
    return this.tx(channelId, () => {
      const kind = this.itemRow(channelId, itemId)?.queue;
      if (!kind) return false;
      const ids = (
        this.db.prepare(`SELECT id FROM items WHERE channel_id = ? AND queue = ? AND status = 'queued' ORDER BY position, id`).all(channelId, kind) as { id: number }[]
      ).map((r) => r.id);
      const from = ids.indexOf(itemId);
      if (from < 0) return false;
      ids.splice(from, 1);
      ids.splice(Math.max(0, Math.min(toIndex, ids.length)), 0, itemId);
      // Renumber from the current lowest position so no number grows past a pending ticket.
      const base = this.minPosition(channelId, kind);
      const set = this.db.prepare(`UPDATE items SET position = ? WHERE id = ?`);
      ids.forEach((id, i) => set.run(base + i, id));
      return true;
    });
  }

  /** Move a waiting song (only a song: the song page and `!sr move` must not touch clips). */
  moveSong(channelId: number, itemId: number, toIndex: number): boolean {
    return this.itemRow(channelId, itemId)?.queue === "songs" && this.move(channelId, itemId, toIndex);
  }

  /** A channel point redemption: the viewer's next waiting song goes to the top. Returns it, or null if they have none. */
  prioritizeSong(channelId: number, userId: number): QueueItem | null {
    const row = this.db
      .prepare(`SELECT id FROM items WHERE channel_id = ? AND queue = 'songs' AND status = 'queued' AND requester_id = ? ORDER BY position, id LIMIT 1`)
      .get(channelId, userId) as { id: number } | undefined;
    if (!row) return null;
    this.move(channelId, row.id, 0);
    return this.item(channelId, row.id);
  }

  /** The id of the waiting song at a 1-based position in the list, as the song page numbers them. */
  songAt(channelId: number, position: number): number | null {
    const row = this.db
      .prepare(`SELECT id FROM items WHERE channel_id = ? AND queue = 'songs' AND status = 'queued' ORDER BY position, id LIMIT 1 OFFSET ?`)
      .get(channelId, position - 1) as { id: number } | undefined;
    return position >= 1 && row ? row.id : null;
  }

  clear(channelId: number, kind: QueueKind = "clips") {
    this.tx(channelId, () => {
      this.db.prepare(`UPDATE items SET status = 'removed', finished_at = ? WHERE channel_id = ? AND queue = ? AND status = 'queued'`).run(this.now(), channelId, kind);
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

  /** Removes matching queued/playing items, in both lists. If a playing one goes, the next one starts. */
  private removeWhere(channelId: number, where: string, ...args: unknown[]): number {
    const current = KINDS.map((k) => this.currentId(channelId, k));
    const ids = (
      this.db
        .prepare(`SELECT id FROM items WHERE channel_id = ? AND status IN ('queued','playing') AND ${where}`)
        .all(channelId, ...args) as { id: number }[]
    ).map((r) => r.id);
    if (!ids.length) return 0;
    const set = this.db.prepare(`UPDATE items SET status = 'removed', finished_at = ? WHERE id = ?`);
    for (const id of ids) set.run(this.now(), id);
    KINDS.forEach((k, i) => {
      const c = current[i];
      if (c != null && ids.includes(c)) this.startFirstQueued(channelId, k);
    });
    return ids.length;
  }

  private finishCurrent(channelId: number, as: ItemStatus, kind: QueueKind) {
    const id = this.currentId(channelId, kind);
    if (id === null) return;
    this.startedAt.delete(id);
    this.db.prepare(`UPDATE items SET status = ?, finished_at = ? WHERE id = ?`).run(as, this.now(), id);
  }

  private startFirstQueued(channelId: number, kind: QueueKind) {
    const first = this.db
      .prepare(`SELECT id FROM items WHERE channel_id = ? AND queue = ? AND status = 'queued' ORDER BY position, id LIMIT 1`)
      .get(channelId, kind) as { id: number } | undefined;
    if (first) this.setPlaying(first.id);
  }

  private setPlaying(itemId: number) {
    this.db.prepare(`UPDATE items SET status = 'playing', finished_at = NULL WHERE id = ?`).run(itemId);
    this.startedAt.set(itemId, this.now());
  }

  private currentId(channelId: number, kind: QueueKind): number | null {
    const row = this.db
      .prepare(`SELECT id FROM items WHERE channel_id = ? AND queue = ? AND status = 'playing' ORDER BY id DESC LIMIT 1`)
      .get(channelId, kind) as { id: number } | undefined;
    return row?.id ?? null;
  }

  /** Next queue position, above everything queued and every ticket already handed out. */
  private ticket(channelId: number, kind: QueueKind): number {
    const { m } = this.db
      .prepare(`SELECT COALESCE(MAX(position), 0) AS m FROM items WHERE channel_id = ? AND queue = ? AND status = 'queued'`)
      .get(channelId, kind) as { m: number };
    const key = `${channelId}:${kind}`;
    const t = Math.max(m, this.lastTicket.get(key) ?? 0) + 1;
    this.lastTicket.set(key, t);
    return t;
  }

  private minPosition(channelId: number, kind: QueueKind): number {
    const { m } = this.db
      .prepare(`SELECT COALESCE(MIN(position), 1) AS m FROM items WHERE channel_id = ? AND queue = ? AND status = 'queued'`)
      .get(channelId, kind) as { m: number };
    return m;
  }

  private itemRow(channelId: number, itemId: number): ItemRow | null {
    return (this.db.prepare(`SELECT * FROM items WHERE id = ? AND channel_id = ?`).get(itemId, channelId) as ItemRow | undefined) ?? null;
  }

  private item(channelId: number, itemId: number): QueueItem | null {
    const row = this.itemRow(channelId, itemId);
    return row ? toItem(row) : null;
  }

  /** Rules about the queue and the viewer, not the clip: open, platform on, viewer allowed, not banned. */
  private checkOpen(channelId: number, provider: Provider, who: Viewer): RejectReason | null {
    const row = this.channelRow(channelId);
    if (!row) return "closed";
    const s = readSettings(row.settings);
    if (!s.open) return "closed";
    if (!s.providers.includes(provider)) return "provider_disabled";
    if (!isBroadcaster(who) && this.isBanned(channelId, who.username, who.id)) return "banned";
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
  const merged = { ...DEFAULT_SETTINGS, ...saved, songs: { ...DEFAULT_SETTINGS.songs, ...saved.songs } };
  // Songs used to have their own volume and normalize switch; now one of each covers clips and songs.
  const oldSongs = saved.songs as { volume?: number; normalize?: boolean } | undefined;
  if (saved.volume === undefined && oldSongs?.volume !== undefined) merged.volume = oldSongs.volume;
  if (saved.normalize === undefined && oldSongs?.normalize !== undefined) merged.normalize = oldSongs.normalize;
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
    queue: r.queue,
    provider: r.provider,
    clipId: r.clip_id,
    url: r.url,
    start: r.start,
    title: r.title,
    thumbnail: r.thumbnail,
    author: r.author,
    duration: r.duration,
    mediaUrl: r.media_url,
    loudness: r.loudness ?? null,
    requestedBy: { id: r.requester_id, username: r.requester_name, color: r.requester_color },
    status: r.status,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}
