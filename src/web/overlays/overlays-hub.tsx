import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../api";
import { CopyLink } from "../CopyLink";
import { AlertIcon } from "../icons";
import "../styles.css";
import "./overlays-hub.css";
import {
  CHAT_SETTINGS_MESSAGE,
  DEFAULT_CHAT_SETTINGS,
  DEFAULT_STREAK_SETTINGS,
  FADE_IN_OPTIONS,
  FONT_OPTIONS,
  LAYOUT_OPTIONS,
  STREAK_SETTINGS_MESSAGE,
  chatLiveAppearance,
  chatObsQuery,
  chatPreviewShellQuery,
  clampBgOpacity,
  clampFadeOutMs,
  clampFontSize,
  clampFontWeight,
  clampMaxMessages,
  clampMessageGap,
  ensureGoogleFontStylesheet,
  fontStack,
  loadChatSettings,
  loadStreakSettings,
  overlayMessageOrigin,
  parseGoogleFontsInput,
  sameOriginOverlayUrl,
  sanitizeBgColor,
  saveChatSettings,
  saveStreakSettings,
  streakLiveAppearance,
  streakObsQuery,
  streakPreviewShellQuery,
  withOverlayQuery,
  type ChatFadeIn,
  type ChatFont,
  type ChatLayout,
  type ChatOverlaySettings,
  type ChatPreviewSource,
  type StreakOverlaySettings,
  type StreakPreviewSource,
} from "./chat-settings";

interface OverlaysInfo {
  chatUrl: string;
  streakUrl: string;
  chatroomId: number | null;
  slug: string;
}

type OverlayTab = "chat" | "streak";

const TAB_KEY = "clipq-overlay-tab";

function readTab(): OverlayTab {
  try {
    return localStorage.getItem(TAB_KEY) === "streak" ? "streak" : "chat";
  } catch {
    return "chat";
  }
}

