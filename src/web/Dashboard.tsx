import { useCallback, useRef, useState } from "react";
import type { QueueItem, QueueState } from "../shared/types";
import { api, type Connection } from "./api";
import { formatDuration, PROVIDER_LABEL } from "./clip-meta";
import {
  AlertIcon,
  CloseIcon,
  ExternalIcon,
  LiveIcon,
  LogoutIcon,
  NextIcon,
  PlayIcon,
  PrevIcon,
  ProviderIcon,
  SkipIcon,
} from "./icons";
import { Player } from "./Player";

export function Dashboard({ state, conn }: { state: QueueState; conn: Connection }) {
  const [error, setError] = useState<string | null>(null);
  const { channel, settings, current, queue, history } = state;
  const clearDialog = useRef<HTMLDialogElement>(null);

  const run = useCallback((p: Promise<unknown>) => {
    p.then(
      () => setError(null),
      (e: Error) => setError(e.message),
    );
  }, []);

  const advancedFor = useRef<number | null>(null);
  const onEnded = useCallback(() => {
    if (!current || !settings.autoAdvance || advancedFor.current === current.id) return;
    advancedFor.current = current.id;
    run(api.next());
  }, [current, settings.autoAdvance, run]);

  const live = conn === "live" && state.chatConnected;

  return (
    <div className="app">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="brand">
          <span className={`tally${live ? " on" : ""}`} aria-hidden="true" />
          <div className="brand-text">
            <h1>clipQ</h1>
            <p className="channel">{channel.displayName}</p>
          </div>
        </div>
        <p className={`presence${live ? " live" : ""}`} role="status">
          <LiveIcon size={18} stroke={live ? 2 : 1.5} />
          {live ? "Chat connected" : "Reconnecting to chat"}
        </p>
        <div className="topbar-actions">
          <label className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={settings.open}
              aria-checked={settings.open}
              onChange={() => run(api.settings({ open: !settings.open }))}
            />
            <span className="switch-ui" />
            Queue open
          </label>
          <button
            type="button"
            className="btn btn-ghost icon-start"
            onClick={() => api.logout().finally(() => (location.href = "/"))}
          >
            <LogoutIcon size={18} stroke={2} />
            Log out
          </button>
        </div>
      </header>

      <main id="main" className="workspace" tabIndex={-1}>
        {!channel.chatroomId && <ChatroomPrompt onSave={(id) => run(api.chatroom(id))} />}
        {error && (
          <p className="banner error" role="alert">
            <AlertIcon size={18} stroke={2} />
            <span>{error}</span>
          </p>
        )}

        <div className="stage">
        <section className="player-col">
          <div className="player">
            {current ? (
              <Player key={current.id} item={current} onEnded={onEnded} />
            ) : (
              <div className="empty">
                <h2>{settings.open ? "Waiting for clips" : "Queue is closed"}</h2>
                <p>
                  {settings.open
                    ? "New clips from chat will start here."
                    : "Open the queue to take clips from chat."}
                </p>
              </div>
            )}
          </div>
          {current && (
            <div className="now">
              <a href={current.url} target="_blank" rel="noreferrer" title={current.title ?? current.url}>
                <span className="now-title">{current.title ?? current.url}</span>
                <ExternalIcon size={16} stroke={2} />
              </a>
              <p className="now-meta">
                {PROVIDER_LABEL[current.provider]}
                {" · "}
                {current.requestedBy.username}
                {current.duration != null ? ` · ${formatDuration(current.duration)}` : ""}
              </p>
            </div>
          )}
          <div className="transport">
            <button type="button" className="btn icon-start" onClick={() => run(api.previous())} disabled={!history.length}>
              <PrevIcon size={18} stroke={2} />
              Previous
            </button>
            <button type="button" className="btn icon-start" onClick={() => run(api.next(true))} disabled={!current}>
              <SkipIcon size={18} stroke={2} />
              Skip
            </button>
            <button
              type="button"
              className="btn btn-primary icon-start"
              onClick={() => run(api.next())}
              disabled={!current && !queue.length}
            >
              <NextIcon size={18} stroke={2} />
              Next
            </button>
          </div>
        </section>

        <aside className="queue">
          <div className="queue-head">
            <h2>Queue</h2>
            <p className="queue-count" role="status">
              {queue.length === 0 ? "None waiting" : `${queue.length} waiting`}
            </p>
            <span className="spacer" />
            {queue.length > 0 && (
              <button type="button" className="btn btn-ghost" onClick={() => clearDialog.current?.showModal()}>
                Clear queue
              </button>
            )}
          </div>
          {queue.length === 0 ? (
            <p className="queue-empty">
              {settings.open
                ? "Clips show up here when viewers post links in chat."
                : "Open the queue to accept clips from chat."}
            </p>
          ) : (
            <ol className="clips">
              {queue.map((item, i) => (
                <ClipRow key={item.id} item={item} index={i} run={run} />
              ))}
            </ol>
          )}
        </aside>
        </div>
      </main>

      <dialog
        ref={clearDialog}
        className="dialog"
        aria-labelledby="clear-title"
        aria-describedby="clear-body"
        onClick={(e) => {
          if (e.target === e.currentTarget) e.currentTarget.close();
        }}
        onClose={(e) => {
          if ((e.target as HTMLDialogElement).returnValue === "clear") run(api.clear());
        }}
      >
        <h2 id="clear-title">Clear queue?</h2>
        <p id="clear-body">This removes every waiting clip. The clip that's playing stays.</p>
        <form method="dialog" className="dialog-actions">
          <button className="btn" value="cancel">
            Cancel
          </button>
          <button className="btn btn-danger" value="clear">
            Clear queue
          </button>
        </form>
      </dialog>
    </div>
  );
}

