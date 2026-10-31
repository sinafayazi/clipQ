import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { QueueItem, QueueKind, QueueState } from "../shared/types";
import { api, type Connection } from "./api";
import { clipTitle, formatDuration, PROVIDER_LABEL } from "./clip-meta";
import {
  AlertIcon,
  BanIcon,
  CloseIcon,
  DownIcon,
  ExternalIcon,
  GripIcon,
  LiveIcon,
  LogoutIcon,
  NextIcon,
  PlayIcon,
  PrevIcon,
  ProviderIcon,
  SettingsIcon,
  SkipIcon,
  UpIcon,
} from "./icons";
import { Player } from "./Player";
import { useDragReorder } from "./reorder";
import { CopyLink } from "./CopyLink";
import { BanDialog, SettingsDialog } from "./Settings";

export function Dashboard({ state, conn }: { state: QueueState; conn: Connection }) {
  const [error, setError] = useState<string | null>(null);
  const { channel, settings, current, queue, history } = state;
  const clearDialog = useRef<HTMLDialogElement>(null);
  const [clearKind, setClearKind] = useState<QueueKind>("clips");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [banTarget, setBanTarget] = useState<string | null>(null);
  const [tab, setTabState] = useState<QueueKind>(() => (readTab() === "songs" ? "songs" : "clips"));
  const setTab = (t: QueueKind) => {
    setTabState(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {}
  };
  const askClear = (kind: QueueKind) => {
    setClearKind(kind);
    clearDialog.current?.showModal();
  };
  const songs = settings.songs;

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
            Clips open
          </label>
          <label className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={songs.open}
              aria-checked={songs.open}
              onChange={() => run(api.settings({ songs: { open: !songs.open } }))}
            />
            <span className="switch-ui" />
            Songs open
          </label>
          <button type="button" className="btn btn-ghost icon-start" onClick={() => setSettingsOpen(true)}>
            <SettingsIcon size={18} stroke={2} />
            Settings
          </button>
          <a className="btn btn-ghost" href="https://nowpayments.io/donation/sina" target="_blank" rel="noopener">
            ♥ Donate
          </a>
          <button
            type="button"
            className="btn btn-ghost icon-start"
            onClick={() => api.logout().finally(() => (location.href = "/app/"))}
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

        <div className="tabs" role="tablist" aria-label="Lists">
          <button type="button" role="tab" id="tab-clips" aria-selected={tab === "clips"} aria-controls="panel-clips" onClick={() => setTab("clips")}>
            Clips <span className="tab-count">{queue.length}</span>
          </button>
          <button type="button" role="tab" id="tab-songs" aria-selected={tab === "songs"} aria-controls="panel-songs" onClick={() => setTab("songs")}>
            Songs <span className="tab-count">{state.songs.queue.length}</span>
          </button>
        </div>

        {/* Hidden, not unmounted: a song keeps playing while you look at clips. */}
        <div id="panel-songs" role="tabpanel" aria-labelledby="tab-songs" className="stage" hidden={tab !== "songs"}>
          <SongsView state={state} run={run} onBan={setBanTarget} onClear={() => askClear("songs")} />
        </div>

        <div id="panel-clips" role="tabpanel" aria-labelledby="tab-clips" className="stage" hidden={tab !== "clips"}>
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
              <a href={current.url} target="_blank" rel="noreferrer" title={current.url}>
                <span className="now-title">{clipTitle(current)}</span>
                <ExternalIcon size={16} stroke={2} />
              </a>
              <p className="now-meta">
                {PROVIDER_LABEL[current.provider]}
                {" · "}
                {current.requestedBy.username}
                {current.duration != null ? ` · ${formatDuration(current.duration)}` : ""}
                {settings.voteSkip > 0 && state.skipVotes > 0 ? ` · Skip votes ${state.skipVotes}/${settings.voteSkip}` : ""}
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
              <button type="button" className="btn btn-ghost" onClick={() => askClear("clips")}>
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
            <QueueList queue={queue} run={run} onBan={setBanTarget} />
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
          if ((e.target as HTMLDialogElement).returnValue === "clear") run(api.clear(clearKind));
        }}
      >
        <h2 id="clear-title">{clearKind === "songs" ? "Clear song requests?" : "Clear queue?"}</h2>
        <p id="clear-body">
          {clearKind === "songs"
            ? "This removes every waiting song. The song that's playing stays."
            : "This removes every waiting clip. The clip that's playing stays."}
        </p>
        <form method="dialog" className="dialog-actions">
          <button className="btn" value="cancel">
            Cancel
          </button>
          <button className="btn btn-danger" value="clear">
            Clear queue
          </button>
        </form>
      </dialog>

      <SettingsDialog state={state} kind={tab} open={settingsOpen} onClose={() => setSettingsOpen(false)} run={run} />
      <BanDialog username={banTarget} onClose={() => setBanTarget(null)} run={run} />
    </div>
  );
}

