import { audit } from "./db";
import {
  cloudflareApi,
  exchangeAuthorizationCode,
  getConnection,
  getValidAccessToken,
} from "./cloudflare-api";
import { HttpError, json, redirect } from "./http";
import {
  addSecondsIso,
  decryptJson,
  encryptJson,
  nowIso,
  normalizeBaseUrl,
  randomToken,
  sha256,
} from "./security";
import type { Env, SessionPrincipal } from "./types";

export async function startCloudflareOAuth(env: Env, principal: SessionPrincipal): Promise<Response> {
  if (!env.CF_OAUTH_CLIENT_ID || env.CF_OAUTH_CLIENT_ID.startsWith("replace")) {
    throw new HttpError(503, "oauth_not_configured", "Cloudflare OAuth is not configured");
  }
  const state = randomToken(32);
  const stateHash = await sha256(state);
  const verifier = randomToken(48);
  const challenge = await sha256(verifier);
  const redirectUri = `${normalizeBaseUrl(env.PUBLIC_BASE_URL)}/oauth/cloudflare/callback`;
  const verifierEnc = await encryptJson(verifier, env.TOKEN_ENCRYPTION_KEY, `oauth-state:${stateHash}`);
  await env.DB.prepare(
    `INSERT INTO oauth_states
      (state_hash, tenant_id, session_hash, pkce_verifier_enc, redirect_uri, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(stateHash, principal.tenantId, principal.sessionHash, verifierEnc, redirectUri, addSecondsIso(600), nowIso()).run();

  const authorizationUrl = new URL("https://dash.cloudflare.com/oauth2/auth");
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", env.CF_OAUTH_CLIENT_ID);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  await audit(env, {
    tenantId: principal.tenantId,
    actorType: "user",
    actorId: principal.telegramUserId,
    action: "oauth.cloudflare.start",
    outcome: "success",
  });
  return redirect(authorizationUrl.toString(), 302);
}

export async function finishCloudflareOAuth(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  if (state.length < 32 || state.length > 128) throw new HttpError(400, "invalid_oauth_state", "OAuth state is invalid");
  const stateHash = await sha256(state);
  const row = await env.DB.prepare(
    `SELECT tenant_id, session_hash, pkce_verifier_enc, redirect_uri, expires_at, consumed_at
     FROM oauth_states WHERE state_hash = ?`,
  ).bind(stateHash).first<{
    tenant_id: string;
    session_hash: string;
    pkce_verifier_enc: string;
    redirect_uri: string;
    expires_at: string;
    consumed_at: string | null;
  }>();
  if (
    !row || row.consumed_at || Date.parse(row.expires_at) <= Date.now() ||
    row.tenant_id !== principal.tenantId || row.session_hash !== principal.sessionHash
  ) {
    throw new HttpError(400, "invalid_oauth_state", "OAuth state is invalid or expired");
  }
  const consumed = await env.DB.prepare(
    "UPDATE oauth_states SET consumed_at = ? WHERE state_hash = ? AND consumed_at IS NULL",
  ).bind(nowIso(), stateHash).run();
  if ((consumed.meta.changes ?? 0) !== 1) throw new HttpError(409, "oauth_state_used", "OAuth request was already completed");

  const providerError = url.searchParams.get("error");
  if (providerError) {
    await audit(env, {
      tenantId: principal.tenantId,
      actorType: "user",
      actorId: principal.telegramUserId,
      action: "oauth.cloudflare.finish",
      outcome: "denied",
      metadata: { providerError: providerError.slice(0, 80) },
    });
    throw new HttpError(400, "oauth_denied", "Cloudflare authorization was not granted");
  }
  const code = url.searchParams.get("code") ?? "";
  if (!code || code.length > 2048) throw new HttpError(400, "oauth_code_missing", "Authorization code is missing");
  const verifier = await decryptJson<string>(row.pkce_verifier_enc, env.TOKEN_ENCRYPTION_KEY, `oauth-state:${stateHash}`);
  const token = await exchangeAuthorizationCode(env, code, verifier, row.redirect_uri);
  const connectionId = crypto.randomUUID();
  const accessTokenEnc = await encryptJson(token.access_token, env.TOKEN_ENCRYPTION_KEY, `oauth:${connectionId}:access`);
  const refreshTokenEnc = token.refresh_token
    ? await encryptJson(token.refresh_token, env.TOKEN_ENCRYPTION_KEY, `oauth:${connectionId}:refresh`)
    : null;
  const expiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null;

  let cfUserId: string | null = null;
  let cfEmail: string | null = null;
  const userInfoResponse = await fetch("https://dash.cloudflare.com/oauth2/userinfo", {
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" },
  });
  if (userInfoResponse.ok) {
    const userInfo = await userInfoResponse.json<{ sub?: string; email?: string }>();
    cfUserId = userInfo.sub?.slice(0, 128) ?? null;
    cfEmail = userInfo.email?.slice(0, 254) ?? null;
  }
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO oauth_connections
      (id, tenant_id, access_token_enc, refresh_token_enc, expires_at, scopes, cf_user_id, cf_email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    connectionId,
    principal.tenantId,
    accessTokenEnc,
    refreshTokenEnc,
    expiresAt,
    token.scope ?? null,
    cfUserId,
    cfEmail,
    now,
    now,
  ).run();
  await audit(env, {
    tenantId: principal.tenantId,
    actorType: "user",
    actorId: principal.telegramUserId,
    action: "oauth.cloudflare.finish",
    resourceType: "oauth_connection",
    resourceId: connectionId,
    outcome: "success",
  });
  return redirect("/app?connected=1", 303);
}

export async function listCloudflareConnections(env: Env, principal: SessionPrincipal): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT id, cf_email, scopes, expires_at, created_at, updated_at
     FROM oauth_connections WHERE tenant_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
  ).bind(principal.tenantId).all();
  return json({ connections: result.results });
}

export async function listCloudflareAccounts(
  env: Env,
  principal: SessionPrincipal,
  connectionId: string,
): Promise<Response> {
  const connection = await getConnection(env, connectionId, principal.tenantId);
  const token = await getValidAccessToken(env, connection);
  const accounts = await cloudflareApi<Array<{ id: string; name: string }>>(token, "/accounts?per_page=50");
  return json({ accounts: accounts.map(({ id, name }) => ({ id, name })) });
}

export async function listCloudflareZones(
  env: Env,
  principal: SessionPrincipal,
  connectionId: string,
  accountId: string,
): Promise<Response> {
  const connection = await getConnection(env, connectionId, principal.tenantId);
  const token = await getValidAccessToken(env, connection);
  const zones = await cloudflareApi<Array<{ id: string; name: string; status: string }>>(
    token,
    `/zones?account.id=${encodeURIComponent(accountId)}&status=active&per_page=50`,
  );
  return json({ zones: zones.map(({ id, name, status }) => ({ id, name, status })) });
}
