const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

function hostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function port(url: URL): string {
  if (url.port) return url.port;
  if (url.protocol === "https:") return "443";
  if (url.protocol === "http:") return "80";
  return "";
}

/** CSRF: Origin must match PUBLIC_URL. Loopback aliases count as the same host. */
export function originAllowed(origin: string, publicOrigin: string): boolean {
  if (origin === publicOrigin) return true;
  let a: URL;
  let b: URL;
  try {
    a = new URL(origin);
    b = new URL(publicOrigin);
  } catch {
    return false;
  }
  if (a.protocol !== b.protocol || port(a) !== port(b)) return false;
  const ha = hostname(a);
  const hb = hostname(b);
  if (ha === hb) return true;
  return LOOPBACK.has(ha) && LOOPBACK.has(hb);
}