const TAB_KEY = "clipq-tab";

function readTab(): string | null {
  try {
    return localStorage.getItem(TAB_KEY);
  } catch {
    return null;
  }
}

/** The song request list: its own player (or a pointer to the OBS page), controls and queue. */
function SongsView({
  state,
  run,
  onBan,
  onClear,
}: {
  state: QueueState;
  run: (p: Promise<unknown>) => void;
  onBan: (username: string) => void;
  onClear: () => void;
}) {
  const { current, queue, history, skipVotes, obsUrl } = state.songs;
  const s = state.settings.songs;
  const songPage = `/s/${state.channel.slug}`;

  // Songs always move on by themselves. `ifCurrent` stops a double skip if the OBS page also reports the end.
  const advancedFor = useRef<number | null>(null);
  const onEnded = useCallback(() => {
    if (!current || advancedFor.current === current.id) return;
    advancedFor.current = current.id;
    run(api.next(false, "songs", current.id));
  }, [current, run]);

  return (
    <>
      <section className="player-col">
        <div className="player">
          {s.player === "obs" ? (
            <div className="empty">
              <h2>Songs play in OBS</h2>
              <p>
                Add this link to OBS as a browser source. Keep it secret: anyone with it can skip songs. You can switch back in
                Settings.
              </p>
              <CopyLink url={obsUrl} />
            </div>
          ) : current ? (
            <Player key={current.id} item={current} onEnded={onEnded} volume={s.volume} />
          ) : (
            <div className="empty">
              <h2>{s.open ? "Waiting for songs" : "Song requests are closed"}</h2>
              <p>
                {s.open ? (
                  <>
                    Viewers type <code>!sr</code> and a YouTube or Spotify link, or the song's name.
                  </>
                ) : (
                  "Turn on Songs open to take songs from chat."
                )}
              </p>
            </div>
          )}
        </div>
        {current && (
          <div className="now">
            <a href={current.url} target="_blank" rel="noreferrer" title={current.url}>
              <span className="now-title">{current.title ?? "Song"}</span>
              <ExternalIcon size={16} stroke={2} />
            </a>
            <p className="now-meta">
              {current.requestedBy.username}
              {current.duration != null ? ` · ${formatDuration(current.duration)}` : ""}
              {s.voteSkip > 0 && skipVotes > 0 ? ` · Skip votes ${skipVotes}/${s.voteSkip}` : ""}
            </p>
          </div>
        )}
        <div className="transport">
          <button type="button" className="btn icon-start" onClick={() => run(api.previous("songs"))} disabled={!history.length}>
            <PrevIcon size={18} stroke={2} />
            Previous
          </button>
          <button type="button" className="btn icon-start" onClick={() => run(api.next(true, "songs"))} disabled={!current}>
            <SkipIcon size={18} stroke={2} />
            Skip
          </button>
          <button
            type="button"
            className="btn btn-primary icon-start"
            onClick={() => run(api.next(false, "songs"))}
            disabled={!current && !queue.length}
          >
            <NextIcon size={18} stroke={2} />
            Next
          </button>
          <VolumeSlider value={s.volume} onChange={(volume) => run(api.settings({ songs: { volume } }))} />
        </div>
      </section>

      <aside className="queue">
        <div className="queue-head">
          <h2>Songs</h2>
          <p className="queue-count" role="status">
            {queue.length === 0 ? "None waiting" : `${queue.length} waiting`}
          </p>
          <span className="spacer" />
          <a className="btn btn-ghost" href={songPage} target="_blank" rel="noreferrer">
            Song page
          </a>
          {queue.length > 0 && (
            <button type="button" className="btn btn-ghost" onClick={onClear}>
              Clear
            </button>
          )}
        </div>
        {queue.length === 0 ? (
          <p className="queue-empty">
            {s.open ? (
              <>
                Songs show up here when viewers type <code>!sr</code> in chat.
              </>
            ) : (
              "Turn on Songs open to take songs from chat."
            )}
          </p>
        ) : (
          <QueueList queue={queue} run={run} onBan={onBan} />
        )}
      </aside>
    </>
  );
}

