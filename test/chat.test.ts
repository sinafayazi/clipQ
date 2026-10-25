import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KickChat, type ChatMessage } from "../src/server/kick/chat.js";

/** Minimal stand-in for a browser WebSocket. */
class FakeSocket extends EventTarget {
  readyState = 0;
  sent: any[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  frame(event: string, data: unknown, channel?: string) {
    const e = new MessageEvent("message", { data: JSON.stringify({ event, channel, data: JSON.stringify(data) }) });
    this.dispatchEvent(e);
  }
}

let sockets: FakeSocket[];
let chat: KickChat;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", { OPEN: 1 });
  sockets = [];
  chat = new KickChat({
    key: "k",
    cluster: "us2",
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s as unknown as WebSocket;
    },
  });
});

afterEach(() => {
  chat.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const connect = (s: FakeSocket) => {
  s.open();
  s.frame("pusher:connection_established", { socket_id: "1.1", activity_timeout: 120 });
};

const chatMsg = (id: string, content = "hi") => ({
  id,
  chatroom_id: 42,
  content,
  type: "message",
  sender: { id: 7, username: "Radin", slug: "radin", identity: { color: "#FFA600", badges: [{ type: "moderator" }] } },
});

describe("KickChat", () => {
  it("subscribes to joined rooms once connected, and again after reconnect", () => {
    chat.join(42);
    chat.start();
    connect(sockets[0]!);
    expect(sockets[0]!.sent.map((m) => m.data.channel)).toEqual(["chatrooms.42.v2", "chatroom_42"]);

    sockets[0]!.close();
    expect(chat.isConnected).toBe(false);
    vi.advanceTimersByTime(1500);
    expect(sockets).toHaveLength(2);
    connect(sockets[1]!);
    expect(sockets[1]!.sent.map((m) => m.data.channel)).toEqual(["chatrooms.42.v2", "chatroom_42"]);
  });

  it("emits parsed chat messages once, even if both channels deliver them", () => {
    const got: ChatMessage[] = [];
    chat.on("message", (m) => got.push(m));
    chat.join(42);
    chat.start();
    connect(sockets[0]!);
    sockets[0]!.frame("App\\Events\\ChatMessageEvent", chatMsg("abc", "youtu.be/x"), "chatrooms.42.v2");
    sockets[0]!.frame("App\\Events\\ChatMessageEvent", chatMsg("abc", "youtu.be/x"), "chatroom_42");
    expect(got).toEqual([
      {
        id: "abc",
        chatroomId: 42,
        content: "youtu.be/x",
        sender: { id: 7, username: "Radin", color: "#FFA600", badges: ["moderator"] },
      },
    ]);
  });

  it("ignores rooms it didn't join and malformed frames", () => {
    const got: ChatMessage[] = [];
    chat.on("message", (m) => got.push(m));
    chat.join(42);
    chat.start();
    connect(sockets[0]!);
    sockets[0]!.frame("App\\Events\\ChatMessageEvent", chatMsg("x1"), "chatrooms.99.v2");
    sockets[0]!.frame("App\\Events\\ChatMessageEvent", { id: "x2" }, "chatrooms.42.v2");
    sockets[0]!.dispatchEvent(new MessageEvent("message", { data: "not json" }));
    expect(got).toEqual([]);
  });

  it("emits deletes and bans", () => {
    const deleted: unknown[] = [];
    const banned: unknown[] = [];
    chat.on("deleted", (e) => deleted.push(e));
    chat.on("banned", (e) => banned.push(e));
    chat.join(42);
    chat.start();
    connect(sockets[0]!);
    sockets[0]!.frame("App\\Events\\MessageDeletedEvent", { id: "d1", message: { id: "abc" } }, "chatrooms.42.v2");
    sockets[0]!.frame("App\\Events\\UserBannedEvent", { id: "b1", user: { id: 7, username: "x" } }, "chatrooms.42.v2");
    expect(deleted).toEqual([{ chatroomId: 42, messageId: "abc" }]);
    expect(banned).toEqual([{ chatroomId: 42, userId: 7 }]);
  });

  it("answers pusher pings", () => {
    chat.start();
    connect(sockets[0]!);
    sockets[0]!.frame("pusher:ping", {});
    expect(sockets[0]!.sent.at(-1)).toEqual({ event: "pusher:pong", data: {} });
  });

  it("pings when idle and reconnects if no pong comes back", () => {
    chat.start();
    connect(sockets[0]!);
    vi.advanceTimersByTime(120_000);
    expect(sockets[0]!.sent.at(-1)?.event).toBe("pusher:ping");
    vi.advanceTimersByTime(30_000);
    expect(chat.isConnected).toBe(false);
    vi.advanceTimersByTime(1500);
    expect(sockets).toHaveLength(2);
  });

  it("stays connected when the pong arrives", () => {
    chat.start();
    connect(sockets[0]!);
    vi.advanceTimersByTime(120_000);
    sockets[0]!.frame("pusher:pong", {});
    vi.advanceTimersByTime(30_000);
    expect(chat.isConnected).toBe(true);
    expect(sockets).toHaveLength(1);
  });

  it("backs off between failed reconnects, capped at 30s", () => {
    chat.start();
    for (let i = 0; i < 10; i++) {
      sockets.at(-1)!.close();
      vi.advanceTimersByTime(30_000);
    }
    expect(sockets).toHaveLength(11);
  });

  it("does not reconnect after stop()", () => {
    chat.start();
    connect(sockets[0]!);
    chat.stop();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });
});
