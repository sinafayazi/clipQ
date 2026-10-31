import { createHash, randomBytes } from "node:crypto";
import { getJson } from "../http-client.js";

// Kick OAuth 2.1 (authorization code + PKCE). Docs: https://docs.kick.com/getting-started/generating-tokens-oauth2-flow

const AUTHORIZE = "https://id.kick.com/oauth/authorize";
const TOKEN = "https://id.kick.com/oauth/token";
const API = "https://api.kick.com/public/v1";
// chat:write lets clipQ's bot reply in the streamer's chat (vote counts, the command list).
export const STREAMER_SCOPES = "user:read channel:read chat:write";
/** Viewers logging in on a song page: just who they are. */
export const VIEWER_SCOPES = "user:read";

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** ms */
  expiresAt: number;
}

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

export function authorizeUrl(cfg: OAuthConfig, challenge: string, state: string, scope = STREAMER_SCOPES) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `${AUTHORIZE}?${q}`;
}

export function exchangeCode(cfg: OAuthConfig, code: string, verifier: string): Promise<Tokens> {
  return tokenRequest({
    grant_type: "authorization_code",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    code_verifier: verifier,
    code,
  });
}

export function refreshTokens(cfg: OAuthConfig, refreshToken: string): Promise<Tokens> {
  return tokenRequest({
    grant_type: "refresh_token",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken,
  });
}

async function tokenRequest(params: Record<string, string>): Promise<Tokens> {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${params.grant_type} failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error(`${params.grant_type} returned no access_token`);
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? params.refresh_token ?? "",
    // Seconds; assume an hour if Kick leaves it out.
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
  };
}

/** The logged-in user's id and name. */
export async function fetchUser(accessToken: string): Promise<{ id: number; username: string }> {
  const users = await getJson<{ data: { user_id: number; name: string }[] }>(`${API}/users`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const user = users.data[0];
  if (!user) throw new Error("Kick returned no user");
  return { id: user.user_id, username: user.name };
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
