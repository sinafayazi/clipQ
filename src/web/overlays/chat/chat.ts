import {
  CHAT_SETTINGS_MESSAGE,
  clampBgOpacity,
  clampFadeOutMs,
  clampFontSize,
  clampFontWeight,
  clampMaxMessages,
  clampMessageGap,
  ensureGoogleFontStylesheet,
  fontStack,
  parseFadeIn,
  parseFont,
  parseLayout,
  parseShowPfp,
  sanitizeBgColor,
  sanitizeGoogleFontFamily,
  type ChatLiveAppearance,
} from "../chat-settings";
import {
  connectChatroom,
  fetchOverlayMeta,
  loadSevenTv,
  makeStatusController,
  type SevenTvEmote,
  type SubscriberBadge,
} from "../shared";
import "./chat.css";

const params = new URLSearchParams(location.search);
let maxMessages = clampMaxMessages(Number(params.get("max") || 40));
let messageTtlMs = clampFadeOutMs(Number(params.get("ttl") || 35_000));
let showPfp = parseShowPfp(params.get("pfp"));
const messageFadeMs = 600;
const demoMode = ["1", "true", "yes", "on"].includes((params.get("demo") || "").toLowerCase());

const status = document.querySelector("#status") as HTMLElement;
const chat = document.querySelector("#chat") as HTMLElement;
const setStatus = makeStatusController(status);

function parseBgOpacityParam(raw: string | null): number {
  if (raw == null || raw === "") return 90; // legacy links with no bg param used a solid panel
  const lower = raw.toLowerCase();
  if (lower === "false" || lower === "off") return 0;
  if (lower === "true" || lower === "on") return 90;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 90;
  // Legacy: bg=0 transparent, bg=1 solid. Values > 1 are 0–100 opacity.
  if (n === 0) return 0;
  if (n === 1) return 90;
  return clampBgOpacity(n);
}

function applyLook(next: Partial<ChatLiveAppearance>) {
  const font = next.font != null ? parseFont(next.font) : undefined;
  const googleFamily =
    next.googleFontFamily != null ? sanitizeGoogleFontFamily(next.googleFontFamily) : undefined;

  if (next.layout != null) {
    chat.dataset.layout = parseLayout(next.layout);
  }
  if (font != null || googleFamily != null) {
    const resolvedFont = font ?? parseFont(params.get("font"));
    const resolvedFamily =
      googleFamily ??
      (resolvedFont === "custom" ? sanitizeGoogleFontFamily(params.get("ff")) : "");
    if (resolvedFont === "custom") ensureGoogleFontStylesheet(resolvedFamily);
    else ensureGoogleFontStylesheet("");
    chat.style.setProperty("--msg-font", fontStack(resolvedFont, resolvedFamily));
  }
  if (next.fontSize != null) {
    chat.style.setProperty("--msg-size", `${clampFontSize(next.fontSize)}px`);
  }
  if (next.fontWeight != null) {
    const weight = clampFontWeight(next.fontWeight);
    chat.style.setProperty("--msg-weight", String(weight));
    chat.style.setProperty("--msg-user-weight", String(Math.min(900, weight + 200)));
  }
  if (next.fadeOutMs != null) {
    messageTtlMs = clampFadeOutMs(next.fadeOutMs);
  }
  if (next.fadeIn != null) {
    chat.dataset.anim = parseFadeIn(next.fadeIn);
  }
  if (next.bgColor != null) {
    chat.style.setProperty("--bg-color", sanitizeBgColor(next.bgColor));
  }
  if (next.bgOpacity != null) {
    const opacity = clampBgOpacity(next.bgOpacity);
    chat.style.setProperty("--bg-opacity", String(opacity));
    chat.dataset.transparent = opacity === 0 ? "1" : "0";
  }
  if (next.showPfp != null) {
    showPfp = next.showPfp !== false;
    chat.dataset.pfp = showPfp ? "1" : "0";
  }
  if (next.messageGap != null) {
    chat.style.setProperty("--msg-gap", `${clampMessageGap(next.messageGap)}px`);
  }
  if (next.maxMessages != null) {
    maxMessages = clampMaxMessages(next.maxMessages);
  }
}

