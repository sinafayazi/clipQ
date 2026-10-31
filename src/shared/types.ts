// Types shared by the server and the dashboard.

export const PROVIDERS = ["kick", "youtube", "twitch", "tiktok", "instagram", "x", "streamable"] as const;
export type Provider = (typeof PROVIDERS)[number];

/**
 * Who may post links for a platform. "everyone" means no restriction; otherwise a viewer needs one
 * of the listed Kick badges. The broadcaster is always allowed.
 */
export const ACCESS_GROUPS = ["everyone", "subscriber", "og", "vip", "moderator"] as const;
export type AccessGroup = (typeof ACCESS_GROUPS)[number];

/** A clip link found in a chat message, before any network lookup. */
export interface ClipRef {
  provider: Provider;
  /** Provider-specific id. For TikTok short links this is the short code until resolved. */
  id: string;
  /** The link as it appeared in chat (normalised to https). */
  url: string;
  /** Start offset in seconds (YouTube `t=`). */
  start?: number;
  /** True when the id still needs a redirect lookup (TikTok vm./vt. links). */
  shortLink?: boolean;
}

export type ItemStatus = "queued" | "playing" | "played" | "skipped" | "removed";

export interface Requester {
  id: number;
  username: string;
  color: string | null;
}

export interface QueueItem {
  id: number;
  queue: QueueKind;
  provider: Provider;
  clipId: string;
  url: string;
  start: number | null;
  title: string | null;
  thumbnail: string | null;
  author: string | null;
  /** Seconds, when the provider tells us. */
  duration: number | null;
  /** Direct media URL (Kick clips are HLS). */
  mediaUrl: string | null;
  requestedBy: Requester;
  status: ItemStatus;
  createdAt: number;
  finishedAt: number | null;
}

/** The two lists a channel has: clips and song requests. Stored in `items.queue`. */
export type QueueKind = "clips" | "songs";

/** Song requests (`!sr`). Songs always play from YouTube; Spotify links are matched to a YouTube video. */
export interface SongSettings {
  /** Accept `!sr` requests. */
  open: boolean;
  /** Max songs waiting. */
  maxSize: number;
  /** Max songs one viewer can have waiting. 0 = no limit. */
  perUserLimit: number;
  /** Longest song accepted, in seconds. */
  maxDuration: number;
  /** `!voteskip` votes that skip the playing song. 0 = off. */
  voteSkip: number;
  /** Seconds a viewer waits between song requests. 0 = no wait. Mods and the broadcaster don't wait. */
  requestCooldown: number;
  /** Who may request. */
  access: AccessGroup[];
  /** Where songs play: the dashboard's Songs tab, or the OBS browser-source page. */
  player: "dashboard" | "obs";
  /** Song volume, 0–100. Mods can change it from chat with `!volume`. */
  volume: number;
}

export const DEFAULT_SONG_SETTINGS: SongSettings = {
  open: false,
  maxSize: 50,
  perUserLimit: 2,
  maxDuration: 600,
  voteSkip: 10,
  requestCooldown: 120,
  access: ["everyone"],
  player: "dashboard",
  volume: 60,
};

export interface QueueSettings {
  /** Accept new links from chat. */
  open: boolean;
  /** Max clips waiting in the queue. */
  maxSize: number;
  /** Max clips one viewer can have waiting at once. 0 = no limit. */
  perUserLimit: number;
  providers: Provider[];
  /** Go to the next clip when one ends (Kick and YouTube only; other embeds don't report it). */
  autoAdvance: boolean;
  /** Per platform, who may post. A platform missing here is open to everyone. */
  access: Partial<Record<Provider, AccessGroup[]>>;
  /** Viewer votes (`!vs`) that skip the playing clip. 0 = vote skip off. */
  voteSkip: number;
  songs: SongSettings;
}

export const DEFAULT_SETTINGS: QueueSettings = {
  open: false,
  maxSize: 100,
  perUserLimit: 3,
  providers: [...PROVIDERS],
  autoAdvance: true,
  access: {},
  voteSkip: 15,
  songs: DEFAULT_SONG_SETTINGS,
};

/** A viewer whose links clipQ ignores, until `until` (ms) or for good when null. */
export interface Ban {
  id: number;
  username: string;
  until: number | null;
  createdAt: number;
}

export interface ChannelInfo {
  id: number;
  slug: string;
  displayName: string;
  chatroomId: number | null;
}

export interface QueueState {
  channel: ChannelInfo;
  settings: QueueSettings;
  chatConnected: boolean;
  current: QueueItem | null;
  queue: QueueItem[];
  history: QueueItem[];
  /** Active bans and timeouts. */
  bans: Ban[];
  /** Skip votes for the playing clip. */
  skipVotes: number;
  /** clipQ's bot can reply in this channel's chat (the streamer granted chat:write). */
  botLinked: boolean;
  songs: SongsState;
}

export interface SongsState {
  current: QueueItem | null;
  queue: QueueItem[];
  history: QueueItem[];
  /** Skip votes for the playing song. */
  skipVotes: number;
  /** When the playing song started (ms), if known. */
  startedAt: number | null;
  /** The OBS browser-source page for this channel (secret: it can skip songs). */
  obsUrl: string;
}

/** A queued song with its place in line, for the public song list. */
export interface PublicSong {
  id: number;
  title: string | null;
  author: string | null;
  thumbnail: string | null;
  url: string;
  duration: number | null;
  requestedBy: string;
  /** Seconds until it starts, if every duration ahead is known. */
  startsIn: number | null;
}

/** The public song page (`/s/<channel>`): what's playing, what's next, and the viewer's own songs. */
export interface PublicSongs {
  channel: { slug: string; displayName: string };
  open: boolean;
  current: PublicSong | null;
  queue: PublicSong[];
  /** Null when the viewer isn't logged in. */
  me: { username: string; queued: PublicSong[]; history: PublicSong[] } | null;
}

/** Messages the server pushes over /ws. */
export type ServerMessage = { type: "state"; state: QueueState };
