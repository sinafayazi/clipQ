import { useEffect, useRef, useState } from "react";
import type { QueueSettings, QueueState, ServerMessage } from "../shared/types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function post(path: string, body?: unknown) {
  const res = await fetch(path, {
    method: "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new ApiError(res.status, err.error ?? `Request failed (${res.status})`);
  }
}

export const api = {
  async config(): Promise<{ oauth: boolean; devLogin: boolean }> {
    return (await fetch("/api/config")).json();
  },
  next: (skip = false) => post("/api/queue/next", { skip }),
  previous: () => post("/api/queue/previous"),
  play: (id: number) => post("/api/queue/play", { id }),
  remove: (id: number) => post("/api/queue/remove", { id }),
  move: (id: number, index: number) => post("/api/queue/move", { id, index }),
  clear: () => post("/api/queue/clear"),
  settings: (patch: Partial<QueueSettings>) => post("/api/settings", patch),
  chatroom: (chatroomId: number) => post("/api/chatroom", { chatroomId }),
  /** minutes = null bans for good */
  ban: (username: string, minutes: number | null) => post("/api/bans", { username, minutes }),
  unban: (username: string) => post("/api/bans/remove", { username }),
  logout: () => post("/auth/logout"),
};

export type Connection = "connecting" | "live" | "offline" | "logged-out";

/** A socket that opened but sent no snapshot in this long is treated as dead. */
const FIRST_MESSAGE_TIMEOUT_MS = 10_000;

/**
 * Live queue state from /ws. Reconnects with backoff; the server sends a full snapshot on connect.
 * Login is checked over plain HTTP before each connect: some proxies (Render's) swallow a websocket
 * close sent right after the upgrade, so the 4401 close code alone can't be relied on.
 */
export function useQueueState() {
  const [state, setState] = useState<QueueState | null>(null);
  const [conn, setConn] = useState<Connection>("connecting");
  const attempt = useRef(0);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: number | undefined;
    let disposed = false;

    const retry = () => {
      if (disposed) return;
      setConn("offline");
      const delay = Math.min(10_000, 500 * 2 ** attempt.current++);
      timer = window.setTimeout(connect, delay);
    };

    const connect = async () => {
      let res: Response;
      try {
        res = await fetch("/api/state");
      } catch {
        return retry();
      }
      if (disposed) return;
      if (res.status === 401) return setConn("logged-out");
      if (!res.ok) return retry();
      setState((await res.json()) as QueueState);
      if (!disposed) open();
    };

    const open = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${proto}://${location.host}/ws`);
      ws = socket;
      let gotMessage = false;
      const watchdog = window.setTimeout(() => !gotMessage && socket.close(), FIRST_MESSAGE_TIMEOUT_MS);

      socket.onmessage = (e) => {
        const msg = JSON.parse(e.data) as ServerMessage;
        if (msg.type === "state") {
          gotMessage = true;
          attempt.current = 0;
          setState(msg.state);
          setConn("live");
        }
      };
      socket.onclose = (e) => {
        window.clearTimeout(watchdog);
        if (disposed || ws !== socket) return;
        if (e.code === 4401) return setConn("logged-out");
        retry(); // connect() re-checks login first, so an expired session lands on the login page
      };
    };

    void connect();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return { state, conn };
}
