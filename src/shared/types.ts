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
}

export const DEFAULT_SETTINGS: QueueSettings = {
  open: false,
  maxSize: 100,
  perUserLimit: 3,
  providers: [...PROVIDERS],
  autoAdvance: true,
  access: {},
  voteSkip: 15,
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
}

/** Messages the server pushes over /ws. */
export type ServerMessage = { type: "state"; state: QueueState };
