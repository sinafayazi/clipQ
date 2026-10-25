import { createHash, randomBytes } from "node:crypto";
import { getJson } from "../http-client.js";

// Kick OAuth 2.1 (authorization code + PKCE). Docs: https://docs.kick.com/getting-started/generating-tokens-oauth2-flow

const AUTHORIZE = "https://id.kick.com/oauth/authorize";
const TOKEN = "https://id.kick.com/oauth/token";
const API = "https://api.kick.com/public/v1";
const SCOPES = "user:read channel:read";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function createPkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  return { verifier, challenge, state };
}

export function authorizeUrl(cfg: OAuthConfig, challenge: string, state: string) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `${AUTHORIZE}?${q}`;
}

export async function exchangeCode(cfg: OAuthConfig, code: string, verifier: string): Promise<string> {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      code_verifier: verifier,
      code,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("token exchange returned no access_token");
  return body.access_token;
}

/** The logged-in user's id and channel slug. */
export async function fetchMe(accessToken: string): Promise<{ userId: number; slug: string }> {
  const auth = { authorization: `Bearer ${accessToken}` };
  const users = await getJson<{ data: { user_id: number; name: string }[] }>(`${API}/users`, { headers: auth });
  const user = users.data[0];
  if (!user) throw new Error("Kick returned no user");
  const channels = await getJson<{ data: { broadcaster_user_id: number; slug: string }[] }>(`${API}/channels`, {
    headers: auth,
  });
  const channel = channels.data.find((c) => c.broadcaster_user_id === user.user_id) ?? channels.data[0];
  return { userId: user.user_id, slug: channel?.slug ?? user.name.toLowerCase() };
}