chat.style.setProperty("--fade-out-ms", `${messageFadeMs}ms`);
applyLook({
  layout: parseLayout(params.get("layout")),
  font: parseFont(params.get("font")),
  googleFontFamily: sanitizeGoogleFontFamily(params.get("ff")),
  fontSize: clampFontSize(Number(params.get("size") || 20)),
  fontWeight: clampFontWeight(Number(params.get("weight") || 600)),
  fadeOutMs: messageTtlMs,
  fadeIn: parseFadeIn(params.get("anim")),
  bgColor: sanitizeBgColor(params.get("bgc")),
  bgOpacity: parseBgOpacityParam(params.get("bg")),
  showPfp,
  messageGap: clampMessageGap(Number(params.get("gap") ?? 8)),
  maxMessages,
});

const emoteRe = /\[emote:(\d+):([^\]]+)\]/g;
const mentionRe = /@([A-Za-z0-9_]+)/g;

const globalBadgeBase = "https://www.kickdatabase.com/kickBadges";
/** Local replacements for Kick's default role badges. */
const localBadgeFile: Record<string, string> = {
  moderator: "/icons/Moderator.svg",
  vip: "/icons/VIP.svg",
  og: "/icons/OG.svg",
  broadcaster: "/icons/Broadcaster.svg",
  owner: "/icons/Broadcaster.svg",
  host: "/icons/Broadcaster.svg",
  verified: "/icons/Verified.svg",
  founder: "/icons/Founder.svg",
  kick_founder22: "/icons/Founder22.png",
};
/** Extra local badges for specific chatters. Keys are lowercase usernames. */
const extraUserBadges = new Map<string, { src: string; alt: string }[]>([
  ["kinkanexo", [{ src: "/icons/Foot.png", alt: "Foot" }]],
]);
const globalBadgeFile: Record<string, string> = {
  trainwreckstv: "trainwreckstv.svg",
  staff: "staff.svg",
  verified: "verified.svg",
  sidekick: "sidekick.svg",
  broadcaster: "broadcaster.svg",
  owner: "broadcaster.svg",
  host: "broadcaster.svg",
  moderator: "moderator.svg",
  vip: "vip.svg",
  og: "og.svg",
  founder: "founder.svg",
  subscriber: "subscriber.svg",
  sub_gifter: "subGifter.svg",
};

/** @type {Map<string, string>} lowercase username → solid hex color */
const userColors = new Map<string, string>();
/** lowercase slug → pending/resolved custom profile pic URL (empty string = none) */
const pfpCache = new Map<string, Promise<string>>();
let sevenTv = new Map<string, SevenTvEmote>();
let subBadges: SubscriberBadge[] = [];

function usernameOf(payload: any) {
  return payload?.sender?.username || payload?.username || "unknown";
}

function slugOf(payload: any) {
  const explicit = payload?.sender?.slug || payload?.sender?.channel_slug || payload?.slug || "";
  if (explicit) return String(explicit);
  // WS payloads sometimes omit slug — Kick channel slugs match username
  const username = usernameOf(payload);
  if (!username || username === "unknown") return "";
  return String(username).toLowerCase();
}

function identityOf(payload: any) {
  return payload?.sender?.identity || payload?.identity || {};
}

/** Kick placeholder avatars — treat as "no pfp". */
function isCustomPfp(url: string) {
  if (!url || typeof url !== "string") return false;
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return false;
  if (/\/default\d+-/i.test(u)) return false;
  if (/user-profile-pic\.png/i.test(u)) return false;
  return true;
}

// Every new chatter means a request to Kick, straight from OBS. A busy chat would fire dozens at
// once and Kick starts refusing (429), so they go out two at a time, everything waits a minute after
// a refusal, and a refused lookup isn't remembered: that chatter gets another try on a later message.
const PFP_PARALLEL = 2;
const PFP_BACKOFF_MS = 60_000;
let pfpActive = 0;
let pfpPausedUntil = 0;
const pfpWaiting: (() => void)[] = [];

