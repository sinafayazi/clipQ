import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { QueueItem } from "../shared/types";
import { Player } from "./Player";
import "./obs.css";

// The song player as an OBS browser source. No login: the link carries the channel and a key.
// It plays whatever song is current and tells the server when it ends.

const POLL_MS = 2000;
const params = new URLSearchParams(location.search);
const auth = `c=${encodeURIComponent(params.get("c") ?? "")}&k=${encodeURIComponent(params.get("k") ?? "")}`;

interface ObsState {
  player: "dashboard" | "obs";
  volume: number;
  current: QueueItem | null;
}

function ObsPlayer() {
  const [state, setState] = useState<ObsState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/obs/state?${auth}`);
        const body = await res.json();
        if (stop) return;
        if (!res.ok) setError(body.error ?? "Can't load songs.");
        else {
          setError(null);
          setState(body as ObsState);
        }
      } catch {
        // Keep playing what we have; try again on the next tick.
      }
    };
    void tick();
    const t = window.setInterval(tick, POLL_MS);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, []);

  const current = state?.player === "obs" ? state.current : null;
  const endedFor = useRef<number | null>(null);
  const onEnded = useCallback(() => {
    if (!current || endedFor.current === current.id) return;
    endedFor.current = current.id;
    void fetch(`/api/obs/next?${auth}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ifCurrent: current.id }),
    });
  }, [current]);

  if (error) return <p className="obs-note">{error}</p>;
  if (state && state.player !== "obs") return <p className="obs-note">clipQ: songs are set to play in the dashboard.</p>;
  if (!current) return null;
  return (
    <div className="player obs-player">
      <Player key={current.id} item={current} onEnded={onEnded} volume={state?.volume} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<ObsPlayer />);
