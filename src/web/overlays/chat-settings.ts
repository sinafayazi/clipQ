/** Appearance knobs for the chat OBS overlay (hub UI + query params). */

export type ChatFadeIn = "fade" | "slide" | "pop" | "none";
export type ChatPreviewSource = "fake" | "live";
export type ChatFontPreset = "jakarta" | "source" | "bricolage" | "inter" | "rubik" | "system";
export type ChatFont = ChatFontPreset | "custom";
/** Message composition for the OBS chat overlay. `classic` is the original inline look. */
export type ChatLayout = "classic" | "cards" | "portraits" | "stack" | "stripe";

export interface ChatOverlaySettings {
  /** Preview-only: inject sample messages instead of Kick chat. */
  preview: ChatPreviewSource;
  /** How each message is composed on the overlay. */
  layout: ChatLayout;
  font: ChatFont;
  /** Pasted Google Fonts CSS / specimen / share URL (hub field only). */
  googleFontLink: string;
  /** Parsed family name applied when font is `custom`. */
  googleFontFamily: string;
  /** Message username/body size in px. */
  fontSize: number;
  /** Body weight; username sits two steps heavier. */
  fontWeight: number;
  /** How long a message stays before fading out (ms). */
  fadeOutMs: number;
  fadeIn: ChatFadeIn;
  /** Panel / plate color (hex). Used by the full chat panel and card-style plates. */
  bgColor: string;
  /** Panel opacity 0–100. 0 = fully transparent for OBS. */
  bgOpacity: number;
  /** Show chatter profile pictures (badge or portraits avatar). */
  showPfp: boolean;
  /** Vertical space between messages in px. */
  messageGap: number;
  maxMessages: number;
}

export const DEFAULT_CHAT_SETTINGS: ChatOverlaySettings = {
  preview: "fake",
  layout: "classic",
  font: "jakarta",
  googleFontLink: "",
  googleFontFamily: "",
  fontSize: 20,
  fontWeight: 600,
  fadeOutMs: 35_000,
  fadeIn: "fade",
  bgColor: "#000000",
  bgOpacity: 0,
  showPfp: true,
  messageGap: 8,
  maxMessages: 40,
};

export const LAYOUT_OPTIONS: { id: ChatLayout; label: string; hint: string }[] = [
  { id: "classic", label: "Classic", hint: "Inline badges and name — the current look." },
  { id: "cards", label: "Cards", hint: "Each line sits on its own dark plate." },
  { id: "portraits", label: "Portraits", hint: "Large avatar beside name and message." },
  { id: "stack", label: "Stack", hint: "Name on top, message underneath." },
  { id: "stripe", label: "Stripe", hint: "User-color edge on a soft plate." },
];

const LAYOUT_IDS = new Set<string>(LAYOUT_OPTIONS.map((l) => l.id));

export const FADE_IN_OPTIONS: { id: ChatFadeIn; label: string }[] = [
  { id: "fade", label: "Fade" },
  { id: "slide", label: "Slide up" },
  { id: "pop", label: "Pop" },
  { id: "none", label: "None" },
];

export const FONT_OPTIONS: { id: ChatFontPreset; label: string; stack: string }[] = [
  { id: "jakarta", label: "Jakarta", stack: '"Plus Jakarta Sans", sans-serif' },
  { id: "source", label: "Source Sans", stack: '"Source Sans 3", sans-serif' },
  { id: "bricolage", label: "Bricolage", stack: '"Bricolage Grotesque", sans-serif' },
  { id: "inter", label: "Inter", stack: "Inter, sans-serif" },
  { id: "rubik", label: "Rubik", stack: "Rubik, sans-serif" },
  { id: "system", label: "System", stack: 'system-ui, "Segoe UI", sans-serif' },
];

const FONT_IDS = new Set<string>([...FONT_OPTIONS.map((f) => f.id), "custom"]);
const GOOGLE_FONT_LINK_ID = "clipq-google-font";

const STORAGE_KEY = "clipq-overlay-chat";

