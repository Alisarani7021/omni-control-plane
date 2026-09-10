import { HttpError } from "./http";
import { escapeHtml, isPublicIpv4, nowIso } from "./security";
import type { Env } from "./types";

/**
 * Clean-IP radar — the port of the OMNI worker's "ULTRA WHITEHOLE" ranking.
 *
 * Honesty rule carried over from the worker's v10 patch: the ranking is built
 * ONLY from real client reports (bot flow or `POST /api/v1/telemetry/clean-ip`).
 * An IP without a report is rendered as NO-DATA; the server never invents a
 * latency, a loss percentage or a ping "simulation".
 */

export const CLEAN_IP_RETENTION_SECONDS = 7 * 86_400;
export const CLEAN_IP_FRESHNESS_HOURS = 24;
export const CLEAN_IP_MAX_ROWS = 48;

export type CleanIpTier = "arvan" | "cloudflare" | "warp";

/** ArvanCloud anycast ranges that stay reachable through domestic routing. */
export const ARVAN_CLEAN_IPS: readonly string[] = [
  "185.143.232.1", "185.143.232.13", "185.143.232.36", "185.143.233.9", "185.143.233.14",
  "185.143.234.18", "185.143.234.22", "185.143.232.100", "185.143.232.20", "185.143.232.42",
  "185.143.233.48", "185.143.234.12", "37.32.20.15", "37.32.16.11", "37.255.81.1",
  "94.182.182.10", "94.182.182.22",
];

/** Cloudflare edge IPs commonly reported as clean from Iranian networks. */
export const CLOUDFLARE_CLEAN_IPS: readonly string[] = [
  "104.16.132.229", "104.17.209.9", "172.67.73.161", "104.21.32.115", "104.26.12.188",
  "172.67.182.201", "162.159.140.38", "104.16.18.15", "104.17.24.15", "172.67.12.188",
  "162.159.36.1", "104.21.64.1", "172.67.73.88", "104.26.10.12", "104.18.32.115",
  "188.114.97.7",
];

/** WARP-on-WARP anycast endpoints. */
export const WARP_CLEAN_IPS: readonly string[] = [
  "188.114.96.1", "188.114.97.1", "162.159.192.1", "162.159.193.1", "162.159.193.10", "188.114.96.10",
];

/** Resolvers that keep answering during an international link shutdown. */
export const DOMESTIC_RESOLVERS: readonly string[] = [
  "178.22.122.100", "185.51.200.2", "10.202.10.10", "10.202.10.11",
];

export const CLEAN_IP_SNIS: readonly string[] = [
  "snapp.ir", "digikala.com", "aparat.com", "divar.ir", "myket.ir", "cafebazaar.ir", "bmi.ir", "telewebion.com", "cdn.mediad.ir",
];

export const CLEAN_IP_FINGERPRINTS: readonly string[] = [
  "chrome", "firefox", "safari", "chrome_120", "firefox_128", "ios", "randomized",
];

export interface CleanIpOperator {
  key: string;
  label: string;
  asn: string;
  dns: string;
  ports: readonly number[];
  preferred: readonly string[];
}

export const CLEAN_IP_OPERATORS: readonly CleanIpOperator[] = [
  { key: "mci", label: "همراه اول", asn: "AS197207", dns: "178.22.122.100", ports: [443, 8443, 2096], preferred: ["185.143.232.1", "185.143.232.13", "185.143.232.36"] },
  { key: "irancell", label: "ایرانسل", asn: "AS49100", dns: "10.202.10.10", ports: [443, 2053, 2087], preferred: ["104.16.132.229", "172.67.73.161"] },
  { key: "rightel", label: "رایتل", asn: "AS57218", dns: "185.51.200.2", ports: [443, 8443], preferred: ["162.159.192.1", "188.114.96.1"] },
  { key: "shatel", label: "شاتل", asn: "AS31549", dns: "185.51.200.2", ports: [443, 2087], preferred: ["37.32.16.11", "94.182.182.10"] },
  { key: "mokhaberat", label: "مخابرات", asn: "AS39501", dns: "178.22.122.100", ports: [443, 8443, 2053], preferred: ["172.67.73.161", "104.21.32.115"] },
  { key: "asiatech", label: "آسیاتک", asn: "AS43754", dns: "10.202.10.11", ports: [443, 2096], preferred: ["185.143.233.9", "185.143.234.18"] },
];

