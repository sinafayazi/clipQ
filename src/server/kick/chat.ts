import { EventEmitter } from "node:events";

// Kick chat over its Pusher websocket. One shared connection carries every channel's chatroom.
// Read-only and unauthenticated; everything here is defensive because the format is undocumented.

export interface ChatMessage {
  id: string;
  chatroomId: number;
  content: string;
  sender: {
    id: number;
    username: string;
    color: string | null;
    badges: string[];
  };
}

export interface ChatEvents {
  message: [ChatMessage];
  /** A moderator deleted a message. */
  deleted: [{ chatroomId: number; messageId: string }];
  /** A user was banned or timed out. */
  banned: [{ chatroomId: number; userId: number }];
  status: [boolean];
}

export interface KickChatOptions {
  key: string;
  cluster: string;
  log?: Pick<Console, "info" | "warn">;
  /** Override for tests. */
  createSocket?: (url: string) => WebSocket;
}

const PONG_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;

export class KickChat extends EventEmitter<ChatEvents> {
  private ws: WebSocket | null = null;
  private connected = false;
  private stopped = true;
  private rooms = new Set<number>();
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private activityTimeoutMs = 120_000;
  /** Both chatroom channels can deliver the same event; drop repeats. */
  private recentIds = new RecentSet(2000);

  constructor(private readonly opts: KickChatOptions) {
    super();
  }

  get isConnected() {
    return this.connected;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
    this.setConnected(false);
  }

  join(chatroomId: number) {
    if (this.rooms.has(chatroomId)) return;
    this.rooms.add(chatroomId);
    if (this.connected) this.subscribe(chatroomId);
  }

  leave(chatroomId: number) {
    if (!this.rooms.delete(chatroomId)) return;
    if (!this.connected) return;
    for (const channel of channelNames(chatroomId)) this.send("pusher:unsubscribe", { channel });
  }

  private open() {
    const url = `wss://ws-${this.opts.cluster}.pusher.com/app/${this.opts.key}?protocol=7&client=js&version=8.5.0&flash=false`;
    let ws: WebSocket;
    try {
      ws = this.opts.createSocket ? this.opts.createSocket(url) : new WebSocket(url);
    } catch (err) {
      this.opts.log?.warn(`kick chat: connect failed: ${String(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener("message", (e) => {
      if (this.ws !== ws) return;
      this.onFrame(String(e.data));
    });
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setConnected(false);
      this.scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      // "close" always follows; reconnect happens there.
    });
  }

  private onFrame(raw: string) {
    this.bumpIdle();
    let frame: { event?: string; channel?: string; data?: unknown };
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    const data = parseData(frame.data);

    switch (frame.event) {
      case "pusher:connection_established": {
        const timeout = Number((data as { activity_timeout?: number } | null)?.activity_timeout);
        if (timeout > 0) this.activityTimeoutMs = timeout * 1000;
        this.attempt = 0;
        this.setConnected(true);
        for (const room of this.rooms) this.subscribe(room);
        this.bumpIdle();
        return;
      }
      case "pusher:ping":
        this.send("pusher:pong", {});
        return;
      case "pusher:pong":
        if (this.pongTimer) clearTimeout(this.pongTimer);
        this.pongTimer = null;
        return;
      case "pusher:error": {
        const code = Number((data as { code?: number } | null)?.code);
        this.opts.log?.warn(`kick chat: pusher error ${JSON.stringify(data)}`);
        // 4000-4099: don't reconnect with the same settings (bad key, app disabled).
        if (code >= 4000 && code < 4100) this.opts.log?.warn("kick chat: check PUSHER_KEY / PUSHER_CLUSTER");
        return;
      }
    }

    const chatroomId = chatroomFromChannel(frame.channel);
    if (chatroomId === null || !this.rooms.has(chatroomId) || !data) return;
    this.handleChatEvent(frame.event ?? "", chatroomId, data);
  }

  private handleChatEvent(event: string, chatroomId: number, data: any) {
    switch (event) {
      case "App\\Events\\ChatMessageEvent": {
        const id = typeof data.id === "string" ? data.id : null;
        const sender = data.sender;
        if (!id || typeof data.content !== "string" || !sender || typeof sender.id !== "number") return;
        if (!this.recentIds.add(`m:${id}`)) return;
        const badges: string[] = Array.isArray(sender.identity?.badges)
          ? sender.identity.badges.map((b: any) => String(b?.type ?? "")).filter(Boolean)
          : [];
        this.emit("message", {
          id,
          chatroomId,
          content: data.content,
          sender: {
            id: sender.id,
            username: String(sender.username ?? sender.slug ?? "unknown"),
            color: typeof sender.identity?.color === "string" ? sender.identity.color : null,
            badges,
          },
        });
        return;
      }
      case "App\\Events\\MessageDeletedEvent": {
        const messageId = data.message?.id;
        if (typeof messageId !== "string") return;
        if (!this.recentIds.add(`d:${messageId}`)) return;
        this.emit("deleted", { chatroomId, messageId });
        return;
      }
      case "App\\Events\\UserBannedEvent": {
        const userId = data.user?.id;
        if (typeof userId !== "number") return;
        if (!this.recentIds.add(`b:${data.id ?? userId}:${userId}`)) return;
        this.emit("banned", { chatroomId, userId });
        return;
      }
    }
  }

  private subscribe(chatroomId: number) {
    for (const channel of channelNames(chatroomId)) this.send("pusher:subscribe", { auth: "", channel });
  }

  private send(event: string, data: unknown) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ event, data }));
  }

  /** Pusher protocol: if the line is quiet for activity_timeout, ping; no pong in 30s means it's dead. */
  private bumpIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.send("pusher:ping", {});
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        this.opts.log?.warn("kick chat: no pong, reconnecting");
        this.ws?.close();
        // Some sockets never fire "close" on a dead link; force it.
        const ws = this.ws;
        this.ws = null;
        if (ws) {
          this.setConnected(false);
          this.scheduleReconnect();
        }
      }, PONG_TIMEOUT_MS);
    }, this.activityTimeoutMs);
  }

  private scheduleReconnect() {
    this.clearTimers();
    if (this.stopped) return;
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempt);
    const delay = base / 2 + Math.random() * (base / 2);
    this.attempt++;
    this.opts.log?.info(`kick chat: reconnecting in ${Math.round(delay)}ms`);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private clearTimers() {
    for (const t of [this.reconnectTimer, this.idleTimer, this.pongTimer]) if (t) clearTimeout(t);
    this.reconnectTimer = this.idleTimer = this.pongTimer = null;
  }

  private setConnected(value: boolean) {
    if (this.connected === value) return;
    this.connected = value;
    this.emit("status", value);
  }
}

function channelNames(chatroomId: number) {
  return [`chatrooms.${chatroomId}.v2`, `chatroom_${chatroomId}`];
}

function chatroomFromChannel(channel: string | undefined): number | null {
  const m = channel?.match(/^chatrooms?[._](\d+)(?:\.v2)?$/);
  return m ? Number(m[1]) : null;
}

/** Pusher double-encodes event data as a JSON string. */
function parseData(data: unknown): unknown {
  if (typeof data !== "string") return data ?? null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/** Fixed-size set of recently seen keys. add() returns false if the key was already there. */
export class RecentSet {
  private items = new Set<string>();
  constructor(private readonly max: number) {}
  add(key: string): boolean {
    if (this.items.has(key)) return false;
    this.items.add(key);
    if (this.items.size > this.max) this.items.delete(this.items.values().next().value!);
    return true;
  }
  has(key: string) {
    return this.items.has(key);
  }
}
