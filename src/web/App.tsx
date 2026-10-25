import { useEffect, useState } from "react";
import { api, useQueueState } from "./api";
import { Dashboard } from "./Dashboard";
import { AlertIcon, KickMark } from "./icons";

export function App() {
  const { state, conn } = useQueueState();

  if (conn === "logged-out") return <Login />;
  if (!state) {
    return (
      <div className="center">
        <p className="status-page" role="status">
          {conn === "offline" ? "Can't reach the server. Retrying…" : "Loading queue"}
        </p>
      </div>
    );
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
        <div className="login-mark">
          <span className="tally on" aria-hidden="true" />
          <h1>clipQ</h1>
          <p>Watch clips from Kick chat, in order.</p>
        </div>
        {error && (
          <p className="banner error" role="alert">
            <AlertIcon size={18} stroke={2} />
            <span>{error}</span>
          </p>
        )}
        {!cfg && (
          <p className="status-page" role="status">
            Loading login
          </p>
        )}
        {cfg?.oauth && (
          <a className="btn btn-primary icon-start" href="/auth/login">
            <KickMark size={18} />
            Log in with Kick
          </a>
        )}
        {cfg?.devLogin && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (slug.trim()) location.href = `/auth/dev?slug=${encodeURIComponent(slug.trim())}`;
            }}
          >
            <div className="field">
              <label htmlFor="slug">Channel slug</label>
              <input
                id="slug"
                name="slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="your-channel"
                autoComplete="username"
                spellCheck={false}
              />
            </div>
            <button className="btn">Dev login</button>
          </form>
        )}
        {cfg && !cfg.oauth && !cfg.devLogin && (
          <p className="banner error" role="alert">
            <AlertIcon size={18} stroke={2} />
            <span>Login isn't configured. Set Kick OAuth or turn on dev login on the server.</span>
          </p>
        )}
      </div>
    </div>
  );
}
