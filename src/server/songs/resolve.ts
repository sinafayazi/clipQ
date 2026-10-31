import { parseClipUrl } from "../clips/parse.js";
import { getJson, HttpError } from "../http-client.js";

// Song requests: a YouTube link, a Spotify track link, or a search ("!sr never gonna give you up").
// Everything plays from YouTube. Spotify only gives us the song's name and artist, which we search.
// No API keys: YouTube's own web endpoints (the ones youtube.com uses) and Spotify's public track page.

export type SongQuery =
  | { type: "youtube"; id: string; start?: number }
  | { type: "spotify"; url: string }
  | { type: "search"; text: string };

export interface SongVideo {
  id: string;
  title: string;
  author: string | null;
  /** Seconds; null if YouTube didn't say. */
  duration: number | null;
  thumbnail: string;
  start: number | null;
}

export type SongReject = "not_found" | "too_long" | "unplayable" | "live";

export type SongResolved = { ok: true; video: SongVideo } | { ok: false; reason: SongReject };

const MAX_QUERY_LENGTH = 120;
/** Search results checked for one that can be embedded and isn't too long. */
const SEARCH_CANDIDATES = 6;

const INNERTUBE_CONTEXT = { client: { clientName: "WEB", clientVersion: "2.20250101.00.00", hl: "en" } };

/** What the viewer typed after `!sr`, or null if it's empty. */
export function parseSongQuery(raw: string): SongQuery | null {
  const text = raw.trim();
  if (!text) return null;
  const first = text.split(/\s+/)[0]!;
  const yt = parseClipUrl(first);
  if (yt?.provider === "youtube") return { type: "youtube", id: yt.id, ...(yt.start ? { start: yt.start } : {}) };
  const spotify = spotifyUrl(first);
  if (spotify) return { type: "spotify", url: spotify };
  // A link to anything else isn't a song name.
  if (/^(https?:\/\/|www\.)/i.test(first)) return null;
  return { type: "search", text: text.slice(0, MAX_QUERY_LENGTH) };
}

function spotifyUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host === "spotify.link") return u.pathname.length > 1 ? `https://spotify.link${u.pathname}` : null;
  if (host !== "open.spotify.com") return null;
  // /track/<id> or /intl-de/track/<id>
  const parts = u.pathname.split("/").filter(Boolean);
  const i = parts.indexOf("track");
  const id = i >= 0 ? parts[i + 1] : undefined;
  return id && /^[A-Za-z0-9]{10,40}$/.test(id) ? `https://open.spotify.com/track/${id}` : null;
}

/**
 * Find the video to play. `maxDuration` (seconds) only steers which search result is picked; the
 * queue makes the final call on length.
 */
export async function resolveSong(q: SongQuery, maxDuration: number): Promise<SongResolved> {
  try {
    switch (q.type) {
      case "youtube":
        return await byId(q.id, q.start ?? null);
      case "spotify": {
        const track = await spotifyTrack(q.url);
        if (!track) return { ok: false, reason: "not_found" };
        return await search(track.artist ? `${track.artist} - ${track.title}` : track.title, maxDuration);
      }
      case "search":
        return await search(q.text, maxDuration);
    }
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 400)) return { ok: false, reason: "not_found" };
    throw err;
  }
}

async function byId(id: string, start: number | null): Promise<SongResolved> {
  const embed = await embeddable(id);
  if (embed === "missing") return { ok: false, reason: "not_found" };
  if (embed === "blocked") return { ok: false, reason: "unplayable" };
  // The player endpoint knows the length; oEmbed doesn't. If it fails, keep the song without one.
  const details = await videoDetails(id).catch(() => null);
  if (details?.live) return { ok: false, reason: "live" };
  return {
    ok: true,
    video: {
      id,
      title: details?.title ?? embed.title,
      author: details?.author ?? embed.author,
      duration: details?.duration ?? null,
      thumbnail: thumb(id),
      start,
    },
  };
}

