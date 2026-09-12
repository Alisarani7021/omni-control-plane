import { NET_MODE_LABELS, netModeForDeployment, type NetMode } from "./net-mode";
import { escapeHtml, nowIso } from "./security";
import type { Env } from "./types";

/**
 * Read-only views for the panel sections that the OMNI worker rendered from
 * hard-coded strings ("14 online", "15k/100k | 9.1GB"). Here every number is a
 * real query; when V13 does not measure something, the view says so instead of
 * showing a plausible-looking placeholder.
 */

export const HEALTH_FRESH_HOURS = 6;

export type HealthVerdict = "healthy" | "stale" | "in_progress" | "failed" | "revoked";

export const HEALTH_LABELS: Record<HealthVerdict, string> = {
  healthy: "🟢 گزارش سلامت تازه دارد",
  stale: "🟡 آخرین گزارش قدیمی است",
  in_progress: "🔵 در جریان آماده‌سازی",
  failed: "🔴 ناموفق",
  revoked: "⚫ باطل‌شده",
};

export interface NodeHealthRow {
  id: string;
  worker_name: string;
  status: string;
  node_hostname: string;
  vps_ipv4: string;
  last_seen_at: string | null;
  agent_status: string | null;
  agent_reported_at: string | null;
  sing_box_version: string | null;
  role: string;
  tunnel_txt_rtt_ms: number | null;
  net_mode?: NetMode;
}

export async function listNodeHealth(env: Env, tenantId: string, limit = 10): Promise<NodeHealthRow[]> {
  const rows = await env.DB.prepare(
    `SELECT d.id, d.worker_name, d.status, d.node_hostname, d.vps_ipv4, d.last_seen_at, d.role,
            (SELECT a.status FROM agent_reports a WHERE a.deployment_id = d.id ORDER BY a.reported_at DESC LIMIT 1) AS agent_status,
            (SELECT a.reported_at FROM agent_reports a WHERE a.deployment_id = d.id ORDER BY a.reported_at DESC LIMIT 1) AS agent_reported_at,
            (SELECT a.sing_box_version FROM agent_reports a WHERE a.deployment_id = d.id ORDER BY a.reported_at DESC LIMIT 1) AS sing_box_version,
            (SELECT a.tunnel_txt_rtt_ms FROM agent_reports a WHERE a.deployment_id = d.id ORDER BY a.reported_at DESC LIMIT 1) AS tunnel_txt_rtt_ms
     FROM deployments d
     WHERE d.tenant_id = ?
     ORDER BY d.updated_at DESC
     LIMIT ?`,
  ).bind(tenantId, Math.min(25, Math.max(1, limit))).all<NodeHealthRow>();
  const list = rows.results ?? [];
  await Promise.all(
    list.map(async (row) => {
      row.net_mode = await netModeForDeployment(env, row.id);
    }),
  );
  return list;
}

export function healthVerdict(row: NodeHealthRow): HealthVerdict {
  if (row.status === "revoked" || row.status === "revoking") return "revoked";
  if (row.status === "failed") return "failed";
  if (row.status !== "ready") return "in_progress";
  const seen = Date.parse(row.agent_reported_at ?? row.last_seen_at ?? "");
  if (!Number.isFinite(seen)) return "stale";
  return seen >= Date.now() - HEALTH_FRESH_HOURS * 3_600_000 ? "healthy" : "stale";
}

