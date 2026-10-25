// Outbound HTTP helpers.
// Don't fake a browser User-Agent: Kick's Cloudflare compares it with the TLS fingerprint and returns
// 403 when a "Chrome" UA arrives over Node's TLS. Node's default UA passes.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
  }
}

export async function getJson<T>(url: string, init: RequestInit = {}, timeoutMs = 6000): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { accept: "application/json", ...init.headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new HttpError(res.status, url);
  return (await res.json()) as T;
}