/** Song volume. Saves once you stop moving it; follows changes made elsewhere (a mod's !volume). */
function VolumeSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [v, setV] = useState(value);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => setV(value), [value]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <label className="volume">
      <span>Volume</span>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={v}
        onChange={(e) => {
          const n = Number(e.target.value);
          setV(n);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => onChange(n), 250);
        }}
      />
      <output>{v}%</output>
    </label>
  );
}

function QueueList({ queue, run, onBan }: { queue: QueueItem[]; run: (p: Promise<unknown>) => void; onBan: (username: string) => void }) {
  const drag = useDragReorder(queue, (id, to) => run(api.move(id, to)));
  return (
    <ol className={`clips${drag.draggingId !== null ? " is-dragging" : ""}`}>
      {drag.items.map((item, i) => (
        <ClipRow
          key={item.id}
          item={item}
          index={i}
          count={drag.items.length}
          run={run}
          onBan={onBan}
          rowRef={drag.rowRef(item.id)}
          style={drag.rowStyle(item.id, i)}
          dragging={drag.draggingId === item.id}
          handle={drag.handleProps(item.id, i)}
        />
      ))}
    </ol>
  );
}

function ClipRow({
  item,
  index,
  count,
  run,
  onBan,
  rowRef,
  style,
  dragging,
  handle,
}: {
  item: QueueItem;
  index: number;
  count: number;
  run: (p: Promise<unknown>) => void;
  onBan: (username: string) => void;
  rowRef: (el: HTMLElement | null) => void;
  style: CSSProperties | undefined;
  dragging: boolean;
  handle: ReturnType<ReturnType<typeof useDragReorder>["handleProps"]>;
}) {
  const title = clipTitle(item);
  return (
    <li ref={rowRef} className={`clip${dragging ? " dragging" : ""}`} style={style}>
      <button
        type="button"
        className="drag-handle"
        aria-label={`Reorder ${title}. Drag, or use the arrow keys.`}
        title="Drag to reorder"
        {...handle}
      >
        <GripIcon size={18} stroke={2} />
      </button>
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
      <div className="clip-actions">
        <button
          className="btn btn-ghost btn-icon"
          type="button"
          aria-label={`Move ${title} up`}
          title="Move up"
          disabled={index === 0}
          onClick={() => run(api.move(item.id, index - 1))}
        >
          <UpIcon size={16} stroke={2} />
        </button>
        <button
          className="btn btn-ghost btn-icon clip-ban"
          type="button"
          aria-label={`Ban ${item.requestedBy.username}`}
          title={`Ban ${item.requestedBy.username}`}
          onClick={() => onBan(item.requestedBy.username)}
        >
          <BanIcon size={16} stroke={2} />
        </button>
        <button
          className="btn btn-ghost btn-icon"
          type="button"
          aria-label={`Move ${title} down`}
          title="Move down"
          disabled={index === count - 1}
          onClick={() => run(api.move(item.id, index + 1))}
        >
          <DownIcon size={16} stroke={2} />
        </button>
        <button
          className="btn btn-ghost btn-icon clip-remove"
          type="button"
          aria-label={`Remove ${title} from queue`}
          title="Remove"
          onClick={() => run(api.remove(item.id))}
        >
          <CloseIcon size={16} stroke={2} />
        </button>
      </div>
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
