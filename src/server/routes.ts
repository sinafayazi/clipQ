import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import type { ServerMessage } from "../shared/types.js";
import { config } from "./config.js";
import { originAllowed } from "./origin.js";
import { lookupChannel } from "./kick/api.js";
import type { KickBot } from "./kick/bot.js";
import type { KickChat } from "./kick/chat.js";
import { authorizeUrl, createPkce, exchangeCode, fetchMe, fetchUser, VIEWER_SCOPES } from "./kick/oauth.js";
import { MAX_TIMEOUT_MS, settingsSchema, songSettingsSchema, type QueueService, type RejectReason } from "./queue/service.js";
import type { Sessions, ViewerSessions } from "./sessions.js";
import { rejectText } from "./songs/commands.js";
import { obsKeyValid } from "./songs/obs.js";
import { parseSongQuery } from "./songs/resolve.js";

const PKCE_COOKIE = "clipq_oauth";

interface Deps {
  queues: QueueService;
  chat: KickChat;
  sessions: Sessions;
  viewers: ViewerSessions;
  bot: KickBot;
}

export function registerRoutes(app: FastifyInstance, { queues, chat, sessions, viewers, bot }: Deps) {
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

  /** Start Kick's OAuth flow. The cookie remembers the PKCE verifier and where to land afterwards. */
  function startOAuth(reply: FastifyReply, mode: "streamer" | "viewer", slug = "") {
    const oauth = config.oauth!;
    const { verifier, challenge, state } = createPkce();
    reply.setCookie(PKCE_COOKIE, [state, verifier, mode, slug].join("."), {
      path: "/auth",
      httpOnly: true,
      sameSite: "lax",
      secure: config.secureCookies,
      maxAge: 600,
    });
    return reply.redirect(authorizeUrl(oauth, challenge, state, mode === "viewer" ? VIEWER_SCOPES : undefined));
  }

  app.get("/auth/login", async (_req, reply) => {
    if (!config.oauth) return reply.code(503).send("Kick login is not configured (KICK_CLIENT_ID).");
    return startOAuth(reply, "streamer");
  });

  // Viewers log in from a song page to see and change their own songs.
  app.get<{ Querystring: { c?: string } }>("/auth/viewer", async (req, reply) => {
    const slug = (req.query.c ?? "").toLowerCase();
    if (!/^[a-z0-9_-]{1,40}$/.test(slug)) return reply.code(400).send("bad channel");
    if (!config.oauth) {
      // Dev: no Kick app. Log in as a made-up viewer named by ?name=, for testing the song page.
      if (!config.devLogin) return reply.code(503).send("Kick login is not configured (KICK_CLIENT_ID).");
      const name = String((req.query as { name?: string }).name ?? "viewer").slice(0, 25);
      viewers.create(reply, { id: 900_000 + [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 99_999, 7), username: name });
      return reply.redirect(`/s/${slug}`);
    }
    return startOAuth(reply, "viewer", slug);
  });

  app.post("/auth/viewer/logout", async (req, reply) => {
    viewers.destroy(req, reply);
    return { ok: true };
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/auth/callback", async (req, reply) => {
    const [state, verifier, mode, slug] = (req.cookies[PKCE_COOKIE] ?? "").split(".");
    const home = mode === "viewer" && slug ? `/s/${slug}` : "/app/";
    const fail = (why: string) => reply.redirect(`${home}?error=${encodeURIComponent(why)}`);
    if (!config.oauth) return fail("Kick login is not configured");
    reply.clearCookie(PKCE_COOKIE, { path: "/auth" });
    if (req.query.error) return fail(req.query.error);
    if (!req.query.code || !state || !verifier || req.query.state !== state) return fail("Login expired, try again");

    if (mode === "viewer") {
      try {
        const tokens = await exchangeCode(config.oauth, req.query.code, verifier);
        viewers.create(reply, await fetchUser(tokens.accessToken));
        return reply.redirect(home);
      } catch (err) {
        req.log.error({ err }, "viewer oauth callback failed");
        return fail("Kick login failed");
      }
    }

    try {
      const tokens = await exchangeCode(config.oauth, req.query.code, verifier);
      const me = await fetchMe(tokens.accessToken);
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
      bot.saveTokens(channel.id, tokens);
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
  const kind = z.enum(["clips", "songs"]).default("clips");
  const kindBody = z.object({ kind }).default({});
  const nextBody = z
    .object({
      skip: z.boolean().optional(),
      kind,
      /** Only advance if this is still what's playing (a player that ended, racing another one). */
      ifCurrent: z.number().int().optional(),
    })
    .default({});
  const settingsBody = settingsSchema.partial().extend({ songs: songSettingsSchema.partial().optional() });

  /** Advance a list, unless `ifCurrent` says the caller is reacting to something already gone. */
  const advance = (channelId: number, b: z.output<typeof nextBody>) => {
    if (b.ifCurrent !== undefined) {
      const s = queues.state(channelId, false);
      const current = b.kind === "songs" ? s.songs.current : s.current;
      if (current?.id !== b.ifCurrent) return;
    }
    queues.next(channelId, b.skip ? "skipped" : "played", b.kind);
  };

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

  action("/api/queue/next", nextBody, advance);
  action("/api/queue/previous", kindBody, (id, b) => queues.previous(id, b.kind));
  action("/api/queue/play", idBody, (id, b) => queues.play(id, b.id));
  action("/api/queue/remove", idBody, (id, b) => queues.remove(id, b.id));
  action("/api/queue/move", moveBody, (id, b) => queues.move(id, b.id, b.index));
  action("/api/queue/clear", kindBody, (id, b) => queues.clear(id, b.kind));
  action("/api/settings", settingsBody, (id, { songs, ...rest }) =>
    queues.updateSettings(id, songs ? { ...rest, songs: { ...queues.settings(id).songs, ...songs } } : rest),
  );
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

  // Sends a test message as the bot and reports what Kick said, so the streamer can see why replies fail.
  app.post("/api/bot/test", async (req, reply) => {
    const id = authed(req, reply);
    if (id === null) return reply;
    const error = await bot.send(id, "clipQ bot is connected. Type !cq commands to see the commands.");
    const scopes = error ? await bot.scopes(id) : null;
    return { ok: error === null, error, scopes };
  });

  // ---- public song page (/s/<channel>): anyone can look, logged-in viewers manage their own songs ----

  const songChannel = (slug: string) => queues.channelBySlug(slug);
  const queryBody = z.object({ query: z.string().trim().min(1).max(300) });
  const songFailure = (reply: FastifyReply, channelId: number, reason: RejectReason) => {
    const text = rejectText(reason, queues.settings(channelId).songs) ?? "That song can't be added.";
    // "You can't…" reads fine on a page, without the chat-style lowercase start.
    return reply.code(409).send({ error: text.charAt(0).toUpperCase() + text.slice(1).replace("Type !wrongsong to remove your last one.", "Remove one first.") });
  };

  app.get<{ Params: { slug: string } }>("/api/s/:slug", async (req, reply) => {
    const c = songChannel(req.params.slug);
    if (!c) return reply.code(404).send({ error: "This channel doesn't use clipQ." });
    return queues.publicSongs(c.id, viewers.viewer(req));
  });

  /** A viewer action on a song page: needs the viewer to be logged in. */
  const viewerAction = <S extends z.ZodTypeAny>(
    path: string,
    schema: S,
    run: (channelId: number, viewer: { id: number; username: string }, body: z.output<S>, params: Record<string, string>, reply: FastifyReply) => unknown,
  ) => {
    app.post<{ Params: Record<string, string> }>(path, async (req, reply) => {
      const c = songChannel(req.params.slug ?? "");
      if (!c) return reply.code(404).send({ error: "not found" });
      const viewer = viewers.viewer(req);
      if (!viewer) return reply.code(401).send({ error: "Log in with Kick first." });
      const body = schema.safeParse(req.body ?? undefined);
      if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? "bad request" });
      return run(c.id, viewer, body.data, req.params, reply);
    });
  };

  viewerAction("/api/s/:slug/request", queryBody, async (channelId, viewer, b, _p, reply) => {
    const q = parseSongQuery(b.query);
    if (!q) return reply.code(400).send({ error: "Paste a YouTube or Spotify link, or type the song's name." });
    const r = await queues.requestSong(channelId, q, { ...viewer, color: null }, null);
    return r.ok ? { ok: true } : songFailure(reply, channelId, r.reason);
  });

  viewerAction("/api/s/:slug/songs/:id/replace", queryBody, async (channelId, viewer, b, p, reply) => {
    const q = parseSongQuery(b.query);
    if (!q) return reply.code(400).send({ error: "Paste a YouTube or Spotify link, or type the song's name." });
    const r = await queues.replaceSong(channelId, Number(p.id), viewer, q);
    return r.ok ? { ok: true } : songFailure(reply, channelId, r.reason);
  });

  viewerAction("/api/s/:slug/songs/:id/remove", z.unknown(), (channelId, viewer, _b, p, reply) =>
    queues.removeOwnSong(channelId, Number(p.id), viewer.id) ? { ok: true } : reply.code(404).send({ error: "That song isn't waiting any more." }),
  );

  // ---- OBS song player: a browser source with no login, authorised by the key in its link ----

  const obsQuery = z.object({ c: z.coerce.number().int(), k: z.string().max(64) });
  const obsChannel = (raw: unknown): number | null => {
    const q = obsQuery.safeParse(raw);
    return q.success && queues.channel(q.data.c) && obsKeyValid(q.data.c, q.data.k) ? q.data.c : null;
  };

  app.get("/api/obs/state", async (req, reply) => {
    const id = obsChannel(req.query);
    if (id === null) return reply.code(401).send({ error: "This OBS link is wrong or old. Copy it again from clipQ." });
    const s = queues.state(id, chat.isConnected);
    return { player: s.settings.songs.player, volume: s.settings.songs.volume, current: s.songs.current, startedAt: s.songs.startedAt };
  });

  app.post("/api/obs/next", async (req, reply) => {
    const id = obsChannel(req.query);
    if (id === null) return reply.code(401).send({ error: "bad key" });
    const b = z.object({ ifCurrent: z.number().int() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "bad request" });
    advance(id, { kind: "songs", ifCurrent: b.data.ifCurrent });
    return { ok: true };
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
