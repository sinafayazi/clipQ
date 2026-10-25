import { useCallback, useRef, useState } from "react";
import type { QueueState } from "../shared/types";
import { api, type Connection } from "./api";
import { Player } from "./Player";

export function Dashboard({ state, conn }: { state: QueueState; conn: Connection }) {
  const [error, setError] = useState<string | null>(null);
  const { channel, settings, current, queue, history } = state;

  const run = useCallback((p: Promise<unknown>) => {
    p.then(
      () => setError(null),
      (e: Error) => setError(e.message),
    );
  }, []);

  // The player's "ended" can fire twice for one clip; advance once.
  const advancedFor = useRef<number | null>(null);
  const onEnded = useCallback(() => {
    if (!current || !settings.autoAdvance || advancedFor.current === current.id) return;
    advancedFor.current = current.id;
    run(api.next());
  }, [current, settings.autoAdvance, run]);

  const online = conn === "live" && state.chatConnected;

  return (
    <div className="app">
      <header>
        <b>clipQ</b>
        <span>
          {channel.displayName} · {online ? "chat connected" : "reconnecting…"}
        </span>
        <span className="spacer" />
        <button onClick={() => run(api.settings({ open: !settings.open }))}>
          {settings.open ? "Close queue" : "Open queue"}
        </button>
        <button onClick={() => api.logout().finally(() => (location.href = "/"))}>Log out</button>
      </header>

      {!channel.chatroomId && <ChatroomPrompt onSave={(id) => run(api.chatroom(id))} />}
      {error && <p className="error">{error}</p>}

      <main>
        <section>
          <div className="player">
            {current ? (
              <Player key={current.id} item={current} onEnded={onEnded} />
            ) : (
              <p className="empty">{settings.open ? "Waiting for clips…" : "Queue is closed."}</p>
            )}
          </div>
          {current && (
            <p>
              <a href={current.url} target="_blank" rel="noreferrer">
                {current.title ?? current.url}
              </a>{" "}
              — {current.requestedBy.username}
            </p>
          )}
          <div className="row">
            <button onClick={() => run(api.previous())} disabled={!history.length}>
              Prev
            </button>
            <button onClick={() => run(api.next(true))} disabled={!current}>
              Skip
            </button>
            <button onClick={() => run(api.next())} disabled={!current && !queue.length}>
              Next
            </button>
          </div>
        </section>

        <aside>
          <div className="row">
            <b>Queue ({queue.length})</b>
            <span className="spacer" />
            {queue.length > 0 && (
              <button onClick={() => confirm("Clear the queue?") && run(api.clear())}>Clear</button>
            )}
          </div>
          <ol>
            {queue.map((item) => (
              <li key={item.id}>
                <span className="item-title">
                  [{item.provider}] {item.title ?? item.url} — {item.requestedBy.username}
                </span>
                <button onClick={() => run(api.play(item.id))}>Play</button>
                <button onClick={() => run(api.remove(item.id))}>✕</button>
              </li>
            ))}
          </ol>
        </aside>
      </main>
    </div>
  );
}

function ChatroomPrompt({ onSave }: { onSave: (id: number) => void }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        const id = Number(value);
        if (Number.isInteger(id) && id > 0) onSave(id);
      }}
    >
      Chatroom not found. Enter it from kick.com/api/v2/channels/&lt;channel&gt; (chatroom.id):
      <input value={value} onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))} />
      <button>Save</button>
    </form>
  );
}
