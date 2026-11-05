import {
  clampFadeOutMs,
  DEFAULT_STREAK_SETTINGS,
  parseFadeIn,
  STREAK_SETTINGS_MESSAGE,
  type StreakLiveAppearance,
} from "../chat-settings";
import { connectChatroom, fetchOverlayMeta, loadSevenTv, makeStatusController, type SevenTvEmote } from "../shared";
import "./streak.css";

const params = new URLSearchParams(location.search);
const demoMode = ["1", "true", "yes", "on"].includes((params.get("demo") || "").toLowerCase());
let streakTtlMs = clampFadeOutMs(Number(params.get("ttl") || DEFAULT_STREAK_SETTINGS.fadeOutMs));
const streakFadeMs = 450;
/** Hold the final streak on screen after it ends, then fade out. */
const endHoldMs = 3_000;
const minStreak = 2;

function parseStreakFadeIn(raw: string | null) {
  if (raw == null || raw === "") return DEFAULT_STREAK_SETTINGS.fadeIn;
  return parseFadeIn(raw);
}

const status = document.querySelector("#status") as HTMLElement;
const streakEl = document.querySelector("#streak") as HTMLElement;
const streakStack = streakEl.querySelector(".emote-stack") as HTMLElement;
const streakCount = streakEl.querySelector(".count") as HTMLElement;
const setStatus = makeStatusController(status);

streakEl.style.setProperty("--fade-out-ms", `${streakFadeMs}ms`);
streakEl.dataset.anim = parseStreakFadeIn(params.get("anim"));

const emoteRe = /\[emote:(\d+):([^\]]+)\]/g;
let sevenTv = new Map<string, SevenTvEmote>();

type OverlayEmote = { name: string; src: string };
type FoundEmote = { key: string; name: string; src: string; zeroWidth: boolean };
type Streak = { key: string; name: string; src: string; overlays: OverlayEmote[]; count: number };

let streak: Streak | null = null;
let idleTimer: number | undefined;
let endHoldTimer: number | undefined;
let hideTimer: number | undefined;
let popTimer: number | undefined;
let enterTimer: number | undefined;

function makeEmoteImg(src: string, name: string, zeroWidth: boolean) {
  const img = document.createElement("img");
  img.className = zeroWidth ? "emote is-zero-width" : "emote";
  img.src = src;
  img.alt = name;
  return img;
}

function clearIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = undefined;
}

function clearEndHoldTimer() {
  clearTimeout(endHoldTimer);
  endHoldTimer = undefined;
}

function clearHideTimer() {
  clearTimeout(hideTimer);
  hideTimer = undefined;
}

function clearEnterTimer() {
  clearTimeout(enterTimer);
  enterTimer = undefined;
}

function applyLook(next: Partial<StreakLiveAppearance>) {
  if (next.fadeOutMs != null) {
    streakTtlMs = clampFadeOutMs(next.fadeOutMs);
    // Keep demo cycles snappy so end-hold + fade stay visible in the hub preview.
    if (demoMode) streakTtlMs = Math.min(streakTtlMs, 3_500);
  }
  if (next.fadeIn != null) streakEl.dataset.anim = parseStreakFadeIn(next.fadeIn);
}

function resetStreakState() {
  streak = null;
  clearIdleTimer();
  clearEndHoldTimer();
  clearHideTimer();
  clearEnterTimer();
  streakEl.classList.remove("is-visible", "is-leaving", "is-entering", "is-pop");
  streakEl.setAttribute("aria-hidden", "true");
  streakStack.replaceChildren();
  streakCount.textContent = "";
}

function scheduleIdleHide() {
  clearIdleTimer();
  clearEndHoldTimer();
  idleTimer = window.setTimeout(() => beginEndSequence(), streakTtlMs);
}

