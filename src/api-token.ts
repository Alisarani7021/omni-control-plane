import { cloudflareApi, eraseExpiredApiTokens } from "./cloudflare-api";
import { audit, rateLimit } from "./db";
import { HttpError, json, readJson } from "./http";
import { addSecondsIso, encryptJson, nowIso, parsePositiveInt } from "./security";
import type { Env, SessionPrincipal } from "./types";

interface ApiTokenInput {
  apiToken?: unknown;
}

interface TokenVerification {
  id?: string;
  status?: "active" | "disabled" | "expired";
  expires_on?: string;
  not_before?: string;
}

interface TokenZone {
  id: string;
  name: string;
  status: string;
  account: { id: string; name: string };
  permissions?: string[];
}

function validateApiToken(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid_api_token", "Cloudflare API token is required");
  const token = value.trim();
  if (!/^[A-Za-z0-9_-]{20,256}$/u.test(token)) {
    throw new HttpError(400, "invalid_api_token", "Cloudflare API token format is invalid");
  }
  return token;
}

function effectiveExpiry(env: Env, remoteExpiry: string | undefined): string {
  const ttl = parsePositiveInt(env.API_TOKEN_TTL_SECONDS ?? "7200", 7200, 86_400);
  const localExpiry = Date.parse(addSecondsIso(ttl));
  if (!remoteExpiry) return new Date(localExpiry).toISOString();
  const parsedRemote = Date.parse(remoteExpiry);
  if (!Number.isFinite(parsedRemote) || parsedRemote <= Date.now()) {
    throw new HttpError(401, "cloudflare_token_expired", "Cloudflare API token is expired");
  }
  return new Date(Math.min(localExpiry, parsedRemote)).toISOString();
}

