import { useEffect, useState } from "react";
import { api, useQueueState } from "./api";
import { Dashboard } from "./Dashboard";

export function App() {
  const { state, conn } = useQueueState();

  if (conn === "logged-out") return <Login />;
  if (!state) {
    return <div className="center">{conn === "offline" ? "Can't reach the server, retrying…" : "Loading…"}</div>;
  }
  return <Dashboard state={state} conn={conn} />;
}

function Login() {
  const [cfg, setCfg] = useState<{ oauth: boolean; devLogin: boolean } | null>(null);
  const [slug, setSlug] = useState("");
  const error = new URLSearchParams(location.search).get("error");

  useEffect(() => {
    api.config().then(setCfg, () => setCfg({ oauth: false, devLogin: false }));
  }, []);

  return (
    <div className="center">
      <div className="login">
        <h1>clipQ</h1>
        {error && <p className="error">{error}</p>}
        {cfg?.oauth && <a href="/auth/login">Log in with Kick</a>}
        {cfg?.devLogin && (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (slug.trim()) location.href = `/auth/dev?slug=${encodeURIComponent(slug.trim())}`;
            }}
          >
            <input placeholder="channel (dev login)" value={slug} onChange={(e) => setSlug(e.target.value)} />
            <button>Dev login</button>
          </form>
        )}
        {cfg && !cfg.oauth && !cfg.devLogin && <p className="error">Login isn't configured on this server.</p>}
      </div>
    </div>
  );
}
