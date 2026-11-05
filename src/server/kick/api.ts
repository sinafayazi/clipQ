import type { ChannelInfo } from "../../shared/types.js";
import { getJson } from "../http-client.js";

interface V2Channel {
  slug: string;
  user_id: number;
  user?: { username?: string };
  chatroom?: { id?: number };
  subscriber_badges?: SubscriberBadgeRaw[];
}

export interface SubscriberBadgeRaw {
  months?: number;
  badge_image?: { src?: string };
}

export interface SubscriberBadge {
  months: number;
  src: string;
}

/**
 * Channel info from Kick's site API. `id` is the broadcaster's user id, which the official API also
 * returns, so a channel keeps one id whichever API we got it from.
 * Throws HttpError if Cloudflare blocks the server.
 */
export async function lookupChannel(slug: string): Promise<ChannelInfo> {
  const c = await getJson<V2Channel>(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`);
  return {
    id: c.user_id,
    slug: c.slug,
    displayName: c.user?.username ?? c.slug,
    chatroomId: c.chatroom?.id ?? null,
  };
}

/** Channel subscriber badges (streamer-uploaded). Empty if Kick/Cloudflare blocks the request. */
export async function fetchSubscriberBadges(slug: string): Promise<SubscriberBadge[]> {
  try {
    const c = await getJson<V2Channel>(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`);
    return (c.subscriber_badges || [])
      .map((b) => ({
        months: Number(b.months) || 0,
        src: String(b?.badge_image?.src || ""),
      }))
      .filter((b) => b.src)
      .sort((a, b) => b.months - a.months);
  } catch {
    return [];
  }
}
