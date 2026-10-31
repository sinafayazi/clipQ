function env(name: string, fallback?: string): string {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing env var ${name}`);
}

const publicUrl = env("PUBLIC_URL", "http://localhost:5173").replace(/\/+$/, "");
if (!/^https?:\/\/[^/\s]+$/.test(publicUrl)) {
  throw new Error(
    `PUBLIC_URL must be the site's address, like https://clipq-xxxx.onrender.com (no path). Got: "${publicUrl.slice(0, 8)}…"`,
  );
}

export const config = {
  port: Number(env("PORT", "3000")),
  publicUrl,
  secureCookies: publicUrl.startsWith("https://"),
  dbPath: env("DB_PATH", "./data/clipq.db"),
  pusher: {
    key: env("PUSHER_KEY", "34bf7a0ff419a2a775b9"),
    cluster: env("PUSHER_CLUSTER", "us2"),
  },
  oauth: process.env.KICK_CLIENT_ID?.trim()
    ? {
        clientId: env("KICK_CLIENT_ID"),
        clientSecret: env("KICK_CLIENT_SECRET"),
        redirectUri: `${publicUrl}/auth/callback`,
      }
    : null,
  devLogin: env("DEV_LOGIN", "0") === "1",
  /** Google Search Console "HTML tag" token. Accepts the bare token or "google-site-verification=<token>". */
  googleSiteVerification: (process.env.GOOGLE_SITE_VERIFICATION ?? "").trim().replace(/^google-site-verification=/, "") || null,
  /**
   * Kick usernames treated like the broadcaster in every channel's chat: all mod commands, every
   * platform and song limit lifted. Comma-separated; the clipQ owner by default.
   */
  superUsers: new Set(
    (process.env.SUPER_USERS ?? "siiinfa")
      .split(",")
      .map((u) => u.trim().replace(/^@/, "").toLowerCase())
      .filter(Boolean),
  ),
  /**
   * Signs the OBS player links. Defaults to the Kick client secret, so it's stable across restarts
   * without another env var; changing it invalidates every OBS link.
   */
  linkSecret: process.env.LINK_SECRET?.trim() || process.env.KICK_CLIENT_SECRET?.trim() || "clipq-dev-secret",
  /** Optional copy of the database in Turso, for hosts whose disk is wiped on restart. */
  turso: process.env.TURSO_DATABASE_URL?.trim()
    ? { url: env("TURSO_DATABASE_URL"), authToken: process.env.TURSO_AUTH_TOKEN?.trim() || undefined }
    : null,
};