function OverlaysHub() {
  const [info, setInfo] = useState<OverlaysInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chatroomDraft, setChatroomDraft] = useState("");
  const [tab, setTab] = useState<OverlayTab>(readTab);
  const [chat, setChat] = useState<ChatOverlaySettings>(loadChatSettings);
  const [streak, setStreak] = useState<StreakOverlaySettings>(loadStreakSettings);
  const chatFrameRef = useRef<HTMLIFrameElement>(null);
  const streakFrameRef = useRef<HTMLIFrameElement>(null);

  const load = () =>
    fetch("/api/overlays")
      .then(async (res) => {
        if (res.status === 401) {
          location.href = "/app/";
          return null;
        }
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Can't load overlays.");
        return body as OverlaysInfo;
      })
      .then((data) => {
        if (data) {
          setInfo(data);
          setError(null);
        }
      })
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    saveChatSettings(chat);
  }, [chat]);

  useEffect(() => {
    ensureGoogleFontStylesheet(chat.font === "custom" ? chat.googleFontFamily : "");
  }, [chat.font, chat.googleFontFamily]);

  useEffect(() => {
    saveStreakSettings(streak);
  }, [streak]);

  useEffect(() => {
    localStorage.setItem(TAB_KEY, tab);
  }, [tab]);

  const chatObsUrl = useMemo(
    () => (info ? withOverlayQuery(info.chatUrl, chatObsQuery(chat)) : ""),
    [info, chat],
  );
  /** Remount only when switching fake ↔ live (or auth URL changes). Same-origin for postMessage. */
  const chatPreviewUrl = useMemo(
    () =>
      info
        ? sameOriginOverlayUrl(withOverlayQuery(info.chatUrl, chatPreviewShellQuery(chat.preview)))
        : "",
    [info, chat.preview],
  );
  const streakObsUrl = useMemo(
    () => (info ? withOverlayQuery(info.streakUrl, streakObsQuery(streak)) : ""),
    [info, streak],
  );
  const streakPreviewUrl = useMemo(
    () =>
      info
        ? sameOriginOverlayUrl(withOverlayQuery(info.streakUrl, streakPreviewShellQuery(streak.preview)))
        : "",
    [info, streak.preview],
  );

  const pushChatAppearance = (settings: ChatOverlaySettings = chat) => {
    if (!chatPreviewUrl) return;
    chatFrameRef.current?.contentWindow?.postMessage(
      { type: CHAT_SETTINGS_MESSAGE, settings: chatLiveAppearance(settings) },
      overlayMessageOrigin(chatPreviewUrl),
    );
  };

  const pushStreakAppearance = (settings: StreakOverlaySettings = streak) => {
    if (!streakPreviewUrl) return;
    streakFrameRef.current?.contentWindow?.postMessage(
      { type: STREAK_SETTINGS_MESSAGE, settings: streakLiveAppearance(settings) },
      overlayMessageOrigin(streakPreviewUrl),
    );
  };

  useEffect(() => {
    pushChatAppearance(chat);
  }, [chat, chatPreviewUrl]);

  useEffect(() => {
    pushStreakAppearance(streak);
  }, [streak, streakPreviewUrl]);

  const patchChat = <K extends keyof ChatOverlaySettings>(key: K, value: ChatOverlaySettings[K]) =>
    setChat((prev) => ({ ...prev, [key]: value }));

  const patchStreak = <K extends keyof StreakOverlaySettings>(key: K, value: StreakOverlaySettings[K]) =>
    setStreak((prev) => ({ ...prev, [key]: value }));

  const saveChatroom = (e: FormEvent) => {
    e.preventDefault();
    const id = Number(chatroomDraft);
    if (!Number.isInteger(id) || id <= 0) {
      setError("Enter a numeric chatroom id.");
      return;
    }
    api
      .chatroom(id)
      .then(() => load())
      .catch((err: Error) => setError(err.message));
  };

  if (!info && !error) {
    return (
      <div className="overlays-hub overlays-loading">
        <p className="status-page" role="status">
          Loading overlays
        </p>
      </div>
    );
  }

  const title = tab === "chat" ? "Chat" : "Emote streak";
  const finding =
    tab === "chat"
      ? "Tune the look, then copy the secret link into OBS."
      : "Preview streaks, pick the enter animation, then copy the secret link into OBS.";

  return (
    <div className="app overlays-hub">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="overlays-topbar">
        <div className="brand">
          <span className="tally on" aria-hidden="true" />
          <div className="brand-text">
            <h1>Overlays</h1>
            <p className="channel">{info?.slug ?? "clipQ"}</p>
          </div>
        </div>
        <div className="overlays-topbar-end">
          <a className="btn btn-ghost" href="/app/">
            Dashboard
          </a>
        </div>
      </header>

      <div className="overlays-shell">
        <aside className="overlays-sidebar" aria-label="Overlay settings">
          <div className="overlays-sidebar-head">
            <p className="overlays-group">Browser sources</p>
            <nav className="overlays-nav" aria-label="Overlay">
              <button
                type="button"
                className="overlays-nav-item"
                aria-current={tab === "chat" ? "page" : undefined}
                onClick={() => setTab("chat")}
              >
                Chat
              </button>
              <button
                type="button"
                className="overlays-nav-item"
                aria-current={tab === "streak" ? "page" : undefined}
                onClick={() => setTab("streak")}
              >
                Emote streak
              </button>
            </nav>
          </div>

          <div className="overlays-sidebar-scroll">
            {error && (
              <p className="banner error" role="alert">
                <AlertIcon size={18} stroke={2} />
                <span>{error}</span>
              </p>
            )}

            {!info?.chatroomId && (
              <section className="overlays-setup">
                <h2>Chatroom needed</h2>
                <p className="settings-hint">
                  Kick didn't return a chatroom for this channel. Paste the numeric id so overlays can listen to chat.
                </p>
                <form className="row" onSubmit={saveChatroom}>
                  <div className="field">
                    <label htmlFor="chatroom-id">Chatroom id</label>
                    <input
                      id="chatroom-id"
                      name="chatroomId"
                      inputMode="numeric"
                      value={chatroomDraft}
                      onChange={(e) => setChatroomDraft(e.target.value)}
                      placeholder="e.g. 2168823"
                    />
                  </div>
                  <button className="btn btn-primary" type="submit">
                    Save chatroom
                  </button>
                </form>
              </section>
            )}

            {info && tab === "chat" && (
              <div className="overlays-controls">
                <fieldset className="overlays-fieldset">
                  <legend>Preview</legend>
                  <div className="overlays-segment" role="group" aria-label="Preview source">
                    {(
                      [
                        ["fake", "Fake chat"],
                        ["live", "Live chat"],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        className="overlays-segment-btn"
                        aria-pressed={chat.preview === id}
                        onClick={() => patchChat("preview", id as ChatPreviewSource)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="overlays-field-hint">
                    Fake chat fills the preview with sample lines. The OBS link always uses live Kick chat.
                  </p>
                </fieldset>

                <fieldset className="overlays-fieldset">
                  <legend>Layout</legend>
                  <div className="overlays-segment overlays-segment-wrap" role="group" aria-label="Chat layout">
                    {LAYOUT_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className="overlays-segment-btn"
                        aria-pressed={chat.layout === opt.id}
                        onClick={() => patchChat("layout", opt.id as ChatLayout)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <p className="overlays-field-hint">
                    {LAYOUT_OPTIONS.find((opt) => opt.id === chat.layout)?.hint}
                  </p>
                </fieldset>

                <fieldset className="overlays-fieldset">
                  <legend>Profile pics</legend>
                  <div className="overlays-segment" role="group" aria-label="Profile pictures">
                    {(
                      [
                        [true, "On"],
                        [false, "Off"],
                      ] as const
                    ).map(([on, label]) => (
                      <button
                        key={label}
                        type="button"
                        className="overlays-segment-btn"
                        aria-pressed={chat.showPfp === on}
                        onClick={() => patchChat("showPfp", on)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="overlays-field-hint">
                    {chat.showPfp
                      ? "Show chatter avatars from Kick (badge on most layouts, large disc on Portraits)."
                      : "Hide profile pictures on every layout."}
                  </p>
                </fieldset>

                <div className="field">
                  <label htmlFor="chat-font">Font</label>
                  <select
                    id="chat-font"
                    value={chat.font}
                    style={{ fontFamily: fontStack(chat.font, chat.googleFontFamily) }}
                    onChange={(e) => patchChat("font", e.target.value as ChatFont)}
                  >
                    {FONT_OPTIONS.map((opt) => (
                      <option key={opt.id} value={opt.id} style={{ fontFamily: opt.stack }}>
                        {opt.label}
                      </option>
                    ))}
                    <option value="custom">Google Fonts…</option>
                  </select>
                </div>

                {chat.font === "custom" ? (
                  <div className="field">
                    <label htmlFor="chat-google-font">Google Fonts link</label>
                    <input
                      id="chat-google-font"
                      type="url"
                      inputMode="url"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="Paste a Google Fonts CSS or specimen link"
                      value={chat.googleFontLink}
                      onChange={(e) => {
                        const link = e.target.value;
                        const parsed = parseGoogleFontsInput(link);
                        setChat((prev) => ({
                          ...prev,
                          font: "custom",
                          googleFontLink: link,
                          googleFontFamily: parsed?.family ?? "",
                        }));
                      }}
                    />
                    {chat.googleFontFamily ? (
                      <p
                        className="overlays-field-hint"
                        style={{ fontFamily: fontStack("custom", chat.googleFontFamily) }}
                      >
                        Using {chat.googleFontFamily}
                      </p>
                    ) : chat.googleFontLink.trim() ? (
                      <p className="overlays-field-hint">Couldn’t read a font from that link.</p>
                    ) : null}
                  </div>
                ) : null}

                <div className="overlays-field-grid">
                  <div className="field">
                    <label htmlFor="chat-font-size">Font size</label>
                    <div className="overlays-range">
                      <input
                        id="chat-font-size"
                        type="range"
                        min={12}
                        max={48}
                        step={1}
                        value={chat.fontSize}
                        onChange={(e) => patchChat("fontSize", clampFontSize(Number(e.target.value)))}
                      />
                      <output htmlFor="chat-font-size" aria-live="polite">
                        {chat.fontSize}px
                      </output>
                    </div>
                  </div>

                  <div className="field">
                    <label htmlFor="chat-font-weight">Font weight</label>
                    <div className="overlays-range">
                      <input
                        id="chat-font-weight"
                        type="range"
                        min={400}
                        max={900}
                        step={100}
                        value={chat.fontWeight}
                        onChange={(e) => patchChat("fontWeight", clampFontWeight(Number(e.target.value)))}
                      />
                      <output htmlFor="chat-font-weight" aria-live="polite">
                        {chat.fontWeight}
                      </output>
                    </div>
                  </div>

                  <div className="field">
                    <label htmlFor="chat-bg-color">Background</label>
                    <div className="overlays-color">
                      <input
                        id="chat-bg-color"
                        type="color"
                        value={sanitizeBgColor(chat.bgColor)}
                        onChange={(e) => patchChat("bgColor", sanitizeBgColor(e.target.value))}
                        aria-label="Background color"
                      />
                      <input
                        id="chat-bg-hex"
                        type="text"
                        spellCheck={false}
                        autoComplete="off"
                        maxLength={7}
                        defaultValue={sanitizeBgColor(chat.bgColor)}
                        key={sanitizeBgColor(chat.bgColor)}
                        onBlur={(e) => patchChat("bgColor", sanitizeBgColor(e.target.value))}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          e.currentTarget.blur();
                        }}
                        aria-label="Background hex color"
                      />
                    </div>
                    <div className="overlays-range" style={{ marginTop: 10 }}>
                      <input
                        id="chat-bg-opacity"
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={chat.bgOpacity}
                        onChange={(e) => patchChat("bgOpacity", clampBgOpacity(Number(e.target.value)))}
                        aria-label="Background opacity"
                      />
                      <output htmlFor="chat-bg-opacity" aria-live="polite">
                        {chat.bgOpacity}%
                      </output>
                    </div>
                    <p className="overlays-field-hint">
                      Color tints the full panel and Cards / Portraits / Stripe plates. Opacity 0% keeps the panel clear
                      for OBS.
                    </p>
                  </div>

                  <div className="field">
                    <label htmlFor="chat-fade-out">Fade out</label>
                    <div className="overlays-range">
                      <input
                        id="chat-fade-out"
                        type="range"
                        min={2}
                        max={120}
                        step={1}
                        value={Math.round(chat.fadeOutMs / 1000)}
                        onChange={(e) => patchChat("fadeOutMs", clampFadeOutMs(Number(e.target.value) * 1000))}
                      />
                      <output htmlFor="chat-fade-out" aria-live="polite">
                        {Math.round(chat.fadeOutMs / 1000)}s
                      </output>
                    </div>
                  </div>
                </div>

                <fieldset className="overlays-fieldset">
                  <legend>Fade in</legend>
                  <div className="overlays-segment overlays-segment-wrap" role="group" aria-label="Fade in animation">
                    {FADE_IN_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className="overlays-segment-btn"
                        aria-pressed={chat.fadeIn === opt.id}
                        onClick={() => patchChat("fadeIn", opt.id as ChatFadeIn)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </fieldset>

                <div className="overlays-field-grid">
                  <div className="field">
                    <label htmlFor="chat-gap">Space between</label>
                    <div className="overlays-range">
                      <input
                        id="chat-gap"
                        type="range"
                        min={0}
                        max={48}
                        step={1}
                        value={chat.messageGap}
                        onChange={(e) => patchChat("messageGap", clampMessageGap(Number(e.target.value)))}
                      />
                      <output htmlFor="chat-gap" aria-live="polite">
                        {chat.messageGap}px
                      </output>
                    </div>
                  </div>

                  <div className="field">
                    <label htmlFor="chat-max">Max messages</label>
                    <input
                      id="chat-max"
                      type="number"
                      min={5}
                      max={100}
                      value={chat.maxMessages}
                      onChange={(e) => patchChat("maxMessages", clampMaxMessages(Number(e.target.value)))}
                    />
                  </div>
                </div>

                <div className="overlays-link-block">
                  <p className="overlays-link-label">OBS link</p>
                  <CopyLink url={chatObsUrl} />
                  <button
                    type="button"
                    className="overlays-reset"
                    onClick={() => setChat({ ...DEFAULT_CHAT_SETTINGS })}
                  >
                    Reset chat look
                  </button>
                </div>
              </div>
            )}

            {info && tab === "streak" && (
              <div className="overlays-controls">
                <fieldset className="overlays-fieldset">
                  <legend>Preview</legend>
                  <div className="overlays-segment" role="group" aria-label="Preview source">
                    {(
                      [
                        ["fake", "Fake streak"],
                        ["live", "Live chat"],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        className="overlays-segment-btn"
                        aria-pressed={streak.preview === id}
                        onClick={() => patchStreak("preview", id as StreakPreviewSource)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="overlays-field-hint">
                    Fake streak cycles sample emotes. The OBS link always uses live Kick chat.
                  </p>
                </fieldset>

                <div className="field">
                  <label htmlFor="streak-fade-out">Hide after idle</label>
                  <div className="overlays-range">
                    <input
                      id="streak-fade-out"
                      type="range"
                      min={2}
                      max={120}
                      step={1}
                      value={Math.round(streak.fadeOutMs / 1000)}
                      onChange={(e) =>
                        patchStreak("fadeOutMs", clampFadeOutMs(Number(e.target.value) * 1000))
                      }
                    />
                    <output htmlFor="streak-fade-out" aria-live="polite">
                      {Math.round(streak.fadeOutMs / 1000)}s
                    </output>
                  </div>
                  <p className="overlays-field-hint">
                    How long the streak stays after chat stops repeating that emote. After it ends,
                    the overlay holds 3s then fades out.
                  </p>
                </div>

                <fieldset className="overlays-fieldset">
                  <legend>Fade in</legend>
                  <div className="overlays-segment overlays-segment-wrap" role="group" aria-label="Fade in animation">
                    {FADE_IN_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className="overlays-segment-btn"
                        aria-pressed={streak.fadeIn === opt.id}
                        onClick={() => patchStreak("fadeIn", opt.id as ChatFadeIn)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </fieldset>

                <div className="overlays-link-block">
                  <p className="overlays-link-label">OBS link</p>
                  <CopyLink url={streakObsUrl} />
                  <button
                    type="button"
                    className="overlays-reset"
                    onClick={() => setStreak({ ...DEFAULT_STREAK_SETTINGS })}
                  >
                    Reset streak look
                  </button>
                </div>
              </div>
            )}
          </div>
        </aside>

        <main id="main" className="overlays-canvas" tabIndex={-1}>
          {info && (
            <>
              <div className="overlays-title-row">
                <div>
                  <h2>{title}</h2>
                  <p className="sub">{finding}</p>
                </div>
              </div>

              {tab === "chat" && (
                <section
                  className="overlays-preview-pane"
                  aria-label="Chat overlay preview"
                >
                  <div className="overlays-preview-meta">
                    <span>Preview</span>
                    <span
                      className="overlays-preview-mode"
                      data-live={chat.preview === "live" ? "true" : undefined}
                    >
                      {chat.preview === "fake" ? "Fake chat" : "Live chat"}
                    </span>
                  </div>
                  <iframe
                    key={chatPreviewUrl}
                    ref={chatFrameRef}
                    className="overlay-preview overlay-preview-chat"
                    title="Chat overlay preview"
                    src={chatPreviewUrl}
                    onLoad={() => pushChatAppearance()}
                  />
                </section>
              )}

              {tab === "streak" && (
                <section
                  className="overlays-preview-pane"
                  aria-label="Emote streak overlay preview"
                >
                  <div className="overlays-preview-meta">
                    <span>Preview</span>
                    <span
                      className="overlays-preview-mode"
                      data-live={streak.preview === "live" ? "true" : undefined}
                    >
                      {streak.preview === "fake" ? "Fake streak" : "Live chat"}
                    </span>
                  </div>
                  <iframe
                    key={streakPreviewUrl}
                    ref={streakFrameRef}
                    className="overlay-preview overlay-preview-streak"
                    title="Emote streak overlay preview"
                    src={streakPreviewUrl}
                    onLoad={() => pushStreakAppearance()}
                  />
                </section>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<OverlaysHub />);
