import type Hls from "hls.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { QueueItem } from "../shared/types";

interface Props {
  item: QueueItem;
  /** Called when the clip finishes, for providers that report it. */
  onEnded: () => void;
  /** 0–100. Songs only (YouTube); clips keep the embed's own volume. */
  volume?: number;
  /** Playing, paused, ended or gone (unmounted), for players that tell us (YouTube, Kick, TikTok). */
  onPlaying?: OnPlaying;
  /** A remote play/pause (a mod's `!sr pause`); acted on when `seq` changes. */
  control?: { seq: number; action: "play" | "pause" } | null;
  /** The other list is playing: refuse to (re)start, pausing again if someone presses play. */
  blocked?: boolean;
  /** Start on its own (default). False: load paused, someone has to press play. */
  autoplay?: boolean;
}

/** One embed per provider. Keyed by item id by the caller, so every clip gets a fresh player. */
export function Player({ item, onEnded, volume, onPlaying, blocked, autoplay = true, control }: Props) {
  const p = { onPlaying, blocked, autoplay, control };
  const auto = autoplay ? "1" : "0";
  switch (item.provider) {
    case "kick":
      return item.mediaUrl ? <HlsVideo src={item.mediaUrl} onEnded={onEnded} {...p} /> : <KickLookup item={item} onEnded={onEnded} {...p} />;
    case "youtube":
      return <YouTube id={item.clipId} start={item.start ?? 0} onEnded={onEnded} volume={volume} {...p} />;
    case "twitch":
      return <Frame src={`https://clips.twitch.tv/embed?clip=${enc(item.clipId)}&parent=${location.hostname}&autoplay=${autoplay}`} />;
    case "tiktok":
      return <TikTok id={item.clipId} onEnded={onEnded} {...p} />;
    case "instagram":
      return <Instagram id={item.clipId} />;
    case "x":
      return <Frame src={`https://platform.twitter.com/embed/Tweet.html?id=${enc(item.clipId)}&theme=dark&dnt=true`} />;
    case "streamable":
      return <Frame src={`https://streamable.com/e/${enc(item.clipId)}?autoplay=${auto}`} />;
  }
}

const enc = encodeURIComponent;

// Instagram's embed page is a 54px header, the media, then ~154px of likes and comments. It's taller
// than the player, so it would scroll: size it so header and media fit, and crop the rest. The media's
// shape differs per post (reels 4:5, posts often 1:1), so we read it from the height the embed reports
// to its parent ("MEASURE") and refit; 4:5 until it says.
const IG_HEADER = 54;
const IG_FOOTER = 154;
const IG_DEFAULT_RATIO = 5 / 4;

function Instagram({ id }: { id: string }) {
  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [ratio, setRatio] = useState(IG_DEFAULT_RATIO);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const fit = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const f = frame.current;
      if (!f || e.source !== f.contentWindow || !/^https:\/\/www\.instagram\.com$/.test(e.origin)) return;
      const d = typeof e.data === "string" ? safeJson(e.data) : e.data;
      const height = d?.type === "MEASURE" ? Number(d.details?.height) : NaN;
      if (!(height > 0) || !(f.clientWidth > 0)) return;
      const r = (height - IG_HEADER - IG_FOOTER) / f.clientWidth;
      // Ignore nonsense (still loading, an error page); keep whatever we had.
      if (r >= 0.4 && r <= 2) setRatio((old) => (Math.abs(old - r) > 0.01 ? r : old));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const width = Math.floor(Math.min(box.w, (box.h - IG_HEADER) / ratio));
  const media = Math.round(width * ratio);
  return (
    <div ref={host} className="ig-host">
      {width > 0 && (
        <div className="ig-crop" style={{ width, height: IG_HEADER + media }}>
          <iframe
            ref={frame}
            src={`https://www.instagram.com/p/${enc(id)}/embed/`}
            style={{ width, height: IG_HEADER + media + IG_FOOTER }}
            scrolling="no"
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
            allowFullScreen
          />
        </div>
      )}
    </div>
  );
}

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
function KickLookup({ item, onEnded, onPlaying, blocked, autoplay, control }: Props) {
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
  return src ? <HlsVideo src={src} onEnded={onEnded} onPlaying={onPlaying} blocked={blocked} autoplay={autoplay} control={control} /> : <Fallback item={item} />;
}