export interface CleanIpCity {
  key: string;
  label: string;
}

export const CLEAN_IP_CITIES: readonly CleanIpCity[] = [
  { key: "tehran", label: "تهران" },
  { key: "karaj", label: "کرج" },
  { key: "isfahan", label: "اصفهان" },
  { key: "mashhad", label: "مشهد" },
  { key: "shiraz", label: "شیراز" },
  { key: "tabriz", label: "تبریز" },
  { key: "qom", label: "قم" },
];

export function findOperator(key: string | null | undefined): CleanIpOperator {
  return CLEAN_IP_OPERATORS.find((item) => item.key === key) ?? CLEAN_IP_OPERATORS[0]!;
}

export function findCity(key: string | null | undefined): CleanIpCity {
  return CLEAN_IP_CITIES.find((item) => item.key === key) ?? CLEAN_IP_CITIES[0]!;
}

function operatorByAsn(asn: string): CleanIpOperator | null {
  return CLEAN_IP_OPERATORS.find((item) => item.asn.toLowerCase() === asn.toLowerCase()) ?? null;
}

export interface CleanIpPoolEntry {
  ip: string;
  tier: CleanIpTier;
}

export function cleanIpPool(): CleanIpPoolEntry[] {
  return [
    ...ARVAN_CLEAN_IPS.map((ip) => ({ ip, tier: "arvan" as const })),
    ...CLOUDFLARE_CLEAN_IPS.map((ip) => ({ ip, tier: "cloudflare" as const })),
    ...WARP_CLEAN_IPS.map((ip) => ({ ip, tier: "warp" as const })),
  ];
}

function ipOctetSum(ip: string): number {
  return ip.split(".").reduce((total, part) => total + (Number(part) || 0), 0);
}

/** Deterministic per-IP client hints (uTLS fingerprint, SNI, fragment range). */
function ipHints(ip: string, tier: CleanIpTier) {
  const sum = ipOctetSum(ip);
  const octets = ip.split(".").map((part) => Number(part) || 0);
  const second = octets[2] ?? 0;
  return {
    sni: tier === "cloudflare" || tier === "warp" ? "" : CLEAN_IP_SNIS[sum % CLEAN_IP_SNIS.length]!,
    fingerprint: CLEAN_IP_FINGERPRINTS[(octets[1] ?? 0) % CLEAN_IP_FINGERPRINTS.length]!,
    fragment: `${10 + (ip.charCodeAt(0) % 20)}-${40 + (second % 40)}`,
  };
}

export type CleanIpStatus = "verified" | "degraded" | "risky" | "nodata";

export const CLEAN_IP_STATUS_LABELS: Record<CleanIpStatus, string> = {
  verified: "🟢 تأییدشده",
  degraded: "🟡 افت‌کیفیت",
  risky: "🔴 پرریسک",
  nodata: "⚪ بدون داده",
};

export interface CleanIpReport {
  ip: string;
  operator: string;
  city: string;
  latencyMs: number;
  lossPct: number;
  ok: boolean;
}

/**
 * Accepts both the V13 field names and the short aliases used by existing OMNI
 * clients (`t`, `loss`, `ok`, `asn`). Values are clamped, never invented.
 */
