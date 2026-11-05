import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

// Overlay browser sources (chat, emote streak) use the same secret-link model as the OBS song
// player: an HMAC of the channel id in the URL. Anyone with the link can read that channel's chat.

export type OverlayKind = "chat" | "streak";

const PATH: Record<OverlayKind, string> = {
  chat: "chat",
  streak: "emote-streak",
};

export function overlayKey(kind: OverlayKind, channelId: number): string {
  return createHmac("sha256", config.linkSecret).update(`overlay:${kind}:${channelId}`).digest("base64url").slice(0, 24);
}

export function overlayKeyValid(kind: OverlayKind, channelId: number, key: string): boolean {
  const want = Buffer.from(overlayKey(kind, channelId));
  const got = Buffer.from(key);
  return got.length === want.length && timingSafeEqual(got, want);
}

export function overlayUrl(kind: OverlayKind, channelId: number): string {
  return `${config.publicUrl}/overlays/${PATH[kind]}/?c=${channelId}&k=${overlayKey(kind, channelId)}`;
}
