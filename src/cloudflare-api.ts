import { decryptJson, encryptJson, nowIso } from "./security";
import type { ConnectionRow, Env } from "./types";

interface CloudflareEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message?: string }>;
}

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

function basicAuthorization(clientId: string, clientSecret: string): string {
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

export async function exchangeAuthorizationCode(
  env: Env,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const response = await fetch("https://dash.cloudflare.com/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: basicAuthorization(env.CF_OAUTH_CLIENT_ID, env.CF_OAUTH_CLIENT_SECRET),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  const result = await response.json<OAuthTokenResponse & { error?: string }>();
  if (!response.ok || !result.access_token) throw new Error(`Cloudflare OAuth exchange failed: ${result.error ?? response.status}`);
  return result;
}

async function refreshConnection(env: Env, connection: ConnectionRow): Promise<{ token: string; connection: ConnectionRow }> {
  if (!connection.refresh_token_enc) throw new Error("Cloudflare authorization expired; reconnect required");
  const refreshToken = await decryptJson<string>(
    connection.refresh_token_enc,
    env.TOKEN_ENCRYPTION_KEY,
    `oauth:${connection.id}:refresh`,
  );
  const response = await fetch("https://dash.cloudflare.com/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: basicAuthorization(env.CF_OAUTH_CLIENT_ID, env.CF_OAUTH_CLIENT_SECRET),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  const result = await response.json<OAuthTokenResponse & { error?: string }>();
  if (!response.ok || !result.access_token) throw new Error(`Cloudflare OAuth refresh failed: ${result.error ?? response.status}`);
  const nextRefreshToken = result.refresh_token ?? refreshToken;
  const accessTokenEnc = await encryptJson(result.access_token, env.TOKEN_ENCRYPTION_KEY, `oauth:${connection.id}:access`);
  const refreshTokenEnc = await encryptJson(nextRefreshToken, env.TOKEN_ENCRYPTION_KEY, `oauth:${connection.id}:refresh`);
  const expiresAt = result.expires_in ? new Date(Date.now() + result.expires_in * 1000).toISOString() : null;
  const updatedAt = nowIso();
  await env.DB.prepare(
    `UPDATE oauth_connections SET access_token_enc = ?, refresh_token_enc = ?, expires_at = ?, scopes = COALESCE(?, scopes), updated_at = ?
     WHERE id = ? AND revoked_at IS NULL`,
  ).bind(accessTokenEnc, refreshTokenEnc, expiresAt, result.scope ?? null, updatedAt, connection.id).run();
  return {
    token: result.access_token,
    connection: {
      ...connection,
      access_token_enc: accessTokenEnc,
      refresh_token_enc: refreshTokenEnc,
      expires_at: expiresAt,
      scopes: result.scope ?? connection.scopes,
      updated_at: updatedAt,
    },
  };
}

export async function getConnection(env: Env, connectionId: string, tenantId?: string): Promise<ConnectionRow> {
  const query = tenantId
    ? "SELECT * FROM oauth_connections WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL"
    : "SELECT * FROM oauth_connections WHERE id = ? AND revoked_at IS NULL";
  const connection = tenantId
    ? await env.DB.prepare(query).bind(connectionId, tenantId).first<ConnectionRow>()
    : await env.DB.prepare(query).bind(connectionId).first<ConnectionRow>();
  if (!connection) throw new Error("Cloudflare connection not found");
  return connection;
}

export async function getValidAccessToken(env: Env, connection: ConnectionRow): Promise<string> {
  if (connection.revoked_at) throw new Error("Cloudflare connection is revoked");
  if (connection.expires_at && Date.parse(connection.expires_at) <= Date.now() + 60_000) {
    return (await refreshConnection(env, connection)).token;
  }
  return decryptJson<string>(connection.access_token_enc, env.TOKEN_ENCRYPTION_KEY, `oauth:${connection.id}:access`);
}

export async function cloudflareApi<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/json");
  if (init?.body && !headers.has("Content-Type") && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers });
  let envelope: CloudflareEnvelope<T>;
  try {
    envelope = await response.json<CloudflareEnvelope<T>>();
  } catch {
    throw new Error(`Cloudflare API returned non-JSON status ${response.status}`);
  }
  if (!response.ok || !envelope.success) {
    const code = envelope.errors?.[0]?.code ?? response.status;
    throw new Error(`Cloudflare API request failed with code ${code}`);
  }
  return envelope.result;
}

export async function uploadWorkerScript(
  token: string,
  accountId: string,
  scriptName: string,
  source: string,
  secretBindings: Record<string, string>,
): Promise<void> {
  const bindings = Object.entries(secretBindings).map(([name, text]) => ({ type: "secret_text", name, text }));
  const metadata = {
    main_module: "worker.mjs",
    compatibility_date: "2026-09-09",
    compatibility_flags: [],
    bindings,
  };
  const body = new FormData();
  body.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  body.set("worker.mjs", new Blob([source], { type: "application/javascript+module" }), "worker.mjs");
  await cloudflareApi<unknown>(token, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}`, {
    method: "PUT",
    body,
  });
}

export async function attachWorkerDomain(
  token: string,
  accountId: string,
  zoneId: string,
  hostname: string,
  scriptName: string,
): Promise<void> {
  await cloudflareApi<unknown>(token, `/accounts/${accountId}/workers/domains`, {
    method: "PUT",
    body: JSON.stringify({ hostname, service: scriptName, zone_id: zoneId }),
  });
}

export async function upsertARecord(token: string, zoneId: string, hostname: string, ipv4: string): Promise<string> {
  const records = await cloudflareApi<Array<{ id: string; type: string; name: string }>>(
    token,
    `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(hostname)}&per_page=10`,
  );
  const payload = JSON.stringify({ type: "A", name: hostname, content: ipv4, ttl: 300, proxied: false });
  const existing = records[0];
  if (existing) {
    const updated = await cloudflareApi<{ id: string }>(token, `/zones/${zoneId}/dns_records/${existing.id}`, { method: "PUT", body: payload });
    return updated.id;
  }
  const created = await cloudflareApi<{ id: string }>(token, `/zones/${zoneId}/dns_records`, { method: "POST", body: payload });
  return created.id;
}

export async function verifyZoneOwnership(token: string, zoneId: string, accountId: string): Promise<void> {
  const zone = await cloudflareApi<{ id: string; account: { id: string }; status: string }>(token, `/zones/${zoneId}`);
  if (zone.account.id !== accountId || zone.status !== "active") throw new Error("Selected zone is not active in the selected account");
}