export function parseCleanIpReport(input: unknown): CleanIpReport {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "invalid_input", "Expected a JSON object");
  }
  const body = input as Record<string, unknown>;
  const ip = typeof body.ip === "string" ? body.ip.trim() : "";
  if (!isPublicIpv4(ip)) throw new HttpError(400, "invalid_ip", "Only a public IPv4 address is accepted");

  const rawLatency = typeof body.latencyMs === "number" ? body.latencyMs : Number(body.t);
  const latencyMs = Number.isFinite(rawLatency) ? Math.round(rawLatency) : -1;
  if (latencyMs > 10_000) throw new HttpError(400, "invalid_latency", "latencyMs is out of range");

  const rawLoss = typeof body.lossPct === "number" ? body.lossPct : Number(body.loss);
  const lossPct = Number.isFinite(rawLoss) ? Math.round(Math.min(100, Math.max(0, rawLoss)) * 10) / 10 : 0;

  const okValue = body.ok === undefined ? latencyMs >= 0 : body.ok !== false && body.ok !== 0;

  const operatorKey = typeof body.operator === "string" ? body.operator.trim().toLowerCase() : "";
  const operator = CLEAN_IP_OPERATORS.some((item) => item.key === operatorKey)
    ? operatorKey
    : (typeof body.asn === "string" ? operatorByAsn(body.asn)?.key ?? "mci" : "mci");

  const cityKey = typeof body.city === "string" ? body.city.trim().toLowerCase() : "";
  const city = CLEAN_IP_CITIES.some((item) => item.key === cityKey) ? cityKey : "other";

  return { ip, operator, city, latencyMs: Math.max(-1, latencyMs), lossPct, ok: okValue === true };
}

export async function recordCleanIpReport(env: Env, report: CleanIpReport): Promise<void> {
  const now = nowIso();
  const expiresAt = new Date(Date.now() + CLEAN_IP_RETENTION_SECONDS * 1000).toISOString();
  // -1 is kept on purpose: it means "the client could not measure", which must
  // never be ranked as if it were an excellent 0ms latency.
  const latency = Math.max(-1, report.latencyMs);
  await env.DB.prepare(
    `INSERT INTO clean_ip_reports
      (ip, operator, city, latency_ms, loss_pct, ok_count, report_count, first_seen_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(ip, operator, city) DO UPDATE SET
       latency_ms = CAST(ROUND(clean_ip_reports.latency_ms * 0.6 + excluded.latency_ms * 0.4) AS INTEGER),
       loss_pct = ROUND(clean_ip_reports.loss_pct * 0.6 + excluded.loss_pct * 0.4, 1),
       ok_count = clean_ip_reports.ok_count + excluded.ok_count,
       report_count = clean_ip_reports.report_count + 1,
       updated_at = excluded.updated_at,
       expires_at = excluded.expires_at`,
  ).bind(
    report.ip,
    report.operator,
    report.city,
    latency,
    report.lossPct,
    report.ok ? 1 : 0,
    now,
    now,
    expiresAt,
  ).run();
}

interface ReportRow {
  ip: string;
  latency_ms: number;
  loss_pct: number;
  ok_count: number;
  report_count: number;
  updated_at: string;
}

export interface CleanIpRow {
  ip: string;
  tier: CleanIpTier;
  port: number;
  sni: string;
  fingerprint: string;
  fragment: string;
  latencyMs: number | null;
  lossPct: number | null;
  reports: number;
  okRatio: number | null;
  ageHours: number | null;
  measured: boolean;
  preferred: boolean;
  score: number;
  status: CleanIpStatus;
}

export interface CleanIpRanking {
  operator: CleanIpOperator;
  city: CleanIpCity;
  generatedAt: string;
  rows: CleanIpRow[];
  measured: number;
  poolSize: number;
}

/**
 * Ranks the pool for one operator/city segment. Unmeasured IPs are never given a
 * synthetic score that could be mistaken for a measurement — they are pushed past
 * every measured row and marked NO-DATA.
 */