/** Streak ended: keep showing for endHoldMs, then run the fade-out animation. */
function beginEndSequence() {
  clearIdleTimer();
  if (!streakEl.classList.contains("is-visible") || streakEl.classList.contains("is-leaving")) {
    resetStreakState();
    return;
  }
  clearEndHoldTimer();
  endHoldTimer = window.setTimeout(() => startFadeOut(), endHoldMs);
}

function startFadeOut() {
  clearIdleTimer();
  clearEndHoldTimer();
  clearHideTimer();
  clearEnterTimer();
  streakEl.classList.remove("is-pop", "is-entering");
  streakEl.classList.add("is-leaving");
  streakEl.setAttribute("aria-hidden", "true");
  hideTimer = window.setTimeout(() => resetStreakState(), streakFadeMs);
}

/** Immediate fade when replacing a visible streak with a different emote. */
function fadeOutDisplay() {
  clearIdleTimer();
  clearEndHoldTimer();
  clearHideTimer();
  clearEnterTimer();
  streakEl.classList.remove("is-pop", "is-entering");
  if (streakEl.classList.contains("is-visible")) {
    streakEl.classList.add("is-leaving");
    streakEl.setAttribute("aria-hidden", "true");
  } else {
    streakEl.classList.remove("is-visible", "is-leaving");
    streakEl.setAttribute("aria-hidden", "true");
  }
}

function playEnterAnimation() {
  clearEnterTimer();
  streakEl.classList.remove("is-entering");
  void streakEl.offsetWidth;
  streakEl.classList.add("is-entering");
  enterTimer = window.setTimeout(() => streakEl.classList.remove("is-entering"), 320);
}

function renderStreak() {
  if (!streak || streak.count < minStreak) return;
  clearHideTimer();
  clearEndHoldTimer();
  const wasVisible = streakEl.classList.contains("is-visible") && !streakEl.classList.contains("is-leaving");
  streakStack.replaceChildren(
    makeEmoteImg(streak.src, streak.name, false),
    ...streak.overlays.map((o) => makeEmoteImg(o.src, o.name, true)),
  );
  streakCount.textContent = `X${streak.count}`;
  streakEl.classList.remove("is-leaving");
  streakEl.classList.add("is-visible");
  streakEl.setAttribute("aria-hidden", "false");
  if (!wasVisible) playEnterAnimation();
  streakEl.classList.remove("is-pop");
  void streakEl.offsetWidth;
  streakEl.classList.add("is-pop");
  clearTimeout(popTimer);
  popTimer = window.setTimeout(() => streakEl.classList.remove("is-pop"), 350);
  scheduleIdleHide();
}

function collectTextEmotes(chunk: string, found: FoundEmote[]) {
  for (const part of chunk.split(/(\s+)/)) {
    if (!part || /^\s+$/.test(part)) continue;
    const entry = sevenTv.get(part);
    if (!entry) continue;
    found.push({ key: `7tv:${part}`, name: part, src: entry.src, zeroWidth: entry.zeroWidth });
  }
  return true;
}

/**
 * A message counts toward a streak when its base emotes are all the same
 * (Kick or 7TV), optionally with 7TV zero-width overlays.
 */
function pureEmoteFromContent(content: unknown) {
  const text = String(content ?? "");
  if (!text.trim()) return null;

  const found: FoundEmote[] = [];
  let cursor = 0;
  emoteRe.lastIndex = 0;

  for (const match of text.matchAll(emoteRe)) {
    const before = text.slice(cursor, match.index);
    if (!collectTextEmotes(before, found)) return null;
    const id = match[1];
    const name = match[2];
    if (!id || !name) return null;
    found.push({
      key: `kick:${id}`,
      name,
      src: `https://files.kick.com/emotes/${id}/fullsize`,
      zeroWidth: false,
    });
    cursor = match.index! + match[0].length;
  }

  if (!collectTextEmotes(text.slice(cursor), found)) return null;
  if (!found.length) return null;

  const bases = found.filter((e) => !e.zeroWidth);
  const first = bases[0];
  if (!first) return null;
  if (bases.some((e) => e.key !== first.key)) return null;

  const overlays: OverlayEmote[] = [];
  let sawBase = false;
  for (const e of found) {
    if (e.zeroWidth) {
      if (!sawBase) return null;
      overlays.push({ name: e.name, src: e.src });
    } else {
      sawBase = true;
      overlays.length = 0;
    }
  }

  return { key: first.key, name: first.name, src: first.src, overlays };
}