export function clampFontSize(n: number) {
  return Math.min(48, Math.max(12, Math.round(n) || DEFAULT_CHAT_SETTINGS.fontSize));
}

export function clampFontWeight(n: number) {
  const stepped = Math.round((Number(n) || DEFAULT_CHAT_SETTINGS.fontWeight) / 100) * 100;
  return Math.min(900, Math.max(400, stepped));
}

export function clampFadeOutMs(n: number) {
  return Math.min(120_000, Math.max(2_000, Math.round(n) || DEFAULT_CHAT_SETTINGS.fadeOutMs));
}

export function clampMaxMessages(n: number) {
  return Math.min(100, Math.max(5, Math.round(n) || DEFAULT_CHAT_SETTINGS.maxMessages));
}

export function clampMessageGap(n: number) {
  if (!Number.isFinite(n)) return DEFAULT_CHAT_SETTINGS.messageGap;
  return Math.min(48, Math.max(0, Math.round(n)));
}

export function clampBgOpacity(n: number) {
  return Math.min(100, Math.max(0, Math.round(n)));
}

/** Normalize to `#rrggbb`, or fall back to the default black. */
export function sanitizeBgColor(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_CHAT_SETTINGS.bgColor;
  const s = String(raw)
    .trim()
    .replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(s)) return `#${s.toLowerCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    const [a, b, c] = s.toLowerCase();
    return `#${a}${a}${b}${b}${c}${c}`;
  }
  return DEFAULT_CHAT_SETTINGS.bgColor;
}

export function parseFadeIn(raw: string | null): ChatFadeIn {
  if (raw === "slide" || raw === "pop" || raw === "none" || raw === "fade") return raw;
  return DEFAULT_CHAT_SETTINGS.fadeIn;
}

export function parseFont(raw: string | null): ChatFont {
  if (raw && FONT_IDS.has(raw)) return raw as ChatFont;
  return DEFAULT_CHAT_SETTINGS.font;
}

export function parseLayout(raw: string | null): ChatLayout {
  if (raw && LAYOUT_IDS.has(raw)) return raw as ChatLayout;
  return DEFAULT_CHAT_SETTINGS.layout;
}

/** Query/UI flag: default on. `0` / `false` / `off` disable. */
export function parseShowPfp(raw: string | null | undefined): boolean {
  if (raw == null || raw === "") return DEFAULT_CHAT_SETTINGS.showPfp;
  const lower = String(raw).toLowerCase();
  if (lower === "0" || lower === "false" || lower === "off" || lower === "no") return false;
  if (lower === "1" || lower === "true" || lower === "on" || lower === "yes") return true;
  return DEFAULT_CHAT_SETTINGS.showPfp;
}