export async function rankCleanIps(
  env: Env,
  params: { operator?: string; city?: string; limit?: number } = {},
): Promise<CleanIpRanking> {
  const operator = findOperator(params.operator);
  const city = params.city ? findCity(params.city) : { key: "all", label: "همه شهرها" };
  const limit = Math.min(CLEAN_IP_MAX_ROWS, Math.max(1, params.limit ?? 10));
  const now = Date.now();

  const segment = await env.DB.prepare(
    `SELECT ip, latency_ms, loss_pct, ok_count, report_count, updated_at
     FROM clean_ip_reports
     WHERE operator = ? AND (? = 'all' OR city = ?)`,
  ).bind(operator.key, city.key, city.key).all<ReportRow>();
  const byIp = new Map<string, ReportRow>();
  for (const row of segment.results ?? []) {
    const existing = byIp.get(row.ip);
    if (!existing || Date.parse(row.updated_at) > Date.parse(existing.updated_at)) byIp.set(row.ip, row);
  }

  const pool = new Map<string, CleanIpPoolEntry>();
  for (const entry of cleanIpPool()) pool.set(entry.ip, entry);
  for (const ip of byIp.keys()) if (!pool.has(ip)) pool.set(ip, { ip, tier: "cloudflare" });

  const rows: CleanIpRow[] = [];
  for (const entry of pool.values()) {
    const hints = ipHints(entry.ip, entry.tier);
    const report = byIp.get(entry.ip);
    const fresh = Boolean(report) && Date.parse(report?.updated_at ?? "") > now - CLEAN_IP_FRESHNESS_HOURS * 3_600_000;
    const ageHours = report ? Math.max(0, (now - Date.parse(report.updated_at)) / 3_600_000) : null;
    const latencyMs = fresh && report && report.latency_ms >= 0 ? report.latency_ms : null;
    const lossPct = fresh && report ? report.loss_pct : null;
    const okRatio = report && report.report_count > 0 ? report.ok_count / report.report_count : null;
    // A fresh client report counts even without a ping number: reachability is
    // information. It is just scored mid-pack, never as a fast measurement.
    const measured = fresh && (latencyMs !== null || (report?.report_count ?? 0) > 0);
    let status: CleanIpStatus = "nodata";
    let score: number;
    if (measured) {
      score = (latencyMs === null ? 60 : latencyMs * 0.5) + (lossPct ?? 0) * 25 + (ageHours ?? 0) * 2;
      if (okRatio !== null && okRatio < 0.5) status = "risky";
      else if ((lossPct ?? 0) > 5) status = "risky";
      else if ((lossPct ?? 0) > 1 || (latencyMs ?? 0) > 150) status = "degraded";
      else status = "verified";
    } else {
      score = 1_000_000 + ipOctetSum(entry.ip);
    }
    rows.push({
      ip: entry.ip,
      tier: entry.tier,
      port: operator.ports[0] ?? 443,
      sni: hints.sni || entry.ip,
      fingerprint: hints.fingerprint,
      fragment: hints.fragment,
      latencyMs,
      lossPct,
      reports: report?.report_count ?? 0,
      okRatio,
      ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
      measured,
      preferred: operator.preferred.includes(entry.ip),
      score: Math.round(score * 10) / 10,
      status,
    });
  }

  rows.sort((left, right) => left.score - right.score || left.ip.localeCompare(right.ip));
  const ranked = rows.slice(0, limit);
  return {
    operator,
    city,
    generatedAt: new Date(now).toISOString(),
    rows: ranked,
    measured: rows.filter((row) => row.measured).length,
    poolSize: pool.size,
  };
}

const TIER_LABELS: Record<CleanIpTier, string> = {
  arvan: "آروان",
  cloudflare: "کلادفلر",
  warp: "WARP",
};

function formatRow(row: CleanIpRow, index: number): string {
  const latency = row.latencyMs !== null ? `${row.latencyMs}ms` : "بدون پینگ (فقط رسیدنی)";
  const quality = row.measured ? `loss ${row.lossPct}% • ${row.reports} گزارش` : "گزارشی ثبت نشده";
  const preferred = row.preferred ? " • ⭐ پیشنهادی" : "";
  return [
    `${index + 1}. <code>${escapeHtml(row.ip)}:${row.port}</code> — ${CLEAN_IP_STATUS_LABELS[row.status]}${preferred}`,
    `   ${TIER_LABELS[row.tier]} • ${latency} • ${quality}`,
    `   SNI <code>${escapeHtml(row.sni)}</code> • fp <code>${escapeHtml(row.fingerprint)}</code> • frag <code>${escapeHtml(row.fragment)}</code>`,
  ].join("\n");
}