export type OnPlaying = (playing: boolean, why?: "paused" | "ended" | "gone") => void;
type PlayState = { onPlaying?: OnPlaying; blocked?: boolean; autoplay?: boolean; control?: Props["control"] };

/** Runs `apply` for each new remote command (not for one already there when the player mounted). */
function useControl(control: Props["control"], apply: (action: "play" | "pause") => void) {
  const seen = useRef(control?.seq ?? 0);
  const run = useLatest(apply);
  useEffect(() => {
    if (!control || control.seq <= seen.current) return;
    seen.current = control.seq;
    run.current(control.action);
  }, [control?.seq]);
}

function HlsVideo({ src, onEnded, onPlaying, blocked, autoplay = true, control }: { src: string; onEnded: () => void } & PlayState) {
  const ref = useRef<HTMLVideoElement>(null);
  const ended = useLatest(onEnded);
  const playing = useLatest(onPlaying);
  const block = useLatest(blocked);

  useEffect(() => {
    const video = ref.current!;
    let hls: Hls | null = null;
    let cancelled = false;
    const onEnd = () => {
      playing.current?.(false, "ended");
      ended.current();
    };
    const onPlay = () => {
      if (block.current) video.pause();
      else playing.current?.(true);
    };
    const onPause = () => {
      if (!video.ended) playing.current?.(false, "paused");
    };
    video.addEventListener("ended", onEnd);
    video.addEventListener("playing", onPlay);
    video.addEventListener("pause", onPause);

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
      if (autoplay) video.play().catch(() => {}); // autoplay can be refused until the page gets a click
    });
    return () => {
      cancelled = true;
      video.removeEventListener("ended", onEnd);
      video.removeEventListener("playing", onPlay);
      video.removeEventListener("pause", onPause);
      hls?.destroy();
      playing.current?.(false, "gone");
    };
  }, [src]);

  useControl(control, (action) => {
    const video = ref.current;
    if (!video) return;
    if (action === "pause") video.pause();
    else video.play().catch(() => {});
  });

  return <video ref={ref} controls autoPlay={autoplay} playsInline />;
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

function YouTube({
  id,
  start,
  onEnded,
  volume,
  onPlaying,
  blocked,
  autoplay = true,
  control,
}: { id: string; start: number; onEnded: () => void; volume?: number } & PlayState) {
  const host = useRef<HTMLDivElement>(null);
  const ended = useLatest(onEnded);
  const playing = useLatest(onPlaying);
  const block = useLatest(blocked);
  const vol = useLatest(volume);
  const ready = useRef<any>(null);

  useEffect(() => {
    let player: any = null;
    let cancelled = false;
    loadYouTube().then((YT) => {
      if (cancelled || !host.current) return;
      const el = document.createElement("div");
      host.current.replaceChildren(el);
      player = new YT.Player(el, {
        videoId: id,
        playerVars: { autoplay: autoplay ? 1 : 0, start, rel: 0, playsinline: 1 },
        events: {
          onReady: () => {
            ready.current = player;
            if (vol.current !== undefined) player.setVolume(vol.current);
          },
          onStateChange: (e: { data: number }) => {
            if (e.data === YT.PlayerState.PLAYING) {
              // Pressing play while the other list is playing: back to pause.
              if (block.current) player.pauseVideo();
              else playing.current?.(true);
            } else if (e.data === YT.PlayerState.PAUSED) {
              playing.current?.(false, "paused");
            } else if (e.data === YT.PlayerState.ENDED) {
              playing.current?.(false, "ended");
            }
            if (e.data === YT.PlayerState.ENDED) ended.current();
          },
        },
      });
    });
    return () => {
      cancelled = true;
      ready.current = null;
      player?.destroy?.();
      playing.current?.(false, "gone");
    };
  }, [id, start]);

  useControl(control, (action) => (action === "pause" ? ready.current?.pauseVideo?.() : ready.current?.playVideo?.()));

  // Volume changes (a mod's !volume) apply to the running song without restarting it.
  useEffect(() => {
    if (volume !== undefined) ready.current?.setVolume?.(volume);
  }, [volume]);

  return <div ref={host} className="yt-host" />;
}

