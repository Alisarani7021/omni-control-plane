import { nowIso, sha256 } from "./security";
import type { Env, SessionPrincipal } from "./types";

export async function audit(
  env: Env,
  event: {
    tenantId?: string | null;
    actorType: "telegram" | "user" | "agent" | "workflow" | "system";
    actorId?: string | null;
    action: string;
    resourceType?: string | null;
    resourceId?: string | null;
    outcome: "success" | "failure" | "denied";
    request?: Request;
    metadata?: Record<string, string | number | boolean | null>;
  },
): Promise<void> {
  let ipHash: string | null = null;
  const ip = event.request?.headers.get("CF-Connecting-IP");
  if (ip) ipHash = await sha256(`${new Date().toISOString().slice(0, 10)}|${ip}`);
  await env.DB.prepare(
    `INSERT INTO audit_events
      (id, tenant_id, actor_type, actor_id, action, resource_type, resource_id, outcome, ip_hash, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    event.tenantId ?? null,
    event.actorType,
    event.actorId ?? null,
    event.action,
    event.resourceType ?? null,
    event.resourceId ?? null,
    event.outcome,
    ipHash,
    event.metadata ? JSON.stringify(event.metadata) : null,
    nowIso(),
  ).run();
}

export async function rateLimit(
  env: Env,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const currentWindow = now - (now % windowSeconds);
  await env.DB.prepare(
    `INSERT INTO rate_limits (bucket_key, window_started_at, hits)
     VALUES (?, ?, 1)
     ON CONFLICT(bucket_key) DO UPDATE SET
       window_started_at = CASE WHEN window_started_at = excluded.window_started_at THEN window_started_at ELSE excluded.window_started_at END,
       hits = CASE WHEN window_started_at = excluded.window_started_at THEN hits + 1 ELSE 1 END`,
  ).bind(key, currentWindow).run();
  const row = await env.DB.prepare("SELECT window_started_at, hits FROM rate_limits WHERE bucket_key = ?")
    .bind(key).first<{ window_started_at: number; hits: number }>();
  return Boolean(row && row.window_started_at === currentWindow && row.hits <= limit);
}

export async function requireSession(request: Request, env: Env): Promise<SessionPrincipal | null> {
  const cookie = request.headers.get("Cookie") ?? "";
  const match = /(?:^|;\s*)v13_session=([^;]+)/u.exec(cookie);
  if (!match?.[1]) return null;
  const raw = decodeURIComponent(match[1]);
  if (raw.length < 32 || raw.length > 128) return null;
  const sessionHash = await sha256(raw);
  const row = await env.DB.prepare(
    `SELECT s.session_hash, s.tenant_id, s.expires_at, t.telegram_user_id, t.display_name, t.status
     FROM sessions s JOIN tenants t ON t.id = s.tenant_id
     WHERE s.session_hash = ?`,
  ).bind(sessionHash).first<{
    session_hash: string;
    tenant_id: string;
    expires_at: string;
    telegram_user_id: string;
    display_name: string;
    status: string;
  }>();
  if (!row || row.status !== "active" || Date.parse(row.expires_at) <= Date.now()) return null;
  const admins = new Set(env.ADMIN_TELEGRAM_IDS.split(",").map((value) => value.trim()).filter(Boolean));
  await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE session_hash = ?")
    .bind(nowIso(), sessionHash).run();
  return {
    tenantId: row.tenant_id,
    telegramUserId: row.telegram_user_id,
    displayName: row.display_name,
    isAdmin: admins.has(row.telegram_user_id),
    sessionHash: row.session_hash,
  };
}