async function search(text: string, maxDuration: number): Promise<SongResolved> {
  const results = await youtubeSearch(text);
  if (!results.length) return { ok: false, reason: "not_found" };
  let tooLong = false;
  for (const r of results.slice(0, SEARCH_CANDIDATES)) {
    if (r.duration === null) continue; // live streams and premieres have no length
    if (r.duration > maxDuration) {
      tooLong = true;
      continue;
    }
    const embed = await embeddable(r.id);
    if (typeof embed === "string") continue;
    return { ok: true, video: { ...r, thumbnail: thumb(r.id), start: null } };
  }
  return { ok: false, reason: tooLong ? "too_long" : "unplayable" };
}

/** oEmbed answers 401/403 for videos that can't be embedded and 404 for missing ones. */
async function embeddable(id: string): Promise<{ title: string; author: string | null } | "blocked" | "missing"> {
  const watch = `https://www.youtube.com/watch?v=${id}`;
  try {
    const o = await getJson<{ title?: string; author_name?: string }>(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`,
    );
    return { title: o.title ?? "YouTube video", author: o.author_name ?? null };
  } catch (err) {
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) return "blocked";
    if (err instanceof HttpError && (err.status === 404 || err.status === 400)) return "missing";
    throw err;
  }
}

async function videoDetails(id: string): Promise<{ title: string; author: string | null; duration: number | null; live: boolean }> {
  const d = await getJson<{
    videoDetails?: { title?: string; author?: string; lengthSeconds?: string; isLive?: boolean; isLiveContent?: boolean };
  }>("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ context: INNERTUBE_CONTEXT, videoId: id }),
  });
  const v = d.videoDetails;
  if (!v) throw new Error("no videoDetails");
  const seconds = Number(v.lengthSeconds);
  return {
    title: v.title ?? "YouTube video",
    author: v.author ?? null,
    duration: seconds > 0 ? seconds : null,
    // A stream that's live now has no length; a finished stream (isLiveContent) plays like a video.
    live: v.isLive === true || (v.isLiveContent === true && !(seconds > 0)),
  };
}

interface SearchResult {
  id: string;
  title: string;
  author: string | null;
  duration: number | null;
}

async function youtubeSearch(text: string): Promise<SearchResult[]> {
  const d = await getJson<unknown>("https://www.youtube.com/youtubei/v1/search?prettyPrint=false", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // params: "videos only"
    body: JSON.stringify({ context: INNERTUBE_CONTEXT, query: text, params: "EgIQAQ%3D%3D" }),
  });
  const out: SearchResult[] = [];
  for (const v of findAll(d, "videoRenderer")) {
    const r = v as {
      videoId?: string;
      title?: { runs?: { text: string }[] };
      ownerText?: { runs?: { text: string }[] };
      lengthText?: { simpleText?: string };
    };
    if (!r.videoId) continue;
    out.push({
      id: r.videoId,
      title: r.title?.runs?.map((x) => x.text).join("") ?? "YouTube video",
      author: r.ownerText?.runs?.[0]?.text ?? null,
      duration: r.lengthText?.simpleText ? parseClock(r.lengthText.simpleText) : null,
    });
  }
  return out;
}

/** Every value under `key`, anywhere in a JSON tree, in document order. */
function* findAll(o: unknown, key: string): Generator<unknown> {
  if (Array.isArray(o)) for (const v of o) yield* findAll(v, key);
  else if (o && typeof o === "object") {
    for (const [k, v] of Object.entries(o)) {
      if (k === key) yield v;
      else yield* findAll(v, key);
    }
  }
}

/** "3:34" or "1:02:03" -> seconds. */
export function parseClock(s: string): number | null {
  const parts = s.trim().split(":").map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** Song name and artist from Spotify's public track page (its og: tags). */
async function spotifyTrack(url: string): Promise<{ title: string; artist: string | null } | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(6000), redirect: "follow" });
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpError(res.status, url);
  const html = await res.text();
  const meta = (p: string) => html.match(new RegExp(`<meta[^>]+(?:property|name)="${p}"[^>]+content="([^"]*)"`))?.[1];
  const title = meta("og:title");
  if (!title) return null;
  // "Rick Astley · Whenever You Need Somebody · Song · 1987"
  const artist = meta("music:musician_description") ?? meta("og:description")?.split(" · ")[0] ?? null;
  return { title: decode(title), artist: artist ? decode(artist) : null };
}

function decode(s: string) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function thumb(id: string) {
  return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
}
