import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import type { Sessions } from "./sessions.js";

function escapeAttr(s: string) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Placeholder in the landing HTML for the absolute site URL (canonical, hreflang, og:image). */
const SITE_URL = "__SITE_URL__";

/**
 * Serves the built site: static landing pages at / and /fa/, the dashboard app under /app/, assets,
 * robots.txt and sitemap.xml. In dev, Vite serves the pages instead and only the API runs here.
 */
export async function registerSite(app: FastifyInstance, webRoot: string, sessions: Sessions) {
  if (!existsSync(webRoot)) return;

  const page = (file: string) => readFileSync(join(webRoot, file), "utf8").replaceAll(SITE_URL, config.publicUrl);
  // Search Console ownership check: the token is per site, so it comes from the environment.
  const verify = config.googleSiteVerification;
  const withVerification = (html: string) =>
    verify ? html.replace("</head>", `  <meta name="google-site-verification" content="${escapeAttr(verify)}" />\n  </head>`) : html;
  const landingEn = withVerification(page("index.html"));
  const landingFa = withVerification(page("fa/index.html"));
  const dashboard = page("app/index.html");
  const songPage = page("s/index.html");
  const obsPage = page("obs/index.html");

  await app.register(fastifyStatic, {
    root: webRoot,
    index: false,
    // HTML goes through the routes below, never straight from disk.
    allowedPath: (path) => !path.endsWith(".html"),
    // Our own Cache-Control: the plugin's would overwrite anything set in setHeaders.
    cacheControl: false,
    setHeaders: (res, path) => {
      // Vite puts a content hash in /assets/ names, so they never change.
      res.setHeader("cache-control", path.includes("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=3600");
    },
  });

  const html = (body: string) => (_req: unknown, reply: import("fastify").FastifyReply) =>
    reply.type("text/html; charset=utf-8").header("cache-control", "no-cache").send(body);

  // Someone already logged in who opens the home page wants their queue.
  app.get("/", (req, reply) => (sessions.channelId(req) !== null ? reply.redirect("/app/") : html(landingEn)(req, reply)));
  app.get("/fa/", html(landingFa));
  app.get("/fa", (_req, reply) => reply.redirect("/fa/", 301));
  app.get("/app", (_req, reply) => reply.redirect("/app/", 301));
  app.get("/app/", html(dashboard));
  // One page for every channel's song list; it reads the channel from the URL.
  app.get("/s/:slug", html(songPage));
  app.get("/obs/", html(obsPage));

  app.get("/robots.txt", (_req, reply) =>
    reply.type("text/plain").send(
      ["User-agent: *", "Allow: /", "Disallow: /app/", "Disallow: /api/", "Disallow: /auth/", "Disallow: /obs/", `Sitemap: ${config.publicUrl}/sitemap.xml`, ""].join("\n"),
    ),
  );

  app.get("/sitemap.xml", (_req, reply) => {
    const alternates = `
    <xhtml:link rel="alternate" hreflang="en" href="${config.publicUrl}/"/>
    <xhtml:link rel="alternate" hreflang="fa" href="${config.publicUrl}/fa/"/>
    <xhtml:link rel="alternate" hreflang="x-default" href="${config.publicUrl}/"/>`;
    const url = (loc: string) => `  <url>\n    <loc>${loc}</loc>${alternates}\n  </url>`;
    reply.type("application/xml").send(
      `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${url(`${config.publicUrl}/`)}
${url(`${config.publicUrl}/fa/`)}
</urlset>
`,
    );
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.method !== "GET" || req.url.startsWith("/api/") || req.url.startsWith("/auth/")) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.code(404).type("text/html; charset=utf-8").send(landingEn);
  });
}
