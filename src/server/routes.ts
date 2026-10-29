import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import type { ServerMessage } from "../shared/types.js";
import { config } from "./config.js";
import { originAllowed } from "./origin.js";
import { lookupChannel } from "./kick/api.js";
import type { KickChat } from "./kick/chat.js";
import { authorizeUrl, createPkce, exchangeCode, fetchMe } from "./kick/oauth.js";
import { MAX_TIMEOUT_MS, settingsSchema, type QueueService } from "./queue/service.js";
import type { Sessions } from "./sessions.js";

const PKCE_COOKIE = "clipq_oauth";

interface Deps {
  queues: QueueService;
  chat: KickChat;
  sessions: Sessions;
}

export function registerRoutes(app: FastifyInstance, { queues, chat, sessions }: Deps) {
  // Cookies are SameSite=Lax; also refuse cross-site writes outright.
  const publicOrigin = new URL(config.publicUrl).origin;
  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "GET" || req.method === "HEAD") return;
    const origin = req.headers.origin;
    if (origin && !originAllowed(origin, publicOrigin)) return reply.code(403).send({ error: "bad origin" });
  });

  /** Log a channel in: save it, join its chat, start a session. */
  function login(reply: FastifyReply, channel: Awaited<ReturnType<typeof lookupChannel>>) {
    queues.upsertChannel(channel, channel.id);
    const saved = queues.channel(channel.id)!;
    if (saved.chatroomId) chat.join(saved.chatroomId);
    sessions.create(reply, channel.id);
  }

  // ---- auth -----------------------------------------------------------------------------------

  app.get("/api/config", async () => ({ oauth: !!config.oauth, devLogin: config.devLogin }));

  app.get("/auth/login", async (_req, reply) => {
    if (!config.oauth) return reply.code(503).send("Kick login is not configured (KICK_CLIENT_ID).");
    const { verifier, challenge, state } = createPkce();
    reply.setCookie(PKCE_COOKIE, `${state}.${verifier}`, {
      path: "/auth",
      httpOnly: true,
      sameSite: "lax",
      secure: config.secureCookies,
      maxAge: 600,
    });
    return reply.redirect(authorizeUrl(config.oauth, challenge, state));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/auth/callback", async (req, reply) => {
    const fail = (why: string) => reply.redirect(`/app/?error=${encodeURIComponent(why)}`);
    if (!config.oauth) return fail("Kick login is not configured");
    const [state, verifier] = (req.cookies[PKCE_COOKIE] ?? "").split(".");
    reply.clearCookie(PKCE_COOKIE, { path: "/auth" });
    if (req.query.error) return fail(req.query.error);
    if (!req.query.code || !state || !verifier || req.query.state !== state) return fail("Login expired, try again");

    try {
      const token = await exchangeCode(config.oauth, req.query.code, verifier);
      const me = await fetchMe(token);
      let channel;
      try {
        channel = await lookupChannel(me.slug);
      } catch (err) {
        // Cloudflare sometimes blocks server IPs; the streamer can enter the chatroom id by hand.
        req.log.warn({ err, slug: me.slug }, "chatroom lookup failed");
        channel = { id: me.userId, slug: me.slug, displayName: me.slug, chatroomId: null };
      }
      if (channel.id !== me.userId) return fail("Channel does not belong to this account");
      login(reply, channel);
      return reply.redirect("/app/");
    } catch (err) {
      req.log.error({ err }, "oauth callback failed");
      return fail("Kick login failed");
    }
  });

  app.get<{ Querystring: { slug?: string } }>("/auth/dev", async (req, reply) => {
    if (!config.devLogin) return reply.code(404).send();
    const slug = req.query.slug?.trim().toLowerCase();
    if (!slug) return reply.code(400).send("slug required");
    try {
      login(reply, await lookupChannel(slug));
    } catch (err) {
      req.log.error({ err }, "dev login failed");
      return reply.redirect(`/app/?error=${encodeURIComponent(`Couldn't find channel "${slug}"`)}`);
    }
    return reply.redirect("/app/");
  });

  app.post("/auth/logout", async (req, reply) => {
    sessions.destroy(req, reply);
    return { ok: true };
  });

  // ---- queue API (session required) -----------------------------------------------------------

  const authed = (req: FastifyRequest, reply: FastifyReply): number | null => {
    const id = sessions.channelId(req);
    if (id === null || !queues.channel(id)) {
      reply.code(401).send({ error: "not logged in" });
      return null;
    }
    return id;
  };

  app.get("/api/state", async (req, reply) => {
    const id = authed(req, reply);
    if (id === null) return reply;
    return queues.state(id, chat.isConnected);
  });

  const idBody = z.object({ id: z.number().int() });
  const moveBody = z.object({ id: z.number().int(), index: z.number().int().min(0) });
  const nextBody = z.object({ skip: z.boolean().optional() }).optional();

  /** POST handler with a validated body. */
  const action = <S extends z.ZodTypeAny>(path: string, schema: S, run: (channelId: number, body: z.output<S>) => unknown) => {
    app.post(path, async (req, reply) => {
      const id = authed(req, reply);
      if (id === null) return reply;
      const body = schema.safeParse(req.body ?? undefined);
      if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? "bad request" });
      const ok = run(id, body.data);
      return ok === false ? reply.code(404).send({ error: "not found" }) : { ok: true };
    });
  };

  action("/api/queue/next", nextBody, (id, b) => queues.next(id, b?.skip ? "skipped" : "played"));
  action("/api/queue/previous", z.unknown(), (id) => queues.previous(id));
  action("/api/queue/play", idBody, (id, b) => queues.play(id, b.id));
  action("/api/queue/remove", idBody, (id, b) => queues.remove(id, b.id));
  action("/api/queue/move", moveBody, (id, b) => queues.move(id, b.id, b.index));
  action("/api/queue/clear", z.unknown(), (id) => queues.clear(id));
  action("/api/settings", settingsSchema.partial(), (id, b) => queues.updateSettings(id, b));
  const banBody = z.object({
    username: z.string().trim().min(1).max(64),
    /** null = permanent */
    minutes: z.number().int().min(1).max(MAX_TIMEOUT_MS / 60_000).nullable(),
  });
  action("/api/bans", banBody, (id, b) => queues.ban(id, b.username, b.minutes === null ? null : b.minutes * 60_000) !== null);
  action("/api/bans/remove", z.object({ username: z.string().trim().min(1).max(64) }), (id, b) => queues.unban(id, b.username));
  action("/api/chatroom",z.object({ chatroomId: z.number().int().positive() }), (id, b) => {
    const old = queues.channel(id)?.chatroomId;
    if (old === b.chatroomId) return;
    if (old) chat.leave(old);
    queues.setChatroom(id, b.chatroomId);
    chat.join(b.chatroomId);
  });

  // Dev only: pretend a chat message arrived, to test the whole pipeline without posting in Kick chat.
  if (config.devLogin) {
    const fakeChat = z.object({
      content: z.string().min(1),
      username: z.string().default("tester"),
      userId: z.number().int().default(1),
      badges: z.array(z.string()).default([]),
    });
    action("/api/dev/chat", fakeChat, (id, b) => {
      const chatroomId = queues.channel(id)?.chatroomId;
      if (!chatroomId) return false;
      chat.emit("message", {
        id: `dev-${Date.now()}-${Math.random()}`,
        chatroomId,
        content: b.content,
        sender: { id: b.userId, username: b.username, color: "#53fc18", badges: b.badges },
      });
    });
  }

  // ---- realtime -------------------------------------------------------------------------------

  const sockets = new Map<number, Set<WebSocket>>();
  const pending = new Set<number>();

  const push = (channelId: number) => {
    const set = sockets.get(channelId);
    if (!set?.size) return;
    const msg: ServerMessage = { type: "state", state: queues.state(channelId, chat.isConnected) };
    const data = JSON.stringify(msg);
    for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(data);
  };

  // Several changes in one tick (e.g. a mod clearing a spammer) become one push.
  queues.on("changed", (channelId) => {
    if (pending.has(channelId)) return;
    pending.add(channelId);
    setImmediate(() => {
      pending.delete(channelId);
      push(channelId);
    });
  });

  app.get("/ws", { websocket: true }, (socket, req) => {
    const channelId = sessions.channelId(req);
    if (channelId === null || !queues.channel(channelId)) {
      socket.close(4401, "not logged in");
      return;
    }
    let set = sockets.get(channelId);
    if (!set) sockets.set(channelId, (set = new Set()));
    set.add(socket);

    // Keeps proxies from closing an idle socket, and drops clients that vanished.
    let alive = true;
    socket.on("pong", () => (alive = true));
    const heartbeat = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, 30_000);

    socket.on("close", () => {
      clearInterval(heartbeat);
      set.delete(socket);
      if (!set.size) sockets.delete(channelId);
    });

    const msg: ServerMessage = { type: "state", state: queues.state(channelId, chat.isConnected) };
    socket.send(JSON.stringify(msg));
  });
}