async function pfpSlot<T>(run: () => Promise<T>): Promise<T> {
  if (pfpActive >= PFP_PARALLEL) await new Promise<void>((go) => pfpWaiting.push(go));
  pfpActive++;
  try {
    const wait = pfpPausedUntil - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return await run();
  } finally {
    pfpActive--;
    pfpWaiting.shift()?.();
  }
}

async function resolvePfp(slug: string): Promise<string> {
  const key = String(slug || "")
    .trim()
    .toLowerCase();
  if (!key) return "";
  const cached = pfpCache.get(key);
  if (cached) return cached;

  const pending = pfpSlot(async () => {
    try {
      const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(key)}`, {
        headers: { accept: "application/json" },
      });
      if (res.status === 429) {
        pfpPausedUntil = Date.now() + PFP_BACKOFF_MS;
        pfpCache.delete(key);
        return "";
      }
      if (!res.ok) return "";
      const data = await res.json();
      const pic = String(data?.user?.profile_pic || "");
      return isCustomPfp(pic) ? pic : "";
    } catch {
      pfpCache.delete(key); // network trouble: try again later
      return "";
    }
  });

  pfpCache.set(key, pending);
  return pending;
}

function rememberUserColor(username: string, identity: any) {
  const name = String(username || "").trim();
  if (!name || name === "unknown") return;
  const color = identity?.color || identity?.username_color || "";
  if (color) userColors.set(name.toLowerCase(), color);
}

function colorForUsername(name: string) {
  const key = String(name || "")
    .trim()
    .toLowerCase();
  return key ? userColors.get(key) || "" : "";
}

function gifterBadgeFile(count: number) {
  const n = Number(count) || 0;
  if (n >= 200) return "subGifter200.svg";
  if (n >= 100) return "subGifter100.svg";
  if (n >= 50) return "subGifter50.svg";
  if (n >= 25) return "subGifter25.svg";
  return "subGifter.svg";
}

function globalBadgeSrc(type: string, count?: number) {
  if (localBadgeFile[type]) return localBadgeFile[type];
  if (type === "sub_gifter") return `${globalBadgeBase}/${gifterBadgeFile(count ?? 0)}`;
  const file = globalBadgeFile[type];
  return file ? `${globalBadgeBase}/${file}` : "";
}

function subBadgeSrc(months: number) {
  if (!subBadges.length) return "";
  const m = Number(months) || 0;
  const hit = subBadges.find((b) => m >= b.months) || subBadges[subBadges.length - 1];
  return hit?.src || "";
}

function appendBadgeImg(parent: HTMLElement, src: string, alt: string) {
  if (!src) return;
  const img = document.createElement("img");
  img.className = "badge-img";
  img.src = src;
  img.alt = alt;
  img.title = alt;
  parent.append(img);
}

function ensureBadgesWrap(row: HTMLElement) {
  const head = row.querySelector(":scope > .msg-head") as HTMLElement | null;
  const scope = head ?? row;
  let wrap = scope.querySelector(":scope > .badges") as HTMLElement | null;
  if (wrap) return wrap;
  wrap = document.createElement("span");
  wrap.className = "badges";
  scope.prepend(wrap);
  return wrap;
}

function profilePicOf(payload: any): string {
  const sender = payload?.sender || payload || {};
  for (const key of ["profile_pic", "profile_picture", "profilePic", "avatar", "avatar_url"]) {
    const value = sender[key];
    if (typeof value === "string" && isCustomPfp(value)) return value.trim();
  }
  return "";
}

function initialOf(username: string) {
  const trimmed = String(username || "").trim();
  if (!trimmed) return "?";
  return [...trimmed][0]!.toLocaleUpperCase();
}

function setAvatarPic(avatar: HTMLElement, username: string, picUrl: string) {
  if (!picUrl || avatar.querySelector(".avatar-img")) return;
  avatar.textContent = "";
  avatar.classList.remove("is-letter");
  const img = document.createElement("img");
  img.className = "avatar-img";
  img.src = picUrl;
  img.alt = "";
  img.decoding = "async";
  img.addEventListener("error", () => {
    img.remove();
    avatar.textContent = initialOf(username);
    avatar.classList.add("is-letter");
  });
  avatar.append(img);
}

function appendAvatar(parent: HTMLElement, username: string, color: string, picUrl: string) {
  const avatar = document.createElement("span");
  avatar.className = "avatar";
  avatar.setAttribute("aria-hidden", "true");
  if (color) avatar.style.setProperty("--user-color", color);

  if (picUrl) setAvatarPic(avatar, username, picUrl);
  else {
    avatar.textContent = initialOf(username);
    avatar.classList.add("is-letter");
  }

  parent.append(avatar);
}

function prependPfpBadge(row: HTMLElement, src: string, username: string) {
  if (!src || !row.isConnected) return;
  const wrap = ensureBadgesWrap(row);
  if (wrap.querySelector(".badge-img.is-pfp")) return;
  const img = document.createElement("img");
  img.className = "badge-img is-pfp";
  img.src = src;
  img.alt = username || "avatar";
  img.title = username || "avatar";
  img.decoding = "async";
  img.addEventListener("error", () => img.remove());
  wrap.prepend(img);
}

function attachPfp(row: HTMLElement, payload: any) {
  if (!showPfp) return;
  const username = usernameOf(payload);
  const apply = (src: string) => {
    if (!showPfp || !src || !row.isConnected) return;
    const avatar = row.querySelector(":scope > .avatar") as HTMLElement | null;
    if (avatar) setAvatarPic(avatar, username, src);
    prependPfpBadge(row, src, username);
  };

  const fromPayload = profilePicOf(payload);
  if (fromPayload) {
    apply(fromPayload);
    return;
  }

  const slug = slugOf(payload);
  if (!slug) return;
  resolvePfp(slug).then(apply);
}

function appendV1Badge(wrap: HTMLElement, badge: any) {
  const type = String(badge?.type || "").toLowerCase();
  const label = badge.text || type;
  if (type === "subscriber") {
    const channelSrc = subBadgeSrc(badge.count);
    appendBadgeImg(wrap, channelSrc || globalBadgeSrc("subscriber"), badge.count ? `Sub ${badge.count}m` : "Subscriber");
    return;
  }
  const src = globalBadgeSrc(type, badge.count);
  if (src) appendBadgeImg(wrap, src, label);
}

function appendV2Badge(wrap: HTMLElement, badge: any) {
  const type = String(badge?.type || badge?.name || "").toLowerCase();
  const url = String(badge?.image_url || "");
  const local =
    type === "kick_founder22" || url.includes("kick_founder22") ? localBadgeFile.kick_founder22 : "";
  if (!local && !url) return;
  const level = badge.metadata?.level;
  const label = badge.name === "level" && level != null ? `Level ${level}` : badge.text || badge.name || "Badge";
  appendBadgeImg(wrap, local || url, label);
}

function appendBadges(parent: HTMLElement, badges: any, badgesV2: any) {
  const v1 = Array.isArray(badges) ? badges : [];
  // Chat sends all V2 badges; only selected ones are shown on Kick
  const v2 = (Array.isArray(badgesV2) ? badgesV2 : []).filter((b: any) => b && b.selected !== false && b.image_url);
  if (!v1.length && !v2.length) return;

  const wrap = document.createElement("span");
  wrap.className = "badges";

  const ordered = [
    ...v2.map((badge: any) => ({ kind: "v2" as const, badge })),
    ...v1.map((badge: any) => ({ kind: "v1" as const, badge })),
  ].sort((a, b) => (a.badge.sort_order ?? Infinity) - (b.badge.sort_order ?? Infinity));

  for (const item of ordered) {
    if (item.kind === "v2") appendV2Badge(wrap, item.badge);
    else appendV1Badge(wrap, item.badge);
  }

  if (wrap.childNodes.length) parent.append(wrap);
}

function appendExtraUserBadges(row: HTMLElement, username: string) {
  const extras = extraUserBadges.get(
    String(username || "")
      .trim()
      .toLowerCase(),
  );
  if (!extras?.length) return;
  const wrap = ensureBadgesWrap(row);
  for (const badge of extras) {
    appendBadgeImg(wrap, badge.src, badge.alt);
  }
}

function makeEmoteImg(src: string, name: string, zeroWidth: boolean) {
  const img = document.createElement("img");
  img.className = zeroWidth ? "emote is-zero-width" : "emote";
  img.src = src;
  img.alt = name;
  img.title = name;
  return img;
}

function appendEmote(parent: HTMLElement, src: string, name: string, zeroWidth: boolean) {
  if (zeroWidth) {
    while (parent.lastChild && parent.lastChild.nodeType === Node.TEXT_NODE && /^\s*$/.test(parent.lastChild.textContent || "")) {
      parent.lastChild.remove();
    }
    const last = parent.lastElementChild;
    if (last?.classList.contains("emote-stack")) {
      last.append(makeEmoteImg(src, name, true));
      return;
    }
    if (last?.classList.contains("emote") && !last.classList.contains("is-zero-width")) {
      const stack = document.createElement("span");
      stack.className = "emote-stack";
      last.replaceWith(stack);
      stack.append(last, makeEmoteImg(src, name, true));
      return;
    }
  }
  parent.append(makeEmoteImg(src, name, false));
}

function appendPlainOrMention(parent: HTMLElement, text: string) {
  let last = 0;
  mentionRe.lastIndex = 0;
  for (const match of text.matchAll(mentionRe)) {
    if (match.index! > last) parent.append(document.createTextNode(text.slice(last, match.index)));
    const username = match[1];
    const color = username ? colorForUsername(username) : undefined;
    if (color) {
      const span = document.createElement("span");
      span.className = "mention";
      span.style.color = color;
      span.textContent = match[0];
      parent.append(span);
    } else {
      parent.append(document.createTextNode(match[0]));
    }
    last = match.index! + match[0].length;
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}

function appendText(parent: HTMLElement, text: string) {
  for (const part of text.split(/(\s+)/)) {
    const entry = sevenTv.get(part);
    if (entry) appendEmote(parent, entry.src, part, entry.zeroWidth);
    else if (part) appendPlainOrMention(parent, part);
  }
}

function appendContent(parent: HTMLElement, content: unknown) {
  const text = String(content ?? "");
  let last = 0;
  emoteRe.lastIndex = 0;
  for (const match of text.matchAll(emoteRe)) {
    if (match.index! > last) appendText(parent, text.slice(last, match.index));
    const id = match[1];
    const name = match[2];
    if (id && name) appendEmote(parent, `https://files.kick.com/emotes/${id}/fullsize`, name, false);
    last = match.index! + match[0].length;
  }
  if (last < text.length) appendText(parent, text.slice(last));
}

type MsgEl = HTMLElement & { _fadeTimer?: number; _removeTimer?: number };

function clearMessageTimers(row: MsgEl) {
  clearTimeout(row._fadeTimer);
  clearTimeout(row._removeTimer);
  row._fadeTimer = undefined;
  row._removeTimer = undefined;
}

function removeMessage(row: Element | null) {
  if (!row || !(row as HTMLElement).isConnected) return;
  clearMessageTimers(row as MsgEl);
  row.remove();
}

function applyAppearance(next: Partial<ChatLiveAppearance>) {
  const prevMax = maxMessages;
  applyLook(next);
  if (next.maxMessages != null && maxMessages < prevMax) {
    while (chat.children.length > maxMessages) removeMessage(chat.firstElementChild);
  }
}

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== CHAT_SETTINGS_MESSAGE || typeof data.settings !== "object") return;
  applyAppearance(data.settings as ChatLiveAppearance);
});