// ---- TikTok (embed player v1 posts state changes) ---------------------------------------------

function TikTok({ id, onEnded, onPlaying, autoplay = true, control }: { id: string; onEnded: () => void } & PlayState) {
  const ref = useRef<HTMLIFrameElement>(null);
  const ended = useLatest(onEnded);
  const playing = useLatest(onPlaying);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== "https://www.tiktok.com" || e.source !== ref.current?.contentWindow) return;
      const d = typeof e.data === "string" ? safeJson(e.data) : e.data;
      if (!d?.["x-tiktok-player"] || d.type !== "onStateChange") return;
      // 1 playing, 2 paused, 0 ended
      if (d.value === 1) playing.current?.(true);
      else if (d.value === 2) playing.current?.(false, "paused");
      else if (d.value === 0) playing.current?.(false, "ended");
      if (d.value === 0) ended.current();
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      playing.current?.(false, "gone");
    };
  }, []);

  useControl(control, (action) =>
    ref.current?.contentWindow?.postMessage({ "x-tiktok-player": true, type: action, value: null }, "https://www.tiktok.com"),
  );

  return (
    <iframe
      ref={ref}
      src={`https://www.tiktok.com/player/v1/${enc(id)}?autoplay=${autoplay ? 1 : 0}&rel=0&music_info=1&description=1`}
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

/**
 * Tells the server whether `itemId` is playing, and keeps repeating "playing" while it is, so the
 * other list knows to wait (and stops waiting if this page is closed). Returns the player callback.
 */
export function usePlayingReport(itemId: number | null, send: (id: number, playing: boolean) => Promise<unknown>, track?: OnPlaying): OnPlaying {
  const sendRef = useLatest(send);
  const state = useRef<{ id: number; playing: boolean } | null>(null);
  useEffect(() => {
    const t = window.setInterval(() => {
      const s = state.current;
      if (s?.playing) sendRef.current(s.id, true).catch(() => {});
    }, 5000);
    return () => window.clearInterval(t);
  }, []);
  const trackRef = useLatest(track);
  return useCallback<OnPlaying>(
    (playing, why) => {
      trackRef.current?.(playing, why);
      if (itemId === null) return;
      const was = state.current;
      if (was && was.id === itemId && was.playing === playing) return;
      state.current = { id: itemId, playing };
      sendRef.current(itemId, playing).catch(() => {});
    },
    [itemId],
  );
}

/**
 * Whether the player for `itemId` starts by itself, decided once when the item first shows up: not if
 * the other list is playing then, and not if the one before it was paused (skipping a paused clip
 * leaves the next one paused; one that ended or was playing hands over to a playing one). It never
 * starts by itself later. `track` must see the player's play/pause events.
 */
export function useAutoplay(itemId: number | null, otherPlaying: boolean): { autoplay: boolean; track: OnPlaying } {
  const last = useRef<"playing" | "paused" | null>(null);
  const decided = useRef<{ id: number; auto: boolean } | null>(null);
  if (itemId !== null && decided.current?.id !== itemId) {
    const auto = !otherPlaying && last.current !== "paused";
    decided.current = { id: itemId, auto };
    last.current = auto ? "playing" : "paused";
  }
  const track = useCallback<OnPlaying>((playing, why) => {
    if (why === "gone") return; // unmounting says nothing about how it was left
    last.current = playing || why === "ended" ? "playing" : "paused";
  }, []);
  return { autoplay: decided.current?.auto ?? true, track };
}

/** A ref that always holds the latest value, so effects don't re-run when a callback changes. */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
