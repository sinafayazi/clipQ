import type Hls from "hls.js";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { songVolume, type QueueItem } from "../shared/types";

interface Props {
  item: QueueItem;
  /** Called when the clip finishes, for providers that report it. */
  onEnded: () => void;
  /** clipQ's volume, 0–100, for Kick, Twitch, Instagram and YouTube; other embeds keep their own. */
  volume?: number;
  /** Even out loudness: quiet YouTube videos turned up (YouTube turns loud ones down), clips in our own player leveled both ways. */
  normalize?: boolean;
  /** Playing, paused, ended or gone (unmounted), for players that tell us (YouTube, Kick, TikTok). */
  onPlaying?: OnPlaying;
  /** A remote play/pause (a mod's `!sr pause`); acted on when `seq` changes. */
  control?: { seq: number; action: "play" | "pause" } | null;
  /** The other list is playing: refuse to (re)start, pausing again if someone presses play. */
  blocked?: boolean;
  /** Start on its own (default). False: load paused, someone has to press play. */
  autoplay?: boolean;
  /**
   * Its tab isn't showing. Players that take commands are paused through `control`; embeds that can't
   * be paused (X, Streamable, Instagram photos, Twitch's fallback) are taken off the page instead.
   */
  hidden?: boolean;
}

/** One embed per provider. Keyed by item id by the caller, so every clip gets a fresh player. */
export function Player({ item, onEnded, volume, normalize = false, onPlaying, blocked, autoplay = true, control, hidden = false }: Props) {
  const p = { onPlaying, blocked, autoplay, control, hidden };
  const auto = autoplay ? "1" : "0";
  switch (item.provider) {
    case "kick":
      return item.mediaUrl ? (
        <HlsVideo src={item.mediaUrl} onEnded={onEnded} volume={volume} normalize={normalize} {...p} />
      ) : (
        <KickLookup item={item} onEnded={onEnded} volume={volume} normalize={normalize} {...p} />
      );
    case "youtube":
      return (
        <YouTube
          id={item.clipId}
          start={item.start ?? 0}
          onEnded={onEnded}
          volume={volume === undefined ? undefined : songVolume(volume, item.loudness, normalize)}
          {...p}
        />
      );
    case "twitch":
      return <TwitchClip item={item} onEnded={onEnded} volume={volume} normalize={normalize} {...p} />;
    case "tiktok":
      return <TikTok id={item.clipId} onEnded={onEnded} {...p} />;
    case "instagram":
      return <InstagramClip item={item} onEnded={onEnded} volume={volume} normalize={normalize} {...p} />;
    case "x":
      return hidden ? null : <Frame src={`https://platform.twitter.com/embed/Tweet.html?id=${enc(item.clipId)}&theme=dark&dnt=true`} />;
    case "streamable":
      return hidden ? null : <Frame src={`https://streamable.com/e/${enc(item.clipId)}?autoplay=${auto}`} />;
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
function KickLookup({ item, onEnded, volume, normalize, onPlaying, blocked, autoplay, control }: Props) {
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
  return src ? (
    <HlsVideo src={src} onEnded={onEnded} volume={volume} normalize={normalize} onPlaying={onPlaying} blocked={blocked} autoplay={autoplay} control={control} />
  ) : (
    <Fallback item={item} />
  );
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

/**
 * Twitch's embed has no volume control, so a clip whose MP4 the server found plays in our own player
 * (with clipQ's volume and leveling). If the file won't load (its token expired), the embed takes over.
 */
function TwitchClip({ item, onEnded, volume, normalize, onPlaying, blocked, autoplay = true, control, hidden }: Props) {
  const [failed, setFailed] = useState(false);
  if (!item.mediaUrl || failed) {
    if (hidden) return null;
    // Twitch's embed starts muted when it autoplays unless it's told otherwise.
    return <Frame src={`https://clips.twitch.tv/embed?clip=${enc(item.clipId)}&parent=${location.hostname}&autoplay=${autoplay}&muted=false`} />;
  }
  return (
    <HlsVideo
      src={item.mediaUrl}
      file
      onError={() => setFailed(true)}
      onEnded={onEnded}
      volume={volume}
      normalize={normalize}
      onPlaying={onPlaying}
      blocked={blocked}
      autoplay={autoplay}
      control={control}
    />
  );
}

/**
 * Like Twitch: a reel whose video file the server found plays in our own player (Instagram's embed has
 * no volume control at all). Photos, and files that won't load (their link expires in a day or two), use the embed.
 */
function InstagramClip({ item, onEnded, volume, normalize, onPlaying, blocked, autoplay = true, control, hidden }: Props) {
  const [failed, setFailed] = useState(false);
  if (!item.mediaUrl || failed) return hidden ? null : <Instagram id={item.clipId} />;
  return (
    <HlsVideo
      src={item.mediaUrl}
      file
      onError={() => setFailed(true)}
      onEnded={onEnded}
      volume={volume}
      normalize={normalize}
      onPlaying={onPlaying}
      blocked={blocked}
      autoplay={autoplay}
      control={control}
    />
  );
}

/** Kick's HLS clips, or (`file`) a plain video file from a site that allows cross-site use (Twitch's and Instagram's MP4s). */
function HlsVideo({
  src,
  file = false,
  onError,
  onEnded,
  volume,
  normalize = false,
  onPlaying,
  blocked,
  autoplay = true,
  control,
}: { src: string; file?: boolean; onError?: () => void; onEnded: () => void; volume?: number; normalize?: boolean } & PlayState) {
  const ref = useRef<HTMLVideoElement>(null);
  const ended = useLatest(onEnded);
  const failed = useLatest(onError);
  const playing = useLatest(onPlaying);
  const block = useLatest(blocked);
  /** The audio can go through Web Audio: played via hls.js, or a file loaded with CORS. */
  const [measurable, setMeasurable] = useState(false);
  useLeveler(ref, measurable, volume, normalize);

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
    const onFail = () => failed.current?.();
    video.addEventListener("ended", onEnd);
    video.addEventListener("playing", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("error", onFail);

    if (file) {
      video.src = src; // crossOrigin is set on the element, so Web Audio may read it
      setMeasurable(true);
      if (autoplay) video.play().catch(() => {});
      return () => {
        video.removeEventListener("ended", onEnd);
        video.removeEventListener("playing", onPlay);
        video.removeEventListener("pause", onPause);
        video.removeEventListener("error", onFail);
        playing.current?.(false, "gone");
      };
    }

    // hls.js wherever MSE exists. canPlayType() can't be trusted: some Chromium builds answer
    // "maybe" for HLS and then fail. Native playback is the fallback for iOS Safari.
    import("hls.js").then(({ default: HlsLib }) => {
      if (cancelled) return;
      if (HlsLib.isSupported()) {
        hls = new HlsLib({ enableWorker: true });
        hls.loadSource(src);
        hls.attachMedia(video);
        setMeasurable(true);
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
      video.removeEventListener("error", onFail);
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

  return <video ref={ref} controls autoPlay={autoplay} playsInline crossOrigin={file ? "anonymous" : undefined} />;
}

// ---- Kick, Twitch and Instagram clip volume and leveling ----------------------------------------

// Like songs, a Kick, Twitch or Instagram clip's volume has layers. The video's own volume control is the
// streamer's level: clipQ never sets it, and keeps it for later clips. On top, through Web Audio, a
// gain multiplies in clipQ's slider and (with `normalize`) a leveler: none of them normalizes clips,
// so one is a whisper and the next a scream. The leveler measures the clip as it plays and pulls it toward TARGET_DB (down
// for loud clips, up for quiet ones); a limiter stops a boost from clipping.

/**
 * Level clips are pulled toward: average RMS in dBFS. YouTube plays everything at about -14 LUFS, which
 * for music and speech is an RMS of about -16 dBFS, so these clips land where YouTube videos do.
 */
const TARGET_DB = -16;
const MAX_BOOST_DB = 12;
const MAX_CUT_DB = 18;
/** Quieter than this is silence: not measured, so a pause doesn't get boosted. */
const SILENCE_DB = -50;
const KICK_VOLUME_KEY = "clipq-kick-volume";

let audioCtx: AudioContext | null = null;
/** A video can be given to Web Audio only once, so its source node is kept and reconnected after a remount. */
const sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();

/** The streamer's own clip volume (0–1) for clips in our own player, set with the video's volume control. Starts at 1. */
function kickVolume(): number {
  try {
    const raw = localStorage.getItem(KICK_VOLUME_KEY);
    const n = Number(raw);
    return raw !== null && n >= 0 && n <= 1 ? n : 1;
  } catch {
    return 1;
  }
}

/**
 * Applies clipQ's `volume` (0–100) and leveling to a Kick, Twitch or Instagram clip. Both need the audio to be
 * readable (`measurable`: played through hls.js, or a file loaded with CORS; anything else comes out of
 * Web Audio as silence) and the page's audio to be allowed (a click on the page). Until then the clip plays at the streamer's level only.
 */
function useLeveler(video: RefObject<HTMLVideoElement | null>, measurable: boolean, volume: number | undefined, normalize: boolean) {
  const gain = useRef<GainNode | null>(null);
  /** dB the leveler adds or takes away right now. */
  const level = useRef(0);
  const vol = useLatest(volume);
  const norm = useLatest(normalize);

  const apply = () => {
    if (!gain.current || !audioCtx) return;
    const scale = vol.current === undefined ? 1 : vol.current / 100;
    gain.current.gain.setTargetAtTime(scale * 10 ** (level.current / 20), audioCtx.currentTime, 0.25);
  };

  useEffect(apply, [volume]);

  // The streamer's level: restored on every clip, saved when they move the video's own control.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.volume = kickVolume();
    const save = () => {
      try {
        localStorage.setItem(KICK_VOLUME_KEY, String(v.volume));
      } catch {}
    };
    v.addEventListener("volumechange", save);
    return () => v.removeEventListener("volumechange", save);
  }, []);

  useEffect(() => {
    const v = video.current;
    if (!v || !measurable) return;
    let cancelled = false;
    let source: MediaElementAudioSourceNode | null = null;
    let timer: number | undefined;

    const connect = () => {
      if (cancelled || source || !audioCtx || audioCtx.state !== "running") return;
      source = sources.get(v) ?? audioCtx.createMediaElementSource(v);
      sources.set(v, source);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      const g = audioCtx.createGain();
      const limiter = audioCtx.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.15;
      source.connect(analyser);
      source.connect(g).connect(limiter).connect(audioCtx.destination);
      gain.current = g;
      apply();

      // Every 100 ms: the clip's loudness so far (quick to settle at first, then steady), and the gain
      // that brings it to the target. Web Audio hears the clip after the video's own volume, so that
      // is taken back out of the measure: the leveler mustn't undo the streamer's level.
      const buf = new Float32Array(analyser.fftSize);
      let avg: number | null = null;
      let samples = 0;
      timer = window.setInterval(() => {
        if (!norm.current) {
          if (level.current !== 0) {
            level.current = 0;
            apply();
          }
          return;
        }
        if (v.paused || v.muted || v.volume < 0.01) return;
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const x of buf) sum += x * x;
        const db = 10 * Math.log10(sum / buf.length + 1e-12) - 20 * Math.log10(v.volume);
        if (db < SILENCE_DB) return;
        samples++;
        const k = samples < 20 ? 0.3 : 0.04;
        avg = avg === null ? db : avg + k * (db - avg);
        level.current = Math.max(-MAX_CUT_DB, Math.min(MAX_BOOST_DB, TARGET_DB - avg));
        apply();
      }, 100);
    };

    // Web Audio starts suspended until the page gets a click; routing the clip through it before then
    // would mute it, so it waits for the first play or click.
    const wake = () => {
      if (source) return;
      audioCtx ??= new AudioContext();
      if (audioCtx.state === "running") connect();
      else audioCtx.resume().then(connect, () => {});
    };
    wake();
    v.addEventListener("play", wake);
    window.addEventListener("pointerdown", wake);
    return () => {
      cancelled = true;
      v.removeEventListener("play", wake);
      window.removeEventListener("pointerdown", wake);
      window.clearInterval(timer);
      source?.disconnect();
      gain.current = null;
      level.current = 0;
    };
  }, [measurable]);
}

// ---- YouTube (IFrame API, so we know when the video ends) -------------------------------------

/**
 * The streamer's own YouTube volume (0–100), set with the slider inside YouTube's player and kept
 * in this browser. Songs play at this × clipQ's volume. Starts at 100: clipQ's volume alone.
 */
const YT_VOLUME_KEY = "clipq-youtube-volume";

function youTubeVolume(): number {
  try {
    const n = Number(localStorage.getItem(YT_VOLUME_KEY));
    return localStorage.getItem(YT_VOLUME_KEY) !== null && n >= 0 && n <= 100 ? n : 100;
  } catch {
    return 100;
  }
}

function setYouTubeVolume(n: number) {
  try {
    localStorage.setItem(YT_VOLUME_KEY, String(Math.max(0, Math.min(100, Math.round(n)))));
  } catch {}
}

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
  /** What we last set on the player, to tell our changes apart from the streamer moving YouTube's slider. */
  const applied = useRef<{ value: number; at: number } | null>(null);

  /** Set the player to (the streamer's YouTube volume × clipQ's volume). */
  const apply = (player: any) => {
    if (vol.current === undefined || !player?.setVolume) return;
    const value = Math.max(0, Math.min(100, Math.round((youTubeVolume() * vol.current) / 100)));
    applied.current = { value, at: Date.now() };
    player.setVolume(value);
  };

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
            apply(player);
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
  useEffect(() => apply(ready.current), [volume]);

  // The streamer moving the volume inside YouTube's own player sets their YouTube volume: clipQ keeps
  // it (for later songs too) and only multiplies its own volume on top. Seen by polling, as the
  // IFrame API has no volume event.
  useEffect(() => {
    if (volume === undefined) return;
    const t = window.setInterval(() => {
      const p = ready.current;
      const last = applied.current;
      if (!p?.getVolume || !last || Date.now() - last.at < 1500 || !(vol.current! > 0)) return;
      const now = p.getVolume();
      if (typeof now !== "number" || Math.abs(now - last.value) < 1) return;
      setYouTubeVolume((now * 100) / vol.current!);
      applied.current = { value: now, at: Date.now() };
    }, 700);
    return () => window.clearInterval(t);
  }, [volume === undefined]);

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
 * leaves the next one paused; one that ended or was playing hands over to a playing one). A player in
 * a tab you aren't looking at (`visible` false) doesn't start on page load either, so nothing plays
 * where you can't see it; it only carries on from one that was playing. It never starts by itself
 * later. `track` must see the player's play/pause events.
 */
export function useAutoplay(itemId: number | null, otherPlaying: boolean, visible = true): { autoplay: boolean; track: OnPlaying } {
  const last = useRef<"playing" | "paused" | null>(null);
  const decided = useRef<{ id: number; auto: boolean } | null>(null);
  if (itemId !== null && decided.current?.id !== itemId) {
    const auto = !otherPlaying && last.current !== "paused" && (visible || last.current === "playing");
    decided.current = { id: itemId, auto };
    last.current = auto ? "playing" : "paused";
  }
  const track = useCallback<OnPlaying>((playing, why) => {
    if (why === "gone") return; // unmounting says nothing about how it was left
    last.current = playing || why === "ended" ? "playing" : "paused";
  }, []);
  return { autoplay: decided.current?.auto ?? true, track };
}

/**
 * The play/pause commands for one list's player: a mod's chat command (`server`), plus a pause when its
 * tab is switched away from (`hidden`), so nothing plays in a tab you aren't looking at. The command
 * that's already there when the dashboard opens is old news and isn't passed on.
 */
export function usePlayerControl(server: Props["control"], hidden: boolean): Props["control"] {
  const [control, setControl] = useState<Props["control"]>(null);
  const seq = useRef(0);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (server) setControl({ seq: ++seq.current, action: server.action });
  }, [server?.seq]);
  useEffect(() => {
    if (hidden) setControl({ seq: ++seq.current, action: "pause" });
  }, [hidden]);
  return control;
}

/** A ref that always holds the latest value, so effects don't re-run when a callback changes. */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
