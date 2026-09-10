import { audit } from "./db";
import { getConnection, revokeConnectionGrant } from "./cloudflare-api";
import { HttpError, json } from "./http";
import { nowIso } from "./security";
import type { Env, SessionPrincipal } from "./types";

export async function listCloudflareConnections(env: Env, principal: SessionPrincipal): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT id, auth_type, scopes, expires_at, resource_account_id, resource_account_name,
            resource_zone_id, resource_zone_name, created_at, updated_at
     FROM oauth_connections
     WHERE tenant_id = ? AND revoked_at IS NULL
       AND (auth_type != 'api_token' OR expires_at > ?)
     ORDER BY created_at DESC`,
  ).bind(principal.tenantId, nowIso()).all();
  return json({ connections: result.results });
}

export async function disconnectCloudflareConnection(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  connectionId: string,
): Promise<Response> {
  const active = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM deployments
     WHERE oauth_connection_id = ?
       AND status IN ('queued', 'preparing', 'awaiting_agent', 'agent_ready', 'finalizing', 'revoking')`,
  ).bind(connectionId).first<{ count: number }>();
  if ((active?.count ?? 0) > 0) {
    throw new HttpError(409, "cloudflare_connection_busy", "Cloudflare access is still required by an active deployment");
  }
  const connection = await getConnection(env, connectionId, principal.tenantId);
  await revokeConnectionGrant(env, connection);
  await audit(env, {
    tenantId: principal.tenantId,
    actorType: "user",
    actorId: principal.telegramUserId,
    action: "cloudflare.connection.disconnect",
    resourceType: "cloudflare_connection",
    resourceId: connectionId,
    outcome: "success",
    request,
  });
  return json({ ok: true, status: "disconnected" });
}

export async function listCloudflareAccounts(
  env: Env,
  principal: SessionPrincipal,
  connectionId: string,
): Promise<Response> {
  const connection = await getConnection(env, connectionId, principal.tenantId);
  if (connection.auth_type !== "api_token") {
    throw new HttpError(
      410,
      "oauth_connection_unsupported",
      "OAuth-based Cloudflare connections are no longer supported; reconnect with a scoped API token",
    );
  }
  if (!connection.resource_account_id || !connection.resource_account_name) {
    throw new HttpError(500, "connection_resource_missing", "Cloudflare connection resource binding is unavailable");
  }
  return json({ accounts: [{ id: connection.resource_account_id, name: connection.resource_account_name }] });
}

export async function listCloudflareZones(
  env: Env,
  principal: SessionPrincipal,
  connectionId: string,
  accountId: string,
): Promise<Response> {
  const connection = await getConnection(env, connectionId, principal.tenantId);
  if (connection.auth_type !== "api_token") {
    throw new HttpError(
      410,
      "oauth_connection_unsupported",
      "OAuth-based Cloudflare connections are no longer supported; reconnect with a scoped API token",
    );
  }
  if (connection.resource_account_id !== accountId) {
    throw new HttpError(403, "cloudflare_resource_mismatch", "Account is outside this token's stored resource boundary");
  }
  if (!connection.resource_zone_id || !connection.resource_zone_name) {
    throw new HttpError(500, "connection_resource_missing", "Cloudflare connection resource binding is unavailable");
  }
  return json({ zones: [{ id: connection.resource_zone_id, name: connection.resource_zone_name, status: "active" }] });
}
