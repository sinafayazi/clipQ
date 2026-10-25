// Types shared by the server and the dashboard.

export const PROVIDERS = ["kick", "youtube", "twitch", "tiktok", "x", "streamable"] as const;
export type Provider = (typeof PROVIDERS)[number];

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
  /** Allow a clip that was already played since the queue was last opened. */
  allowRepeats: boolean;
  /** Go to the next clip when one ends (Kick and YouTube only; other embeds don't report it). */
  autoAdvance: boolean;
}

export const DEFAULT_SETTINGS: QueueSettings = {
  open: false,
  maxSize: 100,
  perUserLimit: 3,
  providers: [...PROVIDERS],
  allowRepeats: false,
  autoAdvance: true,
};

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
}

/** Messages the server pushes over /ws. */
export type ServerMessage = { type: "state"; state: QueueState };
