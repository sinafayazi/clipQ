import type { ClipRef } from "../../shared/types.js";
import { getJson, HttpError } from "../http-client.js";

export interface ClipMeta {
  title: string | null;
  thumbnail: string | null;
  author: string | null;
  duration: number | null;
  mediaUrl: string | null;
}

export type Resolved =
  | { ok: true; ref: ClipRef; meta: ClipMeta }
  | { ok: false; reason: "not_found" | "unplayable" };

const EMPTY: ClipMeta = { title: null, thumbnail: null, author: null, duration: null, mediaUrl: null };

/**
 * Look up a clip's metadata. Only a definite answer from the provider ("doesn't exist", "can't be
 * embedded") rejects a clip; timeouts and outages keep it with empty metadata so a flaky API never
 * eats a viewer's request.
 */
export async function resolveClip(ref: ClipRef): Promise<Resolved> {
  try {
    if (ref.shortLink) ref = await expandTikTok(ref);
    const meta = await RESOLVERS[ref.provider](ref);
    if (meta === "not_found" || meta === "unplayable") return { ok: false, reason: meta };
    return { ok: true, ref, meta };
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 400)) {
      return { ok: false, reason: "not_found" };
    }
    // A short link we couldn't expand has no usable id.
    if (ref.shortLink) return { ok: false, reason: "not_found" };
    return { ok: true, ref, meta: EMPTY };
  }
}

type Result = ClipMeta | "not_found" | "unplayable";

const RESOLVERS: Record<ClipRef["provider"], (ref: ClipRef) => Promise<Result>> = {
  async kick(ref) {
    const { clip } = await getJson<{ clip: KickClip | null }>(`https://kick.com/api/v2/clips/${ref.id}`);
    if (!clip) return "not_found";
    if (clip.privacy && clip.privacy !== "public") return "unplayable";
    return {
      title: clip.title ?? null,
      thumbnail: clip.thumbnail_url ?? null,
      author: clip.channel?.username ?? null,
      duration: clip.duration ?? null,
      mediaUrl: clip.video_url ?? clip.clip_url ?? null,
    };
  },

  async youtube(ref) {
    const watch = `https://www.youtube.com/watch?v=${ref.id}`;
    try {
      const o = await oembed(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`);
      return { ...EMPTY, title: o.title ?? null, author: o.author_name ?? null, thumbnail: ytThumb(ref.id) };
    } catch (err) {
      // 401/403: embedding disabled or private. 404: deleted.
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) return "unplayable";
      throw err;
    }
  },

  async twitch(ref) {
    // Twitch's public web client id; the documented API needs an app token for clip lookups.
    const body = JSON.stringify({
      query: `query($slug: ID!) { clip(slug: $slug) { title durationSeconds thumbnailURL broadcaster { displayName } } }`,
      variables: { slug: ref.id },
    });
    const res = await getJson<{ data?: { clip: TwitchClip | null } }>("https://gql.twitch.tv/gql", {
      method: "POST",
      body,
      headers: { "client-id": "kimne78kx3ncx6brgo4mv6wki5h1ko", "content-type": "application/json" },
    });
    if (!res.data) return EMPTY;
    const c = res.data.clip;
    if (!c) return "not_found";
    return {
      ...EMPTY,
      title: c.title ?? null,
      thumbnail: c.thumbnailURL ?? null,
      author: c.broadcaster?.displayName ?? null,
      duration: c.durationSeconds ?? null,
    };
  },

  async tiktok(ref) {
    const o = await oembed(`https://www.tiktok.com/oembed?url=${encodeURIComponent(ref.url)}`);
    return { ...EMPTY, title: o.title || null, author: o.author_name ?? null, thumbnail: o.thumbnail_url ?? null };
  },

  async x(ref) {
    const o = await oembed(`https://publish.twitter.com/oembed?omit_script=1&url=${encodeURIComponent(ref.url)}`);
    const text = o.html ? stripTweetHtml(o.html) : null;
    return { ...EMPTY, title: text, author: o.author_name ?? null };
  },

  async streamable(ref) {
    const o = await oembed(`https://api.streamable.com/oembed.json?url=${encodeURIComponent(`https://streamable.com/${ref.id}`)}`);
    return { ...EMPTY, title: o.title || null, thumbnail: o.thumbnail_url ?? null, duration: o.duration ?? null };
  },
};

async function expandTikTok(ref: ClipRef): Promise<ClipRef> {
  const res = await fetch(ref.url, {
    redirect: "follow",
    signal: AbortSignal.timeout(6000),
  });
  await res.body?.cancel();
  const id = new URL(res.url).pathname.match(/\/video\/(\d{5,25})/)?.[1];
  if (!id) throw new HttpError(404, ref.url);
  return { provider: "tiktok", id, url: `https://www.tiktok.com/video/${id}` };
}

function oembed(url: string) {
  return getJson<OEmbed>(url);
}

function ytThumb(id: string) {
  return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
}

function stripTweetHtml(html: string): string | null {
  const p = html.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1];
  if (!p) return null;
  const text = p
    .replace(/<br\s*\/?>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
  return text ? text.slice(0, 200) : null;
}

interface OEmbed {
  title?: string;
  author_name?: string;
  thumbnail_url?: string;
  html?: string;
  duration?: number;
}

interface KickClip {
  title?: string;
  thumbnail_url?: string;
  video_url?: string;
  clip_url?: string;
  duration?: number;
  privacy?: string;
  channel?: { username?: string };
}

interface TwitchClip {
  title?: string;
  durationSeconds?: number;
  thumbnailURL?: string;
  broadcaster?: { displayName?: string };
}
