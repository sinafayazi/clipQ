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
  logout: () => post("/auth/logout"),
};

export type Connection = "connecting" | "live" | "offline" | "logged-out";

/** Live queue state from /ws. Reconnects with backoff; the server sends a full snapshot on connect. */
export function useQueueState() {
  const [state, setState] = useState<QueueState | null>(null);
  const [conn, setConn] = useState<Connection>("connecting");
  const attempt = useRef(0);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: number | undefined;
    let disposed = false;

    const open = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data) as ServerMessage;
        if (msg.type === "state") {
          attempt.current = 0;
          setState(msg.state);
          setConn("live");
        }
      };
      ws.onclose = (e) => {
        if (disposed) return;
        if (e.code === 4401) {
          setConn("logged-out");
          return;
        }
        setConn("offline");
        const delay = Math.min(10_000, 500 * 2 ** attempt.current++);
        timer = window.setTimeout(open, delay);
      };
    };

    open();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return { state, conn };
}
