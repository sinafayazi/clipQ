import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bridgeChat } from "./bridge.js";
import { resolveClip } from "./clips/resolve.js";
import { config } from "./config.js";
import { openDb } from "./db.js";
import { KickBot } from "./kick/bot.js";
import { KickChat } from "./kick/chat.js";
import { QueueService } from "./queue/service.js";
import { registerRoutes } from "./routes.js";
import { registerSite } from "./site.js";
import { obsUrl } from "./songs/obs.js";
import { resolveSong } from "./songs/resolve.js";
import { Sessions, ViewerSessions } from "./sessions.js";
import { TursoSync } from "./sync.js";
import { createClient } from "@libsql/client";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, trustProxy: true });
await app.register(cookie);
await app.register(websocket);

const db = openDb(config.dbPath);

let sync: TursoSync | null = null;
if (config.turso) {
  sync = new TursoSync(db, createClient(config.turso), { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) });
  // Before anything else touches the database. Throws (and the host restarts us) if Turso is down.
  await sync.init();
  sync.start();
}

const queues = new QueueService(db, resolveClip, Date.now, { resolve: resolveSong, obsUrl });
const sessions = new Sessions(db);
const viewers = new ViewerSessions(db);
const chat = new KickChat({ ...config.pusher, log: { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) } });

const bot = new KickBot(db, config.oauth, { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) });

bridgeChat(chat, queues, bot, app.log, config.publicUrl, config.superUsers);
registerRoutes(app, { queues, chat, sessions, viewers, bot });

// The built site. In dev, Vite serves it and proxies the API here.
await registerSite(app, join(dirname(fileURLToPath(import.meta.url)), "../web"), sessions);

app.get("/healthz", async () => ({ ok: true, chat: chat.isConnected }));

for (const c of queues.channels()) if (c.chatroomId) chat.join(c.chatroomId);
chat.start();

if (config.devLogin) app.log.warn("DEV_LOGIN is on: anyone can log in as any channel. Never use this in production.");
if (!config.oauth && !config.devLogin) app.log.warn("No login method configured: set KICK_CLIENT_ID/KICK_CLIENT_SECRET.");

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  chat.stop();
  await app.close();
  await sync?.stop();
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.port, host: "0.0.0.0" });