function scheduleMessageExpiry(row: MsgEl) {
  clearMessageTimers(row);
  row._fadeTimer = window.setTimeout(() => {
    row.classList.add("is-fading");
    row._removeTimer = window.setTimeout(() => removeMessage(row), messageFadeMs);
  }, messageTtlMs);
}

function addMessage(payload: any) {
  const identity = identityOf(payload);
  const username = usernameOf(payload);
  const color = identity.color || identity.username_color || "";
  rememberUserColor(username, identity);

  const row = document.createElement("div") as MsgEl;
  row.className = "msg";
  if (color) row.style.setProperty("--user-color", color);

  appendAvatar(row, username, color, profilePicOf(payload));

  const head = document.createElement("span");
  head.className = "msg-head";
  appendBadges(head, identity.badges || payload?.sender?.badges || [], identity.badges_v2 || payload?.sender?.badges_v2 || []);

  const name = document.createElement("span");
  name.className = "user";
  name.textContent = username;
  if (color) name.style.color = color;
  head.append(name);

  const body = document.createElement("span");
  body.className = "body";
  body.dir = "auto";
  appendContent(body, payload.content ?? "");

  row.append(head, body);
  appendExtraUserBadges(row, username);
  chat.append(row);
  attachPfp(row, payload);
  scheduleMessageExpiry(row);

  while (chat.children.length > maxMessages) removeMessage(chat.firstElementChild);
}

