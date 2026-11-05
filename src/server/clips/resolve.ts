import https from "node:https";
import type { ClipRef } from "../../shared/types.js";
import { getJson, HttpError } from "../http-client.js";
import { BROWSER_UA, videoPage } from "../songs/resolve.js";

export interface ClipMeta {
  title: string | null;
  thumbnail: string | null;
  author: string | null;
  duration: number | null;
  mediaUrl: string | null;
  /** YouTube only: its loudness measure in dB, for evening out the volume. */
  loudness?: number | null;
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
  // Instagram's oEmbed needs a Facebook app token, but its embed page (what the embed player loads)
  // has the reel's video file, so the dashboard can play it itself and even out its loudness. Without
  // it (a photo, or Instagram refusing the server) the embed player still works.
  async instagram(ref) {
    try {
      const html = await embedPage(`https://www.instagram.com/p/${encodeURIComponent(ref.id)}/embed/`);
      if (html === null) return EMPTY;
      const found = parseInstagramEmbed(html);
      return { ...EMPTY, ...found, mediaUrl: found.mediaUrl && (await videoHost(found.mediaUrl)) };
    } catch {
      return EMPTY;
    }
  },

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
      const [o, page] = await Promise.all([
        oembed(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`),
        videoPage(ref.id),
      ]);
      return {
        ...EMPTY,
        title: o.title ?? null,
        author: o.author_name ?? null,
        thumbnail: ytThumb(ref.id),
        duration: page.duration,
        loudness: page.loudness,
      };
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
    const [res, mediaUrl] = await Promise.all([
      getJson<{ data?: { clip: TwitchClip | null } }>(TWITCH_GQL, { method: "POST", body, headers: TWITCH_HEADERS }),
      twitchFile(ref.id),
    ]);
    if (!res.data) return EMPTY;
    const c = res.data.clip;
    if (!c) return "not_found";
    return {
      ...EMPTY,
      title: c.title ?? null,
      thumbnail: c.thumbnailURL ?? null,
      author: c.broadcaster?.displayName ?? null,
      duration: c.durationSeconds ?? null,
      mediaUrl,
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

const TWITCH_GQL = "https://gql.twitch.tv/gql";
const TWITCH_HEADERS = { "client-id": "kimne78kx3ncx6brgo4mv6wki5h1ko", "content-type": "application/json" };

/**
 * The clip's MP4, so the dashboard can play it in its own player and even out its loudness (Twitch's
 * embed has no volume control). Twitch only hands it out with a playback token from its web player's
 * own query, the way twitch.tv does; the token lasts about a day. Best effort: null keeps the embed.
 */
async function twitchFile(slug: string): Promise<string | null> {
  try {
    const res = await getJson<{ data?: { clip: TwitchClipFile | null } }>(TWITCH_GQL, {
      method: "POST",
      headers: TWITCH_HEADERS,
      body: JSON.stringify({
        operationName: "VideoAccessToken_Clip",
        variables: { slug },
        extensions: { persistedQuery: { version: 1, sha256Hash: "36b89d2507fce29e5ca551df756d27c1cfe079e2609642b4390aa4c35796eb11" } },
      }),
    });
    const c = res.data?.clip;
    const files = c?.videoQualities ?? [];
    // 720p is plenty for the dashboard and lighter than 1080p.
    const file = files.find((q) => q.quality === "720") ?? files[0];
    const token = c?.playbackAccessToken;
    if (!file?.sourceURL || !token) return null;
    return `${file.sourceURL}?sig=${encodeURIComponent(token.signature)}&token=${encodeURIComponent(token.value)}`;
  } catch {
    return null;
  }
}

/**
 * A page as a browser loads it into an iframe. Instagram leaves the post data out unless the request
 * says it's an embedded page (`sec-fetch-mode: navigate`), and fetch() always sends "cors" there, so
 * this goes through node:https, which sends the headers as given. Null unless it answers 200.
 */
function embedPage(url: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "user-agent": BROWSER_UA,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          "sec-fetch-dest": "iframe",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "cross-site",
        },
        timeout: 6000,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(null);
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve(body));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

/**
 * Where an Instagram video is served to a page. Asked from another site (any Referer) its CDN first
 * redirects to another host, and that redirect has no CORS header, so the browser would refuse the
 * file; the host it redirects to allows any site. Follow it once here and hand the page that address.
 */
async function videoHost(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      redirect: "manual",
      headers: { referer: "https://example.com/", range: "bytes=0-0" },
      signal: AbortSignal.timeout(6000),
    });
    await res.body?.cancel();
    const to = res.headers.get("location");
    return res.status >= 300 && res.status < 400 && to?.startsWith("https://") ? to : url;
  } catch {
    return url;
  }
}

/**
 * The video file, poster, length and author from an Instagram embed page (a reel, a video post, or a
 * carousel: its first video). Its data sits in JSON escaped twice over. A photo has no video file.
 */
export function parseInstagramEmbed(html: string): Pick<ClipMeta, "mediaUrl" | "thumbnail" | "author" | "duration"> {
  const field = (name: string) => {
    const m = html.match(new RegExp(`"${name}\\\\*"\\s*:\\s*\\\\*"(.*?)\\\\*"`));
    return m ? unescapeJson(m[1]!) : null;
  };
  const video = field("video_url");
  const seconds = Number(html.match(/"video_duration\\*":([\d.]+)/)?.[1]);
  return {
    mediaUrl: video?.startsWith("https://") ? video : null,
    duration: video && seconds > 0 ? Math.round(seconds) : null,
    thumbnail: field("display_url"),
    author: html.match(/"owner\\*":\{[^}]*?"username\\*":\\*"([\w.]+)/)?.[1] ?? null,
  };
}

function unescapeJson(s: string): string {
  return s.replace(/\\+\//g, "/").replace(/\\+u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

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

interface TwitchClipFile {
  videoQualities?: { quality: string; sourceURL: string }[];
  playbackAccessToken?: { signature: string; value: string };
}

interface TwitchClip {
  title?: string;
  durationSeconds?: number;
  thumbnailURL?: string;
  broadcaster?: { displayName?: string };
}