function ClipRow({ item, index, run }: { item: QueueItem; index: number; run: (p: Promise<unknown>) => void }) {
  const title = item.title ?? item.url;
  return (
    <li className="clip">
      <button type="button" className="thumb-btn" onClick={() => run(api.play(item.id))} aria-label={`Play ${title}`}>
        <Thumb item={item} />
      </button>
      <div className="clip-body">
        <p className="clip-title" title={title}>
          {index + 1}. {title}
        </p>
        <p className="clip-meta">
          {PROVIDER_LABEL[item.provider]} · {item.requestedBy.username}
        </p>
      </div>
      <button
        className="btn btn-ghost btn-icon clip-remove"
        type="button"
        aria-label={`Remove ${title} from queue`}
        onClick={() => run(api.remove(item.id))}
      >
        <CloseIcon size={16} stroke={2} />
      </button>
    </li>
  );
}

function Thumb({ item }: { item: QueueItem }) {
  const [broken, setBroken] = useState(false);
  const src = item.thumbnail && !broken ? item.thumbnail : null;
  return (
    <span className="thumb">
      {src ? (
        <img src={src} alt="" width={120} height={68} decoding="async" onError={() => setBroken(true)} />
      ) : (
        <span className="thumb-fallback">
          <ProviderIcon provider={item.provider} size={22} stroke={1.5} />
        </span>
      )}
      <span className="thumb-play">
        <PlayIcon size={22} />
      </span>
      {item.duration != null && <span className="thumb-time">{formatDuration(item.duration)}</span>}
    </span>
  );
}

function ChatroomPrompt({ onSave }: { onSave: (id: number) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="banner">
      <AlertIcon size={18} stroke={2} />
      <div className="banner-body">
        <p>
          Kick didn't return a chatroom for this channel. Paste the numeric id from the channel API so clipQ can read
          chat.
        </p>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            const id = Number(value);
            if (Number.isInteger(id) && id > 0) onSave(id);
          }}
        >
          <div className="field">
            <label htmlFor="chatroom-id">Chatroom id</label>
            <input
              id="chatroom-id"
              name="chatroomId"
              inputMode="numeric"
              autoComplete="off"
              placeholder="123456"
              value={value}
              onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))}
            />
          </div>
          <button className="btn btn-primary">Save chatroom</button>
        </form>
      </div>
    </div>
  );
}