async function loadSubBadgesFromKick(slug: string): Promise<SubscriberBadge[]> {
  try {
    const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.subscriber_badges || [])
      .map((b: any) => ({
        months: Number(b.months) || 0,
        src: String(b?.badge_image?.src || ""),
      }))
      .filter((b: SubscriberBadge) => b.src)
      .sort((a: SubscriberBadge, b: SubscriberBadge) => b.months - a.months);
  } catch {
    return [];
  }
}

const DEMO_LINES: { user: string; color: string; content: string; badges?: { type: string; text: string }[] }[] = [
  { user: "mira", color: "#53FC18", content: "first!", badges: [{ type: "subscriber", text: "Subscriber" }] },
  { user: "nox", color: "#FF9B3D", content: "clip that @mira", badges: [{ type: "vip", text: "VIP" }] },
  { user: "kira", color: "#7DD3FC", content: "LUL that was clean" },
  { user: "zane", color: "#F472B6", content: "ggs, queue next?", badges: [{ type: "moderator", text: "Moderator" }] },
  { user: "opal", color: "#FBBF24", content: "anyone got the song name?" },
  { user: "rex", color: "#38BDF8", content: "W stream" },
  { user: "june", color: "#34D399", content: "@zane already in queue" },
  { user: "ash", color: "#FB7185", content: "wait for the rematch" },
  { user: "nima", color: "#FB923C", content: "این کلیپ رو بنداز @mira", badges: [{ type: "vip", text: "VIP" }] },
  { user: "sara", color: "#A3E635", content: "خخخ عالی بود" },
  { user: "kaveh", color: "#E879F9", content: "جی‌جی، بعدی تو صف؟", badges: [{ type: "moderator", text: "Moderator" }] },
  { user: "negar", color: "#FACC15", content: "اسم آهنگو کسی داره؟" },
  { user: "radin", color: "#22D3EE", content: "استریم ترکوند" },
  { user: "hasti", color: "#2DD4BF", content: "@kaveh از قبل تو صفه" },
  { user: "pouya", color: "#F43F5E", content: "ریمچ رو صبر کنید" },
];

function runDemoChat() {
  setStatus("");
  let last = -1;
  const tick = () => {
    let i = Math.floor(Math.random() * DEMO_LINES.length);
    if (DEMO_LINES.length > 1 && i === last) i = (i + 1) % DEMO_LINES.length;
    last = i;
    const line = DEMO_LINES[i]!;
    addMessage({
      content: line.content,
      sender: {
        username: line.user,
        identity: {
          color: line.color,
          badges: line.badges || [],
        },
      },
    });
  };
  tick();
  window.setInterval(tick, 2200);
}

async function start() {
  if (demoMode) {
    runDemoChat();
    return;
  }
  try {
    const meta = await fetchOverlayMeta("chat");
    subBadges = Array.isArray(meta.subscriberBadges) ? meta.subscriberBadges : [];
    if (!subBadges.length && meta.slug) {
      subBadges = await loadSubBadgesFromKick(meta.slug);
    }
    sevenTv = await loadSevenTv(meta.kickUserId);
    connectChatroom(meta, addMessage, setStatus);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : "Can't load overlay");
  }
}

start();
