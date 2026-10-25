import type { ClipRef } from "../../shared/types.js";

// Finds URL-ish tokens in chat text. Links without a scheme ("youtu.be/abc") are common in chat.
const URL_TOKEN = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"']*)?/gi;

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const TWITCH_SLUG = /^[A-Za-z0-9_-]{3,100}$/;
const KICK_CLIP = /clip_[0-9A-Z]{26}/;
const DIGITS = /^\d{5,25}$/;

/** All clip links in a message, in order, without duplicates. */
export function findClips(text: string): ClipRef[] {
  const found: ClipRef[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(URL_TOKEN)) {
    const ref = parseClipUrl(match[0]);
    if (!ref) continue;
    const key = `${ref.provider}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(ref);
  }
  return found;
}

/** Parse one link. Returns null for anything that isn't a supported clip. */
export function parseClipUrl(raw: string): ClipRef | null {
  // Chat punctuation stuck to the end of links: "check this youtu.be/x)."
  const trimmed = raw.replace(/[)\].,!?;:'"]+$/, "");
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  u.protocol = "https:";

  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  const url = u.toString();

  switch (host) {
    case "youtube.com":
    case "music.youtube.com":
    case "youtube-nocookie.com": {
      let id: string | null = null;
      if (parts[0] === "watch") id = u.searchParams.get("v");
      else if (["shorts", "live", "embed", "v"].includes(parts[0] ?? "")) id = parts[1] ?? null;
      if (!id || !YT_ID.test(id)) return null;
      return withStart({ provider: "youtube", id, url }, u);
    }
    case "youtu.be": {
      const id = parts[0];
      if (!id || !YT_ID.test(id)) return null;
      return withStart({ provider: "youtube", id, url }, u);
    }
    case "clips.twitch.tv": {
      const slug = parts[0] === "embed" ? u.searchParams.get("clip") : parts[0];
      if (!slug || !TWITCH_SLUG.test(slug)) return null;
      return { provider: "twitch", id: slug, url };
    }
    case "twitch.tv": {
      // twitch.tv/<channel>/clip/<slug>  or  m.twitch.tv/clip/<slug>
      const i = parts.indexOf("clip");
      const slug = i >= 0 ? parts[i + 1] : undefined;
      if (!slug || !TWITCH_SLUG.test(slug)) return null;
      return { provider: "twitch", id: slug, url };
    }
    case "kick.com": {
      // kick.com/<channel>/clips/clip_XXX, kick.com/<channel>?clip=clip_XXX, kick.com/clips/clip_XXX
      const id = (u.pathname + u.search).match(KICK_CLIP)?.[0];
      if (!id) return null;
      return { provider: "kick", id, url };
    }
    case "tiktok.com": {
      // tiktok.com/@user/video/123, tiktok.com/t/<code>
      const i = parts.indexOf("video");
      const id = i >= 0 ? parts[i + 1] : undefined;
      if (id && DIGITS.test(id)) return { provider: "tiktok", id, url };
      if (parts[0] === "t" && parts[1]) return { provider: "tiktok", id: parts[1], url, shortLink: true };
      return null;
    }
    case "vm.tiktok.com":
    case "vt.tiktok.com": {
      if (!parts[0]) return null;
      return { provider: "tiktok", id: parts[0], url, shortLink: true };
    }
    case "x.com":
    case "twitter.com": {
      // x.com/<user>/status/<id>, x.com/i/status/<id>
      const i = parts.indexOf("status");
      const id = i >= 0 ? parts[i + 1] : undefined;
      if (!id || !DIGITS.test(id)) return null;
      return { provider: "x", id, url };
    }
    case "streamable.com": {
      const id = parts[0] === "e" || parts[0] === "o" ? parts[1] : parts[0];
      if (!id || !/^[a-z0-9]{3,12}$/i.test(id)) return null;
      return { provider: "streamable", id, url };
    }
    default:
      return null;
  }
}

function withStart(ref: ClipRef, u: URL): ClipRef {
  const t = u.searchParams.get("t") ?? u.searchParams.get("start");
  const start = t ? parseTimestamp(t) : 0;
  return start > 0 ? { ...ref, start } : ref;
}

/** "90", "90s", "1m30s", "1h2m3s" -> seconds. Invalid input -> 0. */
export function parseTimestamp(t: string): number {
  if (/^\d+$/.test(t)) return Number(t);
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || !m[0]) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}
