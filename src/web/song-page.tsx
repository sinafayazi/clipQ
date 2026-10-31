import { useCallback, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import type { PublicSong, PublicSongs } from "../shared/types";
import { post } from "./api";
import { formatDuration } from "./clip-meta";
import { AlertIcon, ExternalIcon, LogoutIcon } from "./icons";
import "./styles.css";

// The public song page, /s/<channel>: what's playing and what's next for everyone; logged-in
// viewers also see their own songs and can request, change or remove them.

const POLL_MS = 5000;
const slug = decodeURIComponent(location.pathname.split("/")[2] ?? "").toLowerCase();

function SongPage() {
  const [data, setData] = useState<PublicSongs | null>(null);
  const [error, setError] = useState<string | null>(() => new URLSearchParams(location.search).get("error"));
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/s/${encodeURIComponent(slug)}`);
      if (res.status === 404) return setMissing(true);
      if (res.ok) setData((await res.json()) as PublicSongs);
    } catch {
      // Offline for a moment: keep showing the last list.
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => document.visibilityState === "visible" && void load(), POLL_MS);
    return () => window.clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (data) document.title = `${data.channel.displayName} song requests · clipQ`;
  }, [data]);

  /** Run a viewer action, then refresh. Returns whether it worked. */
  const act = async (p: Promise<unknown>) => {
    try {
      await p;
      setError(null);
      await load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  if (missing) {
    return (
      <main className="song-page">
        <div className="empty">
          <h1>No song requests here</h1>
          <p>
            This channel doesn't use clipQ. <a href="/">What's clipQ?</a>
          </p>
        </div>
      </main>
    );
  }
  if (!data) return <main className="song-page" aria-busy="true" />;

  const base = `/api/s/${encodeURIComponent(slug)}`;
  const me = data.me;

  return (
    <main className="song-page">
      <header className="song-head">
        <div>
          <p className="song-kicker">Song requests</p>
          <h1>{data.channel.displayName}</h1>
        </div>
        {me ? (
          <button type="button" className="btn btn-ghost icon-start" onClick={() => void act(post("/auth/viewer/logout")).then(load)}>
            <LogoutIcon size={18} stroke={2} />
            Log out {me.username}
          </button>
        ) : (
          <a className="btn btn-primary" href={`/auth/viewer?c=${encodeURIComponent(slug)}`}>
            Log in with Kick
          </a>
        )}
      </header>

      {error && (
        <p className="banner error" role="alert">
          <AlertIcon size={18} stroke={2} />
          <span>{error}</span>
        </p>
      )}

      <section aria-labelledby="now-title" className="song-section">
        <h2 id="now-title">Now playing</h2>
        {data.current ? <SongCard song={data.current} /> : <p className="settings-empty">Nothing is playing.</p>}
      </section>

      {me ? (
        <section aria-labelledby="mine-title" className="song-section">
          <h2 id="mine-title">Your songs</h2>
          {data.open ? (
            <QueryForm label="Request a song" button="Request" onSubmit={(query) => act(post(`${base}/request`, { query }))} />
          ) : (
            <p className="settings-empty">Song requests are closed right now.</p>
          )}
          {me.queued.length === 0 ? (
            <p className="settings-empty">You have no songs waiting.</p>
          ) : (
            <ol className="song-list">
              {me.queued.map((s) => (
                <MySong
                  key={s.id}
                  song={s}
                  position={data.queue.findIndex((q) => q.id === s.id) + 1}
                  onRemove={() => act(post(`${base}/songs/${s.id}/remove`))}
                  onReplace={(query) => act(post(`${base}/songs/${s.id}/replace`, { query }))}
                />
              ))}
            </ol>
          )}
          {me.history.length > 0 && (
            <details className="song-history">
              <summary>Songs you requested before ({me.history.length})</summary>
              <ul className="song-list">
                {me.history.map((s) => (
                  <li key={s.id}>
                    <SongCard song={s} compact />
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      ) : (
        <p className="song-login-hint">
          Request with <code>!sr</code> in chat. Log in with Kick to see your songs and change or remove them.
        </p>
      )}

      <section aria-labelledby="queue-title" className="song-section">
        <h2 id="queue-title">Up next {data.queue.length > 0 && <span className="tab-count">{data.queue.length}</span>}</h2>
        {data.queue.length === 0 ? (
          <p className="settings-empty">No songs waiting.</p>
        ) : (
          <ol className="song-list">
            {data.queue.map((s, i) => (
              <li key={s.id}>
                <SongCard song={s} position={i + 1} mine={me?.queued.some((m) => m.id === s.id)} />
              </li>
            ))}
          </ol>
        )}
      </section>

      <footer className="song-foot">
        <a href="/">clipQ</a> · clip and song requests for Kick
      </footer>
    </main>
  );
}

function when(startsIn: number | null) {
  if (startsIn === null) return null;
  if (startsIn < 45) return "Next";
  return `in about ${Math.max(1, Math.round(startsIn / 60))} min`;
}

function SongCard({ song, position, mine, compact }: { song: PublicSong; position?: number; mine?: boolean; compact?: boolean }) {
  const eta = when(song.startsIn);
  return (
    <div className={`song-card${mine ? " mine" : ""}${compact ? " compact" : ""}`}>
      {song.thumbnail && <img src={song.thumbnail} alt="" width={96} height={54} loading="lazy" decoding="async" />}
      <div className="song-body">
        <a className="song-title" href={song.url} target="_blank" rel="noreferrer">
          {position ? `${position}. ` : ""}
          {song.title ?? "Song"}
          <ExternalIcon size={14} stroke={2} />
        </a>
        <p className="song-meta">
          {song.requestedBy}
          {song.duration != null ? ` · ${formatDuration(song.duration)}` : ""}
          {position && eta ? ` · ${eta}` : ""}
        </p>
      </div>
    </div>
  );
}

function MySong({
  song,
  position,
  onRemove,
  onReplace,
}: {
  song: PublicSong;
  position: number;
  onRemove: () => Promise<boolean>;
  onReplace: (query: string) => Promise<boolean>;
}) {
  const [changing, setChanging] = useState(false);
  return (
    <li className="my-song">
      <SongCard song={song} position={position} mine />
      <div className="my-song-actions">
        <button type="button" className="btn btn-ghost" onClick={() => setChanging((c) => !c)} aria-expanded={changing}>
          {changing ? "Cancel" : "Change"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => void onRemove()}>
          Remove
        </button>
      </div>
      {changing && (
        <QueryForm
          label="Change to"
          button="Change"
          autoFocus
          onSubmit={async (q) => {
            const ok = await onReplace(q);
            if (ok) setChanging(false);
            return ok;
          }}
        />
      )}
    </li>
  );
}

function QueryForm({ label, button, autoFocus, onSubmit }: { label: string; button: string; autoFocus?: boolean; onSubmit: (q: string) => Promise<boolean> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [id] = useState(() => `q-${Math.random().toString(36).slice(2)}`);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    const ok = await onSubmit(text.trim());
    setBusy(false);
    if (ok) setText("");
  };
  return (
    <form className="ban-form song-form" onSubmit={submit}>
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="YouTube or Spotify link, or song name"
          autoComplete="off"
          autoFocus={autoFocus}
          maxLength={300}
        />
      </div>
      <button className="btn btn-primary" disabled={!text.trim() || busy}>
        {busy ? "Looking it up…" : button}
      </button>
    </form>
  );
}

createRoot(document.getElementById("root")!).render(<SongPage />);