export async function createTemporaryApiTokenConnection(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
): Promise<Response> {
  const allowed = await rateLimit(env, `api-token-connect:${principal.tenantId}`, 10, 600);
  if (!allowed) throw new HttpError(429, "rate_limited", "Too many Cloudflare connection attempts; try again later");
  await eraseExpiredApiTokens(env);
  const body = await readJson<ApiTokenInput>(request, 4096);
  const token = validateApiToken(body.apiToken);
  const auth = { kind: "api_token" as const, token };

  let verification: TokenVerification;
  try {
    verification = await cloudflareApi<TokenVerification>(auth, "/user/tokens/verify");
  } catch {
    throw new HttpError(401, "cloudflare_token_rejected", "Cloudflare rejected the API token");
  }
  if (verification.status !== "active") {
    throw new HttpError(401, "cloudflare_token_inactive", "Cloudflare API token is not active");
  }
  if (verification.not_before && Date.parse(verification.not_before) > Date.now()) {
    throw new HttpError(401, "cloudflare_token_not_active_yet", "Cloudflare API token is not active yet");
  }
  const expiresAt = effectiveExpiry(env, verification.expires_on);

  let zones: TokenZone[];
  try {
    zones = await cloudflareApi<TokenZone[]>(auth, "/zones?per_page=50");
  } catch {
    throw new HttpError(
      403,
      "cloudflare_zone_read_missing",
      "Token needs Zone:Zone:Read for one specific active zone",
    );
  }
  if (zones.length === 0) {
    throw new HttpError(403, "cloudflare_zone_unavailable", "Token به هیچ Zone قابل‌استفاده‌ای دسترسی ندارد");
  }
  const hasPermissionMetadata = zones.some((item) => Array.isArray(item.permissions));
  const manageableZones = hasPermissionMetadata
    ? zones.filter((item) => item.permissions?.includes("#dns_records:edit"))
    : zones;
  if (manageableZones.length !== 1) {
    throw new HttpError(
      403,
      "cloudflare_token_scope_too_broad",
      "Token هنوز به چند Zone دسترسی DNS Edit دارد؛ در Cloudflare فقط یک Specific zone انتخاب کنید",
    );
  }
  const zone = manageableZones[0];
  if (zone?.status !== "active") {
    throw new HttpError(403, "cloudflare_zone_inactive", "The token's single Cloudflare zone must be active");
  }
  if (
    !zone
    || !/^[a-f0-9]{32}$/u.test(zone.id)
    || !/^[a-f0-9]{32}$/u.test(zone.account?.id ?? "")
    || typeof zone.name !== "string"
    || zone.name.length === 0
    || zone.name.length > 253
    || typeof zone.account?.name !== "string"
    || zone.account.name.length === 0
    || zone.account.name.length > 200
  ) {
    throw new HttpError(502, "cloudflare_resource_invalid", "Cloudflare returned invalid resource metadata");
  }

  try {
    await cloudflareApi<unknown[]>(auth, `/zones/${zone.id}/dns_records?per_page=1`);
  } catch {
    throw new HttpError(403, "cloudflare_dns_permission_missing", "Token needs Zone:DNS:Edit for the selected zone");
  }
  try {
    await cloudflareApi<unknown[]>(auth, `/accounts/${zone.account.id}/workers/scripts?per_page=1`);
  } catch {
    throw new HttpError(
      403,
      "cloudflare_workers_permission_missing",
      "Token needs Account:Workers Scripts:Edit for the selected account",
    );
  }

  const existing = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM oauth_connections
     WHERE tenant_id = ? AND auth_type = 'api_token' AND revoked_at IS NULL AND expires_at > ?`,
  ).bind(principal.tenantId, nowIso()).first<{ count: number }>();
  if ((existing?.count ?? 0) >= 3) {
    throw new HttpError(409, "too_many_connections", "Disconnect an older temporary Cloudflare connection first");
  }

  const id = crypto.randomUUID();
  const now = nowIso();
  const tokenEnc = await encryptJson(token, env.TOKEN_ENCRYPTION_KEY, `cloudflare:${id}:api-token`);
  await env.DB.prepare(
    `INSERT INTO oauth_connections
      (id, tenant_id, auth_type, access_token_enc, refresh_token_enc, expires_at, scopes,
       cf_user_id, cf_email, resource_account_id, resource_account_name, resource_zone_id,
       resource_zone_name, created_at, updated_at)
     VALUES (?, ?, 'api_token', ?, NULL, ?, 'scoped-api-token', ?, NULL, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    principal.tenantId,
    tokenEnc,
    expiresAt,
    verification.id?.slice(0, 128) ?? null,
    zone.account.id,
    zone.account.name.slice(0, 200),
    zone.id,
    zone.name.slice(0, 253),
    now,
    now,
  ).run();
  await audit(env, {
    tenantId: principal.tenantId,
    actorType: "user",
    actorId: principal.telegramUserId,
    action: "cloudflare.api_token.connect",
    resourceType: "cloudflare_connection",
    resourceId: id,
    outcome: "success",
    request,
    metadata: { expiresAt, accountId: zone.account.id, zoneId: zone.id },
  });
  return json({
    connection: {
      id,
      authType: "api_token",
      expiresAt,
      account: { id: zone.account.id, name: zone.account.name },
      zone: { id: zone.id, name: zone.name },
    },
  }, 201);
}

/**
 * Panel-product-only connection: the panel catalog owns its own temporary
 * connection lifecycle (created from the chat flow, auto-expiring like any
 * other scoped API-token connection). Never touches the dedicated env.
 */
export async function connectPanelTokenFromChat(
  env: Env,
  tenantId: string,
  telegramUserId: string,
  apiToken: string,
): Promise<string> {
  const request = new Request("https://internal/api/v1/cloudflare/api-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiToken }),
  });
  const principal: SessionPrincipal = {
    tenantId,
    telegramUserId,
    displayName: "panel-flow",
    isAdmin: false,
    sessionHash: "telegram-bot",
  };
  const response = await createTemporaryApiTokenConnection(request, env, principal);
  const body = (await response.json().catch(() => null)) as { connection?: { id?: string }; error?: { message?: string } } | null;
  if (response.status !== 201 || !body?.connection?.id) {
    throw new HttpError(response.status, "panel_connect_failed", body?.error?.message ?? "ساخت اتصال پنل ناموفق بود");
  }
  return body.connection.id;
}
