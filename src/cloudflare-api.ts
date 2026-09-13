import { HttpError } from "./http";
import { decryptJson, nowIso } from "./security";
import type { ConnectionRow, Env } from "./types";

interface CloudflareEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message?: string }>;
}

export type CloudflareAuth = { kind: "api_token"; token: string };

export async function getConnection(env: Env, connectionId: string, tenantId?: string): Promise<ConnectionRow> {
  const query = tenantId
    ? "SELECT * FROM oauth_connections WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL"
    : "SELECT * FROM oauth_connections WHERE id = ? AND revoked_at IS NULL";
  const connection = tenantId
    ? await env.DB.prepare(query).bind(connectionId, tenantId).first<ConnectionRow>()
    : await env.DB.prepare(query).bind(connectionId).first<ConnectionRow>();
  if (!connection) throw new HttpError(409, "cloudflare_reconnect_required", "Cloudflare connection not found");
  return connection;
}

export async function getValidCloudflareAuth(env: Env, connection: ConnectionRow): Promise<CloudflareAuth> {
  if (connection.revoked_at) throw new Error("Cloudflare connection is revoked");
  if (connection.auth_type !== "api_token") {
    throw new Error("OAuth-based Cloudflare connections are no longer supported; reconnect with a scoped API token");
  }
  if (connection.expires_at && Date.parse(connection.expires_at) <= Date.now()) {
    throw new Error("Temporary Cloudflare API token expired; reconnect required");
  }
  const token = await decryptJson<string>(
    connection.access_token_enc,
    env.TOKEN_ENCRYPTION_KEY,
    `cloudflare:${connection.id}:api-token`,
  );
  return { kind: "api_token", token };
}

async function scrubConnection(env: Env, connectionId: string): Promise<void> {
  const revokedAt = nowIso();
  await env.DB.prepare(
    `UPDATE oauth_connections
     SET access_token_enc = 'erased', refresh_token_enc = NULL, expires_at = NULL,
         revoked_at = ?, updated_at = ?
     WHERE id = ? AND revoked_at IS NULL`,
  ).bind(revokedAt, revokedAt, connectionId).run();
}

export async function revokeConnectionGrant(env: Env, connection: ConnectionRow): Promise<void> {
  if (connection.revoked_at) return;
  await scrubConnection(env, connection.id);
}

export async function disconnectConnectionIfIdle(
  env: Env,
  connectionId: string,
  excludingDeploymentId?: string,
): Promise<boolean> {
  const active = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM deployments
     WHERE oauth_connection_id = ? AND id != ?
       AND status IN ('queued', 'preparing', 'awaiting_agent', 'agent_ready', 'finalizing', 'revoking')`,
  ).bind(connectionId, excludingDeploymentId ?? "").first<{ count: number }>();
  if ((active?.count ?? 0) > 0) return false;
  const connection = await env.DB.prepare(
    "SELECT * FROM oauth_connections WHERE id = ? AND revoked_at IS NULL",
  ).bind(connectionId).first<ConnectionRow>();
  if (!connection) return false;
  await revokeConnectionGrant(env, connection);
  return true;
}

export async function eraseExpiredApiTokens(env: Env): Promise<number> {
  const erasedAt = nowIso();
  const result = await env.DB.prepare(
    `UPDATE oauth_connections
     SET access_token_enc = 'expired', refresh_token_enc = NULL, expires_at = NULL,
         revoked_at = ?, updated_at = ?
     WHERE auth_type = 'api_token' AND revoked_at IS NULL
       AND expires_at IS NOT NULL AND expires_at <= ?`,
  ).bind(erasedAt, erasedAt, erasedAt).run();
  return result.meta.changes ?? 0;
}

function applyCloudflareAuth(headers: Headers, auth: CloudflareAuth): void {
  headers.set("Authorization", `Bearer ${auth.token}`);
}

export async function cloudflareApi<T>(auth: CloudflareAuth, path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  applyCloudflareAuth(headers, auth);
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
    const detail = envelope.errors?.[0]?.message ?? "";
    throw new HttpError(502, "cloudflare_api_error", `Cloudflare API ${path} failed: code ${code} ${detail}`.trim());
  }
  return envelope.result;
}

export async function uploadWorkerScript(
  auth: CloudflareAuth,
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
  await cloudflareApi<unknown>(auth, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}`, {
    method: "PUT",
    body,
  });
}

