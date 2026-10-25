function env(name: string, fallback?: string): string {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing env var ${name}`);
}

const publicUrl = env("PUBLIC_URL", "http://localhost:5173").replace(/\/+$/, "");

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
};
