import type Hls from "hls.js";
import { useEffect, useRef, useState } from "react";
import type { QueueItem } from "../shared/types";

interface Props {
  item: QueueItem;
  /** Called when the clip finishes, for providers that report it. */
  onEnded: () => void;
}

/** One embed per provider. Keyed by item id by the caller, so every clip gets a fresh player. */
export function Player({ item, onEnded }: Props) {
  switch (item.provider) {
    case "kick":
      return item.mediaUrl ? <HlsVideo src={item.mediaUrl} onEnded={onEnded} /> : <KickLookup item={item} onEnded={onEnded} />;
    case "youtube":
      return <YouTube id={item.clipId} start={item.start ?? 0} onEnded={onEnded} />;
    case "twitch":
      return <Frame src={`https://clips.twitch.tv/embed?clip=${enc(item.clipId)}&parent=${location.hostname}&autoplay=true`} />;
    case "tiktok":
      return <TikTok id={item.clipId} onEnded={onEnded} />;
    case "instagram":
      return <Frame src={`https://www.instagram.com/p/${enc(item.clipId)}/embed/`} />;
    case "x":
      return <Frame src={`https://platform.twitter.com/embed/Tweet.html?id=${enc(item.clipId)}&theme=dark&dnt=true`} />;
    case "streamable":
      return <Frame src={`https://streamable.com/e/${enc(item.clipId)}?autoplay=1`} />;
  }
}

const enc = encodeURIComponent;

function Frame({ src }: { src: string }) {
  return (
    <iframe
      src={src}
      allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
      allowFullScreen
      referrerPolicy="strict-origin-when-cross-origin"
    />
  );
}

function Fallback({ item }: { item: QueueItem }) {
  return (
    <div className="player-fallback">
      <p>This clip can't be embedded.</p>
      <a className="btn btn-primary" href={item.url} target="_blank" rel="noreferrer">
        Open clip in a new tab
      </a>
    </div>
  );
}

/**
 * The server couldn't get this Kick clip's video URL (Kick's Cloudflare sometimes blocks hosting IPs).
 * Kick's API allows browser requests, so ask from here instead.
 */
function KickLookup({ item, onEnded }: Props) {
  const [src, setSrc] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch(`https://kick.com/api/v2/clips/${enc(item.clipId)}`, { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => !cancelled && setSrc(j?.clip?.video_url ?? j?.clip?.clip_url ?? null))
      .catch(() => !cancelled && setSrc(null));
    return () => {
      cancelled = true;
    };
  }, [item.clipId]);

  if (src === undefined) return <div className="player-fallback"><p>Loading clip…</p></div>;
  return src ? <HlsVideo src={src} onEnded={onEnded} /> : <Fallback item={item} />;
}

function HlsVideo({ src, onEnded }: { src: string; onEnded: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const ended = useLatest(onEnded);

  useEffect(() => {
    const video = ref.current!;
    let hls: Hls | null = null;
    let cancelled = false;
    const onEnd = () => ended.current();
    video.addEventListener("ended", onEnd);

    // hls.js wherever MSE exists. canPlayType() can't be trusted: some Chromium builds answer
    // "maybe" for HLS and then fail. Native playback is the fallback for iOS Safari.
    import("hls.js").then(({ default: HlsLib }) => {
      if (cancelled) return;
      if (HlsLib.isSupported()) {
        hls = new HlsLib({ enableWorker: true });
        hls.loadSource(src);
        hls.attachMedia(video);
      } else {
        video.src = src;
      }
      video.play().catch(() => {}); // autoplay can be refused until the page gets a click
    });
    return () => {
      cancelled = true;
      video.removeEventListener("ended", onEnd);
      hls?.destroy();
    };
  }, [src]);

  return <video ref={ref} controls autoPlay playsInline />;
}

// ---- YouTube (IFrame API, so we know when the video ends) -------------------------------------

declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytReady: Promise<any> | null = null;
function loadYouTube(): Promise<any> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  ytReady ??= new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
  });
  return ytReady;
}

function YouTube({ id, start, onEnded }: { id: string; start: number; onEnded: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const ended = useLatest(onEnded);

  useEffect(() => {
    let player: any = null;
    let cancelled = false;
    loadYouTube().then((YT) => {
      if (cancelled || !host.current) return;
      const el = document.createElement("div");
      host.current.replaceChildren(el);
      player = new YT.Player(el, {
        videoId: id,
        playerVars: { autoplay: 1, start, rel: 0, playsinline: 1 },
        events: {
          onStateChange: (e: { data: number }) => {
            if (e.data === YT.PlayerState.ENDED) ended.current();
          },
        },
      });
    });
    return () => {
      cancelled = true;
      player?.destroy?.();
    };
  }, [id, start]);

  return <div ref={host} className="yt-host" />;
}

// ---- TikTok (embed player v1 posts state changes) ---------------------------------------------

function TikTok({ id, onEnded }: { id: string; onEnded: () => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const ended = useLatest(onEnded);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== "https://www.tiktok.com" || e.source !== ref.current?.contentWindow) return;
      const d = typeof e.data === "string" ? safeJson(e.data) : e.data;
      if (d?.["x-tiktok-player"] && d.type === "onStateChange" && d.value === 0) ended.current();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <iframe
      ref={ref}
      src={`https://www.tiktok.com/player/v1/${enc(id)}?autoplay=1&rel=0&music_info=1&description=1`}
      allow="autoplay; encrypted-media; fullscreen"
      allowFullScreen
    />
  );
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** A ref that always holds the latest value, so effects don't re-run when a callback changes. */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
