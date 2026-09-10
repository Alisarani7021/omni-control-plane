import { deleteTxtRecords, getValidCloudflareAuth, upsertTxtRecord } from "./cloudflare-api";
import { rateLimit } from "./db";
import { HttpError } from "./http";
import { escapeHtml, isValidHostname, nowIso, sha256 } from "./security";
import type { ConnectionRow, Env, SessionPrincipal } from "./types";
import type { CleanIpRanking } from "./clean-ip";

/**
 * WhiteHole dead-drop — the port of the worker's emergency DNS shard writer.
 *
 * A tenant publishes the current clean-IP list into TXT records of their own
 * zone so a client inside Iran can read it with domestic resolvers while the
 * international link is down.
 *
 * Deliberate difference from the old worker: the drop NEVER carries a
 * subscription link, token or any credential. A public DNS record is readable by
 * everyone, so only non-secret routing hints are published.
 */

export const WHITEHOLE_MAX_SHARDS = 8;
export const WHITEHOLE_SHARD_CHARS = 180;
export const WHITEHOLE_RETENTION_DAYS = 30;
export const WHITEHOLE_RECORD_PREFIX = "ghost";

export interface WhiteHolePayload {
  v: 13;
  ts: number;
  zone: string;
  ips: Array<{ ip: string; port: number; sni: string; status: string }>;
  dns: string[];
  sni: string[];
}

export function buildWhiteHolePayload(ranking: CleanIpRanking, zone: string, limit = 10): WhiteHolePayload {
  const ordered = [...ranking.rows.filter((row) => row.measured), ...ranking.rows.filter((row) => !row.measured)].slice(0, limit);
  return {
    v: 13,
    ts: Date.now(),
    zone,
    ips: ordered.map((row) => ({ ip: row.ip, port: row.port, sni: row.sni, status: row.status })),
    dns: ["178.22.122.100", "185.51.200.2", "10.202.10.10", "10.202.10.11"],
    sni: ["snapp.ir", "digikala.com", "aparat.com", "divar.ir", "myket.ir"],
  };
}

function base64UrlSafe(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function chunkString(value: string, size: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += size) chunks.push(value.slice(index, index + size));
  return chunks;
}

export interface WhiteHoleDrop {
  payload: WhiteHolePayload;
  shards: string[];
  checksum: number;
  recordNames: string[];
}

export function assembleWhiteHoleDrop(payload: WhiteHolePayload): WhiteHoleDrop {
  const encoded = base64UrlSafe(JSON.stringify(payload));
  const shards = chunkString(encoded, WHITEHOLE_SHARD_CHARS).slice(0, WHITEHOLE_MAX_SHARDS);
  return {
    payload,
    shards,
    checksum: encoded.length % 97,
    recordNames: shards.map((_shard, index) => `${WHITEHOLE_RECORD_PREFIX}${index + 1}`),
  };
}

export function whiteHoleRecordValue(index: number, total: number, checksum: number, shard: string): string {
  return `v13;p${index + 1}=${shard};n=${total};c=${checksum}`;
}

export function validateDropDomain(value: string): string {
  const domain = value.trim().toLowerCase().slice(0, 253);
  if (!isValidHostname(domain)) throw new HttpError(400, "invalid_domain", "Domain is invalid");
  return domain;
}

interface WhiteHoleConnection {
  connection: ConnectionRow;
  zoneId: string;
  zone: string;
}