export async function attachWorkerDomain(
  auth: CloudflareAuth,
  accountId: string,
  zoneId: string,
  hostname: string,
  scriptName: string,
): Promise<void> {
  await cloudflareApi<unknown>(auth, `/accounts/${accountId}/workers/domains`, {
    method: "PUT",
    body: JSON.stringify({ hostname, service: scriptName, zone_id: zoneId }),
  });
}

export async function upsertARecord(auth: CloudflareAuth, zoneId: string, hostname: string, ipv4: string): Promise<string> {
  const records = await cloudflareApi<Array<{ id: string; type: string; name: string }>>(
    auth,
    `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(hostname)}&per_page=10`,
  );
  const payload = JSON.stringify({ type: "A", name: hostname, content: ipv4, ttl: 300, proxied: false });
  const existing = records[0];
  if (existing) {
    const updated = await cloudflareApi<{ id: string }>(auth, `/zones/${zoneId}/dns_records/${existing.id}`, { method: "PUT", body: payload });
    return updated.id;
  }
  const created = await cloudflareApi<{ id: string }>(auth, `/zones/${zoneId}/dns_records`, { method: "POST", body: payload });
  return created.id;
}

/** Upsert an NS delegation record (used by the DNS-tunnel provisioner). */
export async function upsertNsRecord(auth: CloudflareAuth, zoneId: string, name: string, targets: string[]): Promise<string> {
  const records = await cloudflareApi<Array<{ id: string; type: string; name: string }>>(
    auth,
    `/zones/${zoneId}/dns_records?type=NS&name=${encodeURIComponent(name)}&per_page=10`,
  );
  const payload = JSON.stringify({ type: "NS", name, content: targets[0] ?? "", ttl: 300, proxied: false });
  const existing = records[0];
  if (existing) {
    const updated = await cloudflareApi<{ id: string }>(auth, `/zones/${zoneId}/dns_records/${existing.id}`, { method: "PUT", body: payload });
    return updated.id;
  }
  const created = await cloudflareApi<{ id: string }>(auth, `/zones/${zoneId}/dns_records`, { method: "POST", body: payload });
  return created.id;
}

/** Upsert a TXT record (used by the WhiteHole dead-drop writer). */
export async function upsertTxtRecord(
  auth: CloudflareAuth,
  zoneId: string,
  name: string,
  value: string,
  ttl = 120,
): Promise<string> {
  const records = await cloudflareApi<Array<{ id: string; type: string; name: string }>>(
    auth,
    `/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(name)}&per_page=10`,
  );
  const payload = JSON.stringify({ type: "TXT", name, content: value.slice(0, 4_500), ttl, proxied: false });
  const existing = records[0];
  if (existing) {
    const updated = await cloudflareApi<{ id: string }>(auth, `/zones/${zoneId}/dns_records/${existing.id}`, { method: "PUT", body: payload });
    return updated.id;
  }
  const created = await cloudflareApi<{ id: string }>(auth, `/zones/${zoneId}/dns_records`, { method: "POST", body: payload });
  return created.id;
}

/** Upsert any simple record type (TXT/SVCB/CNAME/…) by exact name. */
export async function upsertDnsRecord(
  auth: CloudflareAuth,
  zoneId: string,
  type: string,
  name: string,
  content: string,
  ttl = 300,
): Promise<string> {
  const records = await cloudflareApi<Array<{ id: string }>>(
    auth,
    `/zones/${zoneId}/dns_records?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}&per_page=10`,
  );
  const payload = JSON.stringify({ type, name, content, ttl, proxied: false });
  const existing = records[0];
  if (existing) {
    const updated = await cloudflareApi<{ id: string }>(auth, `/zones/${zoneId}/dns_records/${existing.id}`, {
      method: "PUT",
      body: payload,
    });
    return updated.id;
  }
  const created = await cloudflareApi<{ id: string }>(auth, `/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: payload,
  });
  return created.id;
}

export async function deleteTxtRecords(auth: CloudflareAuth, zoneId: string, name: string): Promise<number> {
  const records = await cloudflareApi<Array<{ id: string }>>(
    auth,
    `/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(name)}&per_page=20`,
  );
  let removed = 0;
  for (const record of records) {
    await cloudflareApi<unknown>(auth, `/zones/${zoneId}/dns_records/${record.id}`, { method: "DELETE" });
    removed += 1;
  }
  return removed;
}

export async function verifyZoneOwnership(auth: CloudflareAuth, zoneId: string, accountId: string): Promise<void> {
  const zone = await cloudflareApi<{ id: string; account: { id: string }; status: string }>(auth, `/zones/${zoneId}`);
  if (zone.account.id !== accountId || zone.status !== "active") throw new Error("Selected zone is not active in the selected account");
}
