import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

// The OBS song player is a page without a login (OBS can't log in), so its link carries a key:
// an HMAC of the channel id. Anyone with the link can skip songs, so it's shown only to the streamer.

export function obsKey(channelId: number): string {
  return createHmac("sha256", config.linkSecret).update(`obs:${channelId}`).digest("base64url").slice(0, 24);
}

export function obsKeyValid(channelId: number, key: string): boolean {
  const want = Buffer.from(obsKey(channelId));
  const got = Buffer.from(key);
  return got.length === want.length && timingSafeEqual(got, want);
}

export function obsUrl(channelId: number): string {
  return `${config.publicUrl}/obs/?c=${channelId}&k=${obsKey(channelId)}`;
}