async function activeConnection(env: Env, tenantId: string): Promise<WhiteHoleConnection> {
  const row = await env.DB.prepare(
    `SELECT * FROM oauth_connections
     WHERE tenant_id = ? AND auth_type = 'api_token' AND revoked_at IS NULL AND expires_at > ?
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(tenantId, nowIso()).first<ConnectionRow>();
  const zoneId = row?.resource_zone_id ?? "";
  const zone = row?.resource_zone_name ?? "";
  if (!row || zoneId.length === 0 || zone.length === 0) {
    throw new HttpError(409, "cloudflare_reconnect_required", "A temporary Cloudflare connection with DNS access is required");
  }
  return { connection: row, zoneId, zone };
}

export interface WhiteHolePublishResult {
  zone: string;
  recordNames: string[];
  shards: number;
  checksum: number;
  digest: string;
  measured: number;
}

export async function publishWhiteHoleDrop(
  env: Env,
  principal: SessionPrincipal,
  ranking: CleanIpRanking,
): Promise<WhiteHolePublishResult> {
  const allowed = await rateLimit(env, `whitehole:${principal.tenantId}`, 6, 3_600);
  if (!allowed) throw new HttpError(429, "rate_limited", "سقف ۶ انتشار در ساعت پر شده است");
  const { connection, zone, zoneId } = await activeConnection(env, principal.tenantId);
  const drop = assembleWhiteHoleDrop(buildWhiteHolePayload(ranking, zone));
  const payloadJson = JSON.stringify(drop.payload);
  const digest = await sha256(payloadJson);
  const auth = await getValidCloudflareAuth(env, connection);
  for (const [index, name] of drop.recordNames.entries()) {
    const shard = drop.shards[index] ?? "";
    await upsertTxtRecord(auth, zoneId, `${name}.${zone}`, whiteHoleRecordValue(index, drop.shards.length, drop.checksum, shard));
  }

  const now = nowIso();
  const expiresAt = new Date(Date.now() + WHITEHOLE_RETENTION_DAYS * 86_400_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO whitehole_drops (id, tenant_id, zone_name, record_names, payload_sha256, shard_count, status, detail, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'published', ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    principal.tenantId,
    zone,
    JSON.stringify(drop.recordNames),
    digest,
    drop.shards.length,
    `${ranking.measured} measured IP(s) in the drop`,
    now,
    expiresAt,
  ).run();

  return {
    zone,
    recordNames: drop.recordNames,
    shards: drop.shards.length,
    checksum: drop.checksum,
    digest,
    measured: ranking.measured,
  };
}

export async function clearWhiteHoleDrop(env: Env, principal: SessionPrincipal): Promise<number> {
  const { connection, zone, zoneId } = await activeConnection(env, principal.tenantId);
  const auth = await getValidCloudflareAuth(env, connection);
  let removed = 0;
  for (let index = 1; index <= WHITEHOLE_MAX_SHARDS; index += 1) {
    removed += await deleteTxtRecords(auth, zoneId, `${WHITEHOLE_RECORD_PREFIX}${index}.${zone}`);
  }
  await env.DB.prepare(
    `UPDATE whitehole_drops SET status = 'cleared', detail = ? WHERE tenant_id = ? AND status = 'published'`,
  ).bind(`${removed} record(s) removed`, principal.tenantId).run();
  return removed;
}

export interface WhiteHoleDropRow {
  id: string;
  zone_name: string;
  record_names: string;
  payload_sha256: string;
  shard_count: number;
  status: string;
  detail: string | null;
  created_at: string;
}

export async function latestWhiteHoleDrop(env: Env, tenantId: string): Promise<WhiteHoleDropRow | null> {
  return await env.DB.prepare(
    `SELECT id, zone_name, record_names, payload_sha256, shard_count, status, detail, created_at
     FROM whitehole_drops
     WHERE tenant_id = ? AND expires_at > ?
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(tenantId, nowIso()).first<WhiteHoleDropRow>() ?? null;
}

export function whiteHoleText(drop: WhiteHoleDropRow | null, baseUrl: string): string {
  if (!drop) {
    return [
      "🌪 <b>هددراپ اضطراری WhiteHole</b>",
      "",
      "هنوز برای شما رکوردی منتشر نشده است.",
      "با «📤 انتشار رکوردها» لیست IP تمیز فعلی به‌صورت چند رکورد TXT در Zone خودتان نوشته می‌شود تا هنگام قطعی بین‌الملل با DNS داخلی قابل خواندن باشد.",
      "",
      "🔒 در این نسخه هیچ لینک اشتراک یا توکنی در DNS منتشر نمی‌شود؛ رکورد TXT عمومی است و فقط IP، پورت و SNI در آن قرار می‌گیرد.",
    ].join("\n");
  }
  let names: string[] = [];
  try {
    names = JSON.parse(drop.record_names) as string[];
  } catch {
    names = [];
  }
  const dig = names.slice(0, 2).map((name) => `<code>dig +short TXT ${escapeHtml(name)}.${escapeHtml(drop.zone_name)} @178.22.122.100</code>`).join("\n");
  return [
    `🌪 <b>هددراپ WhiteHole — ${escapeHtml(drop.zone_name)}</b>`,
    "",
    `وضعیت: <b>${escapeHtml(drop.status === "published" ? "منتشرشده ✅" : drop.status === "cleared" ? "پاک‌شده" : "ناموفق ❌")}</b>`,
    `رکوردها: <code>${escapeHtml(names.join("، ") || "—")}</code>`,
    `تکه‌ها: ${drop.shard_count} · امضای محتوا: <code>${escapeHtml(drop.payload_sha256.slice(0, 12))}…</code>`,
    `زمان: ${escapeHtml(new Date(drop.created_at).toLocaleString("fa-IR"))}${drop.detail ? ` · ${escapeHtml(drop.detail)}` : ""}`,
    "",
    "📡 خواندن از داخل ایران (فقط DNS داخلی):",
    dig || "—",
    "",
    `📜 اسکریپت جمع‌آوری خودکار:`,
    `<code>${escapeHtml(baseUrl)}/api/v1/whitehole/fetch.sh?domain=${encodeURIComponent(drop.zone_name)}</code>`,
  ].join("\n");
}

export function whiteHoleReadCommands(domain: string): string {
  const safe = escapeHtml(domain);
  return [
    "🧰 <b>دستورات خواندن هددراپ:</b>",
    "",
    `<code>for i in 1 2 3 4 5 6 7 8; do dig +short TXT ghost$i.${safe} @178.22.122.100; done</code>`,
    "",
    "هر رکورد یک تکه base64url است؛ ترتیب پارت‌ها و تعداد کل در خود مقدار رکورد آمده است.",
  ].join("\n");
}

/** Public reassembler script (port of /api/whitehole/fetch.sh). */
export function renderFetchScript(domain: string): string {
  const lines = [
    "#!/bin/bash",
    "# V13 WhiteHole dead-drop reader — run INSIDE Iran while only domestic DNS answers.",
    "# Needs: dig (bind-utils / dnsutils) and base64 or openssl.",
    `DOMAIN="${domain}"`,
    "RESOLVERS=\"178.22.122.100 185.51.200.2 10.202.10.10 10.202.10.11\"",
    "B64=\"\"",
    "TOTAL=0",
    "for i in 1 2 3 4 5 6 7 8; do",
    "  TXT=\"\"",
    "  for r in $RESOLVERS; do",
    "    TXT=$(dig +short TXT \"ghost$i.$DOMAIN\" \"@$r\" 2>/dev/null | tr -d '\"' | head -1)",
    "    [ -n \"$TXT\" ] && break",
    "  done",
    "  [ -z \"$TXT\" ] && break",
    "  PART=$(printf '%s' \"$TXT\" | sed 's/^v13;p[0-9]*=//; s/;n=.*$//')",
    "  N=$(printf '%s' \"$TXT\" | sed 's/.*;n=\\([0-9]*\\).*/\\1/')",
    "  [ -n \"$N\" ] && TOTAL=$N",
    "  B64=\"$B64$PART\"",
    "done",
    "[ -z \"$B64\" ] && { echo \"no shards found\" >&2; exit 1; }",
    "PADDED=\"$B64\"",
    "while [ $(( ${#PADDED} % 4 )) -ne 0 ]; do PADDED=\"$PADDED=\"; done",
    "printf '%s' \"$PADDED\" | tr '_-' '/+' | base64 -d 2>/dev/null || printf '%s' \"$PADDED\" | tr '_-' '/+' | openssl base64 -d",
    "echo",
    "[ \"$TOTAL\" -gt 0 ] && echo \"# shards assembled: see payload above\" >&2",
  ];
  return lines.join("\n");
}

export async function purgeExpiredWhiteHoleDrops(env: Env): Promise<number> {
  const result = await env.DB.prepare("DELETE FROM whitehole_drops WHERE expires_at <= ?").bind(nowIso()).run();
  return result.meta.changes ?? 0;
}
