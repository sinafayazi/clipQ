/** Shared helpers for chat and emote-streak OBS overlays. */

export interface SubscriberBadge {
  months: number;
  src: string;
}

export interface OverlayMeta {
  chatroomId: number;
  slug: string;
  kickUserId: number;
  pusher: { key: string; cluster: string };
  /** Streamer-uploaded sub badges; empty when Kick is unreachable from the server. */
  subscriberBadges?: SubscriberBadge[];
}

export interface SevenTvEmote {
  src: string;
  zeroWidth: boolean;
}

const SEVEN_TV_ZERO_WIDTH = 1;

export function overlayAuthQuery(): string {
  const params = new URLSearchParams(location.search);
  return `c=${encodeURIComponent(params.get("c") ?? "")}&k=${encodeURIComponent(params.get("k") ?? "")}`;
}

/** `kind`: which overlay this page is; its link's key opens only that one. */
export async function fetchOverlayMeta(kind: "chat" | "streak"): Promise<OverlayMeta> {
  const res = await fetch(`/api/overlays/meta?${overlayAuthQuery()}&o=${kind}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : "Can't load overlay.");
  return body as OverlayMeta;
}

function sevenTvUrl(emote: any): string {
  const host = emote?.data?.host;
  if (!host?.url) return "";
  const files = host.files || [];
  const file = files.find((f: any) => f.name === "2x.webp") || files.find((f: any) => f.format === "WEBP") || files[0];
  if (!file) return "";
  const base = host.url.startsWith("//") ? `https:${host.url}` : host.url;
  return `${base}/${file.name}`;
}

function ingestSevenTvSet(data: any, into: Map<string, SevenTvEmote>) {
  for (const emote of data?.emotes || []) {
    const name = emote?.name;
    const src = sevenTvUrl(emote);
    if (!name || !src) continue;
    const flags = Number(emote?.flags) || 0;
    const dataFlags = Number(emote?.data?.flags) || 0;
    const zeroWidth = (flags & SEVEN_TV_ZERO_WIDTH) !== 0 || (dataFlags & 256) !== 0;
    into.set(name, { src, zeroWidth });
  }
}

/** Global 7TV set + this Kick user's channel set (when linked on 7TV). */
export async function loadSevenTv(kickUserId: number): Promise<Map<string, SevenTvEmote>> {
  const map = new Map<string, SevenTvEmote>();
  try {
    const global = await fetch("https://7tv.io/v3/emote-sets/global");
    if (global.ok) ingestSevenTvSet(await global.json(), map);
  } catch {
    // keep going — channel set may still load
  }
  try {
    const user = await fetch(`https://7tv.io/v3/users/kick/${kickUserId}`);
    if (user.ok) {
      const data = await user.json();
      if (data?.emote_set) ingestSevenTvSet(data.emote_set, map);
    }
  } catch {
    // channel has no 7TV link — global only
  }
  return map;
}

export function parseData(data: unknown): any {
  if (data == null) return null;
  if (typeof data === "object") return data;
  try {
    return JSON.parse(String(data));
  } catch {
    return data;
  }
}

export function isChatEvent(eventName: string, payload: any): boolean {
  const name = String(eventName).split("\\").pop();
  const type = payload && typeof payload === "object" ? payload.type : undefined;
  return name === "ChatMessageEvent" || type === "message" || type === "reply";
}

export type ChatHandler = (payload: any) => void;

/** Pusher websocket for one Kick chatroom. Reconnects until the page unloads. */
export function connectChatroom(
  meta: OverlayMeta,
  onMessage: ChatHandler,
  setStatus: (text: string) => void,
): { stop: () => void } {
  let socket: WebSocket | null = null;
  let pingTimer: number | undefined;
  let reconnectTimer: number | undefined;
  let stopped = false;
  const pusherUrl = `wss://ws-${meta.pusher.cluster}.pusher.com/app/${meta.pusher.key}?protocol=7&client=js&version=8.5.0&flash=false`;

  function subscribe(channel: string) {
    socket?.send(JSON.stringify({ event: "pusher:subscribe", data: { auth: "", channel } }));
  }

  function handleFrame(frame: any) {
    if (!frame || typeof frame !== "object" || !frame.event) return;

    if (frame.event === "pusher:connection_established") {
      setStatus("connected");
      subscribe(`chatrooms.${meta.chatroomId}.v2`);
      subscribe(`chatroom_${meta.chatroomId}`);
      return;
    }
    if (frame.event === "pusher:ping") {
      socket?.send(JSON.stringify({ event: "pusher:pong", data: {} }));
      return;
    }
    if (frame.event === "pusher:error") {
      setStatus("chat error");
      return;
    }
    if (frame.event === "pusher_internal:subscription_succeeded") {
      setStatus("listening");
      return;
    }
    if (String(frame.event).startsWith("pusher")) return;

    const payload = parseData(frame.data);
    if (!isChatEvent(frame.event, payload) || !payload || typeof payload !== "object") return;
    onMessage(payload);
  }

  function connect() {
    if (stopped) return;
    clearInterval(pingTimer);
    socket = new WebSocket(pusherUrl);

    socket.addEventListener("open", () => {
      pingTimer = window.setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ event: "pusher:ping", data: {} }));
        }
      }, 15_000);
    });

    socket.addEventListener("message", (message) => {
      handleFrame(parseData(message.data));
    });

    socket.addEventListener("close", () => {
      clearInterval(pingTimer);
      if (stopped) return;
      setStatus("reconnecting");
      reconnectTimer = window.setTimeout(connect, 3000);
    });
  }

  connect();

  return {
    stop() {
      stopped = true;
      clearInterval(pingTimer);
      clearTimeout(reconnectTimer);
      socket?.close();
      socket = null;
    },
  };
}

export function makeStatusController(el: HTMLElement) {
  let hideTimer: number | undefined;
  return (text: string) => {
    clearTimeout(hideTimer);
    el.textContent = text;
    el.classList.remove("is-hidden");
    if (text === "listening") {
      hideTimer = window.setTimeout(() => el.classList.add("is-hidden"), 2500);
    }
  };
}