export function cleanIpRankingText(ranking: CleanIpRanking, baseUrl: string): string {
  const lines = ranking.rows.length > 0
    ? ranking.rows.map((row, index) => formatRow(row, index)).join("\n")
    : "هنوز هیچ گزارشی برای این بخش ثبت نشده است.";
  return [
    "💎 <b>رادار IP تمیز</b>",
    `اپراتور: <b>${escapeHtml(ranking.operator.label)}</b> · شهر: <b>${escapeHtml(ranking.city.label)}</b>`,
    "",
    lines,
    "",
    `📊 ${ranking.measured} از ${ranking.poolSize} آی‌پی گزارش زندهٔ کلاینت دارد؛ بقیه ⚪ بدون داده‌اند.`,
    "ℹ️ رتبه‌بندی فقط از خوداظهاری واقعی کلاینت‌ها ساخته می‌شود (بدون شبیه‌سازی پینگ). برای تازه‌شدن داده، گزارش بفرستید.",
    "",
    `🔗 <code>${escapeHtml(baseUrl)}/api/v1/clean-ip?operator=${encodeURIComponent(ranking.operator.key)}&amp;city=${encodeURIComponent(ranking.city.key)}</code>`,
    `📤 ارسال گزارش: <code>POST ${escapeHtml(baseUrl)}/api/v1/telemetry/clean-ip</code>`,
  ].join("\n");
}

export function cleanIpTeaserText(ranking: CleanIpRanking): string {
  const top = ranking.rows.find((row) => row.measured);
  return [
    "💎 <b>رادار IP تمیز</b>",
    `استخر: ${ranking.poolSize} آی‌پی · گزارش زنده: ${ranking.measured}`,
    top
      ? `بهترین گزینهٔ اندازه‌گیری‌شده: <code>${escapeHtml(top.ip)}:${top.port}</code> — ${top.latencyMs}ms، ${CLEAN_IP_STATUS_LABELS[top.status]}`
      : "هنوز هیچ آی‌پی گزارش زنده ندارد؛ با «📤 ثبت گزارش» اولی شوید.",
  ].join("\n");
}

/** Resolvers/ports/SNI cheat-sheet the old panel showed under the radar. */
export function cleanIpResolversText(): string {
  return [
    "🧭 <b>راهنمای تنظیم کلاینت</b>",
    "",
    `• DNS داخلی: <code>${DOMESTIC_RESOLVERS.join("</code> · <code>")}</code>`,
    "• پورت‌های مجاز روی لبه: <code>443</code> (اولویت) و <code>8443</code>",
    "• SNI اسپوف (فقط برای آی‌پی‌های آروان): <code>" + CLEAN_IP_SNIS.slice(0, 4).join("</code> · <code>") + "</code>",
    "",
    "⚠️ SNI جعلی فقط وقتی معنا دارد که ترافیک به همان IP مقصد برسد؛ روی IP تمیزِ بدون SNI درست، TLS در لبه تمام می‌شود و به نود شما نمی‌رسد.",
  ].join("\n");
}

/** Rows for the report flow: measured first (so stale ones can be refreshed). */
export async function cleanIpReportTargets(env: Env, operator: string, city: string): Promise<CleanIpRow[]> {
  const ranking = await rankCleanIps(env, { operator, city, limit: CLEAN_IP_MAX_ROWS });
  return ranking.rows;
}

export function cleanIpFormatText(ranking: CleanIpRanking): string {
  return ranking.rows.map((row) => [
    `${row.ip}:${row.port}#${ranking.operator.key}-${ranking.city.key}`,
    row.measured ? `latency=${row.latencyMs}ms loss=${row.lossPct}%` : "no-data",
    CLEAN_IP_STATUS_LABELS[row.status],
  ].join(" ")).join("\n");
}

/** Drops stale self-reports; called from the cron so poisoned data decays away. */
export async function purgeExpiredCleanIpReports(env: Env): Promise<number> {
  const result = await env.DB.prepare("DELETE FROM clean_ip_reports WHERE expires_at <= ?").bind(nowIso()).run();
  return result.meta.changes ?? 0;
}
