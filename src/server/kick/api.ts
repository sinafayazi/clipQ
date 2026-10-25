import type { ChannelInfo } from "../../shared/types.js";
import { getJson } from "../http-client.js";

interface V2Channel {
  slug: string;
  user_id: number;
  user?: { username?: string };
  chatroom?: { id?: number };
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