function baseEmoteKeys(content: unknown) {
  const text = String(content ?? "");
  const keys: string[] = [];
  emoteRe.lastIndex = 0;
  for (const match of text.matchAll(emoteRe)) keys.push(`kick:${match[1]}`);
  for (const part of text.split(/\s+/)) {
    if (!part) continue;
    const entry = sevenTv.get(part);
    if (!entry || entry.zeroWidth) continue;
    keys.push(`7tv:${part}`);
  }
  return keys;
}

function onChatMessage(payload: any) {
  const content = payload.content ?? "";
  const emote = pureEmoteFromContent(content);

  if (!emote) {
    if (streak && baseEmoteKeys(content).some((key) => key !== streak!.key)) beginEndSequence();
    return;
  }

  if (streak && streak.key === emote.key) {
    streak.count += 1;
    streak.src = emote.src;
    streak.name = emote.name;
    streak.overlays = emote.overlays;
    renderStreak();
    return;
  }

  if (streakEl.classList.contains("is-visible") && !streakEl.classList.contains("is-leaving")) {
    fadeOutDisplay();
  } else {
    clearIdleTimer();
    clearEndHoldTimer();
    clearHideTimer();
  }

  streak = {
    key: emote.key,
    name: emote.name,
    src: emote.src,
    overlays: emote.overlays,
    count: 1,
  };
}

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== STREAK_SETTINGS_MESSAGE || typeof data.settings !== "object") return;
  applyLook(data.settings as StreakLiveAppearance);
});

const DEMO_EMOTES: { id: string; name: string }[] = [
  { id: "37226", name: "KEKW" },
  { id: "39286", name: "EZ" },
  { id: "37225", name: "LULW" },
  { id: "1730852", name: "catKiss" },
  { id: "37230", name: "OMEGALUL" },
];

function runDemoStreak() {
  setStatus("");
  let emoteIndex = 0;
  let count = 0;
  let target = 6;
  let phase: "build" | "hold" = "build";

  const tick = () => {
    if (phase === "hold") {
      phase = "build";
      count = 0;
      emoteIndex = (emoteIndex + 1) % DEMO_EMOTES.length;
      target = 4 + Math.floor(Math.random() * 8);
    }

    const emote = DEMO_EMOTES[emoteIndex]!;
    count += 1;
    onChatMessage({ content: `[emote:${emote.id}:${emote.name}]` });

    if (count >= target) {
      phase = "hold";
      // Pause long enough for idle TTL (clamped in demo) + end hold + fade.
      const pause = Math.min(streakTtlMs, 4_000) + endHoldMs + streakFadeMs + 800;
      window.setTimeout(tick, pause);
      return;
    }

    window.setTimeout(tick, 700 + Math.floor(Math.random() * 400));
  };

  // Short idle during demo so the end-hold + fade are visible sooner.
  streakTtlMs = Math.min(streakTtlMs, 3_500);
  tick();
}

async function start() {
  if (demoMode) {
    applyLook({ fadeIn: parseStreakFadeIn(params.get("anim")), fadeOutMs: streakTtlMs });
    runDemoStreak();
    return;
  }
  try {
    const meta = await fetchOverlayMeta("streak");
    sevenTv = await loadSevenTv(meta.kickUserId);
    connectChatroom(meta, onChatMessage, setStatus);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : "Can't load overlay");
  }
}

start();