export function sanitizeGoogleFontFamily(raw: string | null | undefined): string {
  if (!raw) return "";
  const family = raw.trim().replace(/["']/g, "").slice(0, 80);
  if (!family || !/^[A-Za-z0-9][A-Za-z0-9 +-]*$/.test(family)) return "";
  return family;
}

/** CSS2 stylesheet URL covering common weights for a family. */
export function googleFontsCssUrl(family: string): string {
  const encoded = encodeURIComponent(family).replace(/%20/g, "+");
  return `https://fonts.googleapis.com/css2?family=${encoded}:wght@400..900&display=swap`;
}

function familyFromGoogleParam(raw: string): string {
  const namePart = raw.split(":")[0] ?? "";
  return sanitizeGoogleFontFamily(decodeURIComponent(namePart.replace(/\+/g, " ")));
}

/**
 * Accepts a Google Fonts CSS link, specimen/share URL, `<link href>`, or a bare family name.
 */
export function parseGoogleFontsInput(raw: string): { family: string; cssUrl: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const hrefMatch = trimmed.match(/href\s*=\s*["']([^"']+)["']/i);
  const candidate = (hrefMatch?.[1] ?? trimmed).trim();

  try {
    const u = new URL(candidate);

    if (u.hostname === "fonts.googleapis.com") {
      const families = u.searchParams.getAll("family");
      const family = families.length ? familyFromGoogleParam(families[0]!) : "";
      if (!family) return null;
      const cssUrl = /\/css2?\/?$/i.test(u.pathname) ? u.toString() : googleFontsCssUrl(family);
      return { family, cssUrl };
    }

    if (u.hostname === "fonts.google.com") {
      const specimen = u.pathname.match(/\/specimen\/([^/?#]+)/i);
      if (specimen) {
        const family = sanitizeGoogleFontFamily(decodeURIComponent(specimen[1]!.replace(/\+/g, " ")));
        if (!family) return null;
        return { family, cssUrl: googleFontsCssUrl(family) };
      }
      const sel = u.searchParams.get("selection.family");
      if (sel) {
        const family = familyFromGoogleParam(sel);
        if (!family) return null;
        return { family, cssUrl: googleFontsCssUrl(family) };
      }
    }
  } catch {
    // Not a URL — try bare family name below.
  }

  const bare = sanitizeGoogleFontFamily(candidate);
  if (bare && !/\s{2,}/.test(bare) && !/[/?#&=]/.test(bare)) {
    return { family: bare, cssUrl: googleFontsCssUrl(bare) };
  }
  return null;
}

export function fontStack(font: ChatFont, googleFontFamily = ""): string {
  if (font === "custom") {
    const family = sanitizeGoogleFontFamily(googleFontFamily);
    if (family) return `"${family}", sans-serif`;
    return FONT_OPTIONS[0]!.stack;
  }
  return FONT_OPTIONS.find((f) => f.id === font)?.stack ?? FONT_OPTIONS[0]!.stack;
}

/** Inject or refresh a Google Fonts stylesheet in the document head. */
export function ensureGoogleFontStylesheet(family: string, doc: Document = document) {
  const clean = sanitizeGoogleFontFamily(family);
  const existing = doc.getElementById(GOOGLE_FONT_LINK_ID);
  if (!clean) {
    existing?.remove();
    return;
  }
  const href = googleFontsCssUrl(clean);
  let link = existing as HTMLLinkElement | null;
  if (!link) {
    link = doc.createElement("link");
    link.id = GOOGLE_FONT_LINK_ID;
    link.rel = "stylesheet";
    doc.head.appendChild(link);
  }
  if (link.getAttribute("href") !== href) link.setAttribute("href", href);
}

/** Settings that go on the secret OBS link (never includes fake preview). */
export function chatObsQuery(settings: ChatOverlaySettings): string {
  const q = new URLSearchParams();
  q.set("bg", String(settings.bgOpacity));
  const bgColor = sanitizeBgColor(settings.bgColor);
  if (bgColor !== DEFAULT_CHAT_SETTINGS.bgColor) q.set("bgc", bgColor.slice(1));
  if (settings.layout !== DEFAULT_CHAT_SETTINGS.layout) q.set("layout", settings.layout);
  if (settings.font === "custom" && settings.googleFontFamily) {
    q.set("font", "custom");
    q.set("ff", settings.googleFontFamily);
  } else if (settings.font !== DEFAULT_CHAT_SETTINGS.font && settings.font !== "custom") {
    q.set("font", settings.font);
  }
  if (settings.fontSize !== DEFAULT_CHAT_SETTINGS.fontSize) q.set("size", String(settings.fontSize));
  if (settings.fontWeight !== DEFAULT_CHAT_SETTINGS.fontWeight) q.set("weight", String(settings.fontWeight));
  if (settings.fadeOutMs !== DEFAULT_CHAT_SETTINGS.fadeOutMs) q.set("ttl", String(settings.fadeOutMs));
  if (settings.fadeIn !== DEFAULT_CHAT_SETTINGS.fadeIn) q.set("anim", settings.fadeIn);
  if (settings.maxMessages !== DEFAULT_CHAT_SETTINGS.maxMessages) q.set("max", String(settings.maxMessages));
  if (settings.messageGap !== DEFAULT_CHAT_SETTINGS.messageGap) q.set("gap", String(settings.messageGap));
  if (!settings.showPfp) q.set("pfp", "0");
  const s = q.toString();
  return s ? `&${s}` : "";
}

/**
 * Stable preview iframe URL: only auth + demo mode.
 * Appearance is pushed live via postMessage so the chat does not reset.
 */
export function chatPreviewShellQuery(preview: ChatPreviewSource): string {
  return preview === "fake" ? "&demo=1" : "";
}

/** Live look updates from the overlays hub → chat iframe. */
export const CHAT_SETTINGS_MESSAGE = "clipq-chat-settings";

export interface ChatLiveAppearance {
  layout: ChatLayout;
  font: ChatFont;
  googleFontFamily: string;
  fontSize: number;
  fontWeight: number;
  fadeOutMs: number;
  fadeIn: ChatFadeIn;
  bgColor: string;
  bgOpacity: number;
  showPfp: boolean;
  messageGap: number;
  maxMessages: number;
}

export function chatLiveAppearance(settings: ChatOverlaySettings): ChatLiveAppearance {
  return {
    layout: parseLayout(settings.layout ?? null),
    font: parseFont(settings.font ?? null),
    googleFontFamily: settings.font === "custom" ? settings.googleFontFamily : "",
    fontSize: settings.fontSize,
    fontWeight: settings.fontWeight,
    fadeOutMs: settings.fadeOutMs,
    fadeIn: parseFadeIn(settings.fadeIn ?? null),
    bgColor: sanitizeBgColor(settings.bgColor),
    bgOpacity: settings.bgOpacity,
    showPfp: settings.showPfp !== false,
    messageGap: clampMessageGap(settings.messageGap),
    maxMessages: settings.maxMessages,
  };
}

/** @deprecated Prefer chatPreviewShellQuery + postMessage; kept for tests. */
export function chatPreviewQuery(settings: ChatOverlaySettings): string {
  const base = chatObsQuery(settings);
  if (settings.preview === "fake") return `${base}&demo=1`;
  return base;
}

export function withOverlayQuery(baseUrl: string, extra: string): string {
  if (!extra) return baseUrl;
  const join = baseUrl.includes("?") ? "" : "?";
  // baseUrl already has ?c=&k=; extra starts with &
  return `${baseUrl}${extra.startsWith("&") ? extra : `${join}${extra}`}`;
}

function pageOrigin(): string {
  return typeof location !== "undefined" ? location.origin : "http://localhost";
}

/**
 * Preview iframes must share the hub's origin. PUBLIC_URL may be `localhost` while the
 * page is opened on `127.0.0.1` (or the reverse); postMessage then never arrives.
 */
export function sameOriginOverlayUrl(absoluteUrl: string, origin: string = pageOrigin()): string {
  try {
    const u = new URL(absoluteUrl);
    return `${origin}${u.pathname}${u.search}${u.hash}`;
  } catch {
    return absoluteUrl;
  }
}

/** Target origin for postMessage into an overlay iframe src. */
export function overlayMessageOrigin(iframeSrc: string, fallback: string = pageOrigin()): string {
  try {
    return new URL(iframeSrc, fallback).origin;
  } catch {
    return fallback;
  }
}

function readBgOpacity(saved: Partial<ChatOverlaySettings> & { transparent?: boolean }): number {
  if (typeof saved.bgOpacity === "number") return clampBgOpacity(saved.bgOpacity);
  // Migrate older boolean toggle.
  if (saved.transparent === false) return 90;
  if (saved.transparent === true) return 0;
  return DEFAULT_CHAT_SETTINGS.bgOpacity;
}

export function loadChatSettings(): ChatOverlaySettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CHAT_SETTINGS };
    const saved = JSON.parse(raw) as Partial<ChatOverlaySettings> & { transparent?: boolean };
    const font = parseFont(saved.font ?? null);
    const googleFontFamily = sanitizeGoogleFontFamily(saved.googleFontFamily);
    const googleFontLink = typeof saved.googleFontLink === "string" ? saved.googleFontLink.slice(0, 500) : "";
    return {
      preview: saved.preview === "live" ? "live" : "fake",
      layout: parseLayout(saved.layout ?? null),
      font: font === "custom" && !googleFontFamily ? DEFAULT_CHAT_SETTINGS.font : font,
      googleFontLink,
      googleFontFamily,
      fontSize: clampFontSize(Number(saved.fontSize)),
      fontWeight: clampFontWeight(Number(saved.fontWeight)),
      fadeOutMs: clampFadeOutMs(Number(saved.fadeOutMs)),
      fadeIn: parseFadeIn(saved.fadeIn ?? null),
      bgColor: sanitizeBgColor(saved.bgColor),
      bgOpacity: readBgOpacity(saved),
      showPfp: saved.showPfp !== false,
      messageGap: clampMessageGap(
        saved.messageGap == null ? DEFAULT_CHAT_SETTINGS.messageGap : Number(saved.messageGap),
      ),
      maxMessages: clampMaxMessages(Number(saved.maxMessages)),
    };
  } catch {
    return { ...DEFAULT_CHAT_SETTINGS };
  }
}

export function saveChatSettings(settings: ChatOverlaySettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export type StreakPreviewSource = "fake" | "live";

export interface StreakOverlaySettings {
  /** Preview-only: inject sample streaks instead of Kick chat. */
  preview: StreakPreviewSource;
  /** How long a streak stays after chat stops repeating that emote (ms). */
  fadeOutMs: number;
  fadeIn: ChatFadeIn;
}

export const DEFAULT_STREAK_SETTINGS: StreakOverlaySettings = {
  preview: "fake",
  fadeOutMs: 20_000,
  fadeIn: "pop",
};

const STREAK_STORAGE_KEY = "clipq-overlay-streak";

export function loadStreakSettings(): StreakOverlaySettings {
  try {
    const raw = localStorage.getItem(STREAK_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STREAK_SETTINGS };
    const saved = JSON.parse(raw) as Partial<StreakOverlaySettings>;
    return {
      preview: saved.preview === "live" ? "live" : "fake",
      fadeOutMs: clampFadeOutMs(Number(saved.fadeOutMs) || DEFAULT_STREAK_SETTINGS.fadeOutMs),
      fadeIn:
        saved.fadeIn === "fade" || saved.fadeIn === "slide" || saved.fadeIn === "pop" || saved.fadeIn === "none"
          ? saved.fadeIn
          : DEFAULT_STREAK_SETTINGS.fadeIn,
    };
  } catch {
    return { ...DEFAULT_STREAK_SETTINGS };
  }
}

export function saveStreakSettings(settings: StreakOverlaySettings) {
  localStorage.setItem(STREAK_STORAGE_KEY, JSON.stringify(settings));
}

/** Settings that go on the secret OBS link (never includes fake preview). */
export function streakObsQuery(settings: StreakOverlaySettings): string {
  const q = new URLSearchParams();
  if (settings.fadeOutMs !== DEFAULT_STREAK_SETTINGS.fadeOutMs) q.set("ttl", String(settings.fadeOutMs));
  if (settings.fadeIn !== DEFAULT_STREAK_SETTINGS.fadeIn) q.set("anim", settings.fadeIn);
  const s = q.toString();
  return s ? `&${s}` : "";
}

/**
 * Stable preview iframe URL: only auth + demo mode.
 * Appearance is pushed live via postMessage so the streak does not reset.
 */
export function streakPreviewShellQuery(preview: StreakPreviewSource): string {
  return preview === "fake" ? "&demo=1" : "";
}

/** Live look updates from the overlays hub → streak iframe. */
export const STREAK_SETTINGS_MESSAGE = "clipq-streak-settings";

export interface StreakLiveAppearance {
  fadeOutMs: number;
  fadeIn: ChatFadeIn;
}

export function streakLiveAppearance(settings: StreakOverlaySettings): StreakLiveAppearance {
  return {
    fadeOutMs: settings.fadeOutMs,
    fadeIn: settings.fadeIn,
  };
}