function ageLabel(value: string | null): string {
  const parsed = Date.parse(value ?? "");
  if (!Number.isFinite(parsed)) return "—";
  const minutes = Math.max(0, Math.round((Date.now() - parsed) / 60_000));
  if (minutes < 60) return `${minutes} دقیقه پیش`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ساعت پیش`;
  return `${Math.round(hours / 24)} روز پیش`;
}

export function nodeHealthText(rows: NodeHealthRow[], radar?: { measured: number; poolSize: number }): string {
  if (rows.length === 0) {
    return [
      "🩺 <b>سلامت نودها</b>",
      "",
      "هنوز استقراری ندارید؛ از «📦 استقرارها» یک نود واقعی بسازید.",
    ].join("\n");
  }
  const lines = rows.map((row) => {
    const verdict = HEALTH_LABELS[healthVerdict(row)];
    const mode = row.net_mode ? ` · 🧭 ${NET_MODE_LABELS[row.net_mode]}` : "";
    const tunnel = row.tunnel_txt_rtt_ms !== null && row.tunnel_txt_rtt_ms !== undefined
      ? ` · 🩺 TXT تونل: ${row.tunnel_txt_rtt_ms}ms`
      : "";
    const role = row.role === "sleeper" ? " · 😴 sleeper" : "";
    return [
      `• <b>${escapeHtml(row.worker_name)}</b> — ${verdict}`,
      `  نود <code>${escapeHtml(row.node_hostname)}</code> · آخرین گزارش: ${escapeHtml(ageLabel(row.agent_reported_at ?? row.last_seen_at))}`
        + `${row.agent_status ? ` · وضعیت Agent: ${escapeHtml(row.agent_status)}` : ""}`
        + `${row.sing_box_version ? ` · sing-box ${escapeHtml(row.sing_box_version)}` : ""}`
        + mode + tunnel + role,
    ].join("\n");
  });
  return [
    "🩺 <b>سلامت نودها</b>",
    "",
    ...lines,
    "",
    radar
      ? `💎 رادار IP تمیز: ${radar.measured} آی‌پی با گزارش زنده از ${radar.poolSize}.`
      : undefined,
    "📉 اندازه‌گیری ترافیک: نسخهٔ فعلی sing-box در V13 هیچ شمارش بایتی گزارش نمی‌کند، بنابراین عدد مصرف ساختگی نمایش داده نمی‌شود.",
  ].filter(Boolean).join("\n");
}

export interface PanelCounters {
  tenants: number;
  activeDonations: number;
  pendingDonations: number;
  deployments: { total: number; ready: number; failed: number; revoked: number };
  cleanIpSegments: number;
  mapReportsToday: number;
}

export async function panelCounters(env: Env, tenantId: string, isAdmin: boolean): Promise<PanelCounters> {
  const deployments = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status IN ('revoked', 'revoking') THEN 1 ELSE 0 END) AS revoked
     FROM deployments WHERE tenant_id = ?`,
  ).bind(tenantId).first<{ total: number; ready: number | null; failed: number | null; revoked: number | null }>();
  const cleanIp = await env.DB.prepare(
    "SELECT COUNT(DISTINCT ip) AS segments FROM clean_ip_reports WHERE expires_at > ?",
  ).bind(nowIso()).first<{ segments: number }>();
  const mapReports = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM map_reports WHERE created_at > ?",
  ).bind(new Date(Date.now() - 86_400_000).toISOString()).first<{ count: number }>();
  const donations = await env.DB.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
     FROM ai_donations WHERE expires_at > ?`,
  ).bind(nowIso()).first<{ total: number; pending: number | null }>();
  const tenants = isAdmin
    ? await env.DB.prepare("SELECT COUNT(*) AS count FROM tenants").first<{ count: number }>()
    : null;
  return {
    tenants: tenants?.count ?? 0,
    activeDonations: donations?.total ?? 0,
    pendingDonations: donations?.pending ?? 0,
    deployments: {
      total: deployments?.total ?? 0,
      ready: deployments?.ready ?? 0,
      failed: deployments?.failed ?? 0,
      revoked: deployments?.revoked ?? 0,
    },
    cleanIpSegments: cleanIp?.segments ?? 0,
    mapReportsToday: mapReports?.count ?? 0,
  };
}

export function usageText(counters: PanelCounters, radarMeasured: number): string {
  const deploy = counters.deployments;
  return [
    "📈 <b>مصرف و دارایی‌های شما</b>",
    "",
    `استقرارها: ${deploy.total} — ✅ فعال ${deploy.ready} · ❌ ناموفق ${deploy.failed} · ⛔ باطل‌شده ${deploy.revoked}`,
    `گزارش سلامت نودها: بر اساس آخرین بستهٔ Agent (بدون شبیه‌سازی آنلاین‌بودن).`,
    `رادار IP: ${radarMeasured} آی‌پی اندازه‌گیری‌شده · ${counters.cleanIpSegments} آی‌پی با گزارش تازه`,
    `گزارش‌های نقشهٔ سانسور (۲۴ ساعت): ${counters.mapReportsToday}`,
    `استخر AI: ${counters.activeDonations} کلید · ⏳ بازبینی‌نشده ${counters.pendingDonations}`,
    "",
    "ℹ️ ترافیک مصرفی در این نسخه اندازه‌گیری نمی‌شود؛ به‌جای عدد جعلی، منبع داده‌ها مشخص است.",
  ].join("\n");
}

export function rosterText(counters: PanelCounters): string {
  return [
    "👥 <b>وضعیت کل سامانه (فقط ادمین)</b>",
    "",
    `کاربران ثبت‌شده در D1: ${counters.tenants}`,
    `کلیدهای در انتظار بازبینی: ${counters.pendingDonations}`,
    "",
    "هیچ ایمیل، IP یا توکنی در این نما نمایش داده نمی‌شود.",
  ].join("\n");
}

export interface EngineStatus {
  baseUrl: string;
  botUsername: string;
  singBoxVersion: string;
  fallbackConfigured: boolean;
  adminConfigured: boolean;
}

export function engineStatus(env: Env): EngineStatus {
  let origin = "—";
  try {
    origin = new URL(env.PUBLIC_BASE_URL).origin;
  } catch {
    origin = "—";
  }
  return {
    baseUrl: origin,
    botUsername: env.BOT_USERNAME,
    singBoxVersion: env.SING_BOX_VERSION,
    fallbackConfigured: Boolean((env.OMNI_FALLBACK_URL ?? "").trim()),
    adminConfigured: (env.ADMIN_TELEGRAM_IDS ?? "").split(",").some((value) => value.trim().length > 0),
  };
}

export function engineStatusText(status: EngineStatus): string {
  return [
    "⚙️ <b>وضعیت موتور V13</b>",
    "",
    `🌐 آدرس کنترل‌پلین: <code>${escapeHtml(status.baseUrl)}</code>`,
    `🤖 ربات: <code>@${escapeHtml(status.botUsername)}</code>`,
    `📦 sing-box پین‌شده: <code>${escapeHtml(status.singBoxVersion)}</code>`,
    `🛰️ Cron سلامت/پاک‌سازی: هر ۵ دقیقه`,
    `🔁 فوروارد به ورکر Omni خارجی: ${status.fallbackConfigured ? "فعال" : "غیرفعال (V13 گیرندهٔ اصلی است)"}`,
    `🧑‍⚖️ ادمین برای بازبینی اهدا: ${status.adminConfigured ? "تنظیم شده" : "تنظیم نشده (ADMIN_TELEGRAM_IDS خالی است)"}`,
    "",
    "🔐 این نما هیچ secret یا توکنی نشان نمی‌دهد.",
  ].join("\n");
}
