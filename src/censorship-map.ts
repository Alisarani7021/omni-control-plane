import { HttpError } from "./http";
import { escapeHtml, nowIso } from "./security";
import type { Env } from "./types";

/**
 * Live censorship map — the port of the worker's HAMZAD "نقشه زنده سانسور".
 *
 * The panel value here is the crowd signal (what transports reach which ISP and
 * city right now). Reports are anonymous: no IP and no Telegram id is stored,
 * only the ISP/city/transport/latency tuple, kept for a short window.
 */

export const MAP_RETENTION_HOURS = 24;
export const MAP_WINDOW_HOURS = 6;
export const MAP_MIN_REPORTS = 3;

export const MAP_ISPS: readonly string[] = [
  "همراه‌اول", "ایرانسل", "رایتل", "مخابرات", "شاتل", "های‌وب", "آسیاتک", "مبین‌نت", "زیتل", "پارس‌آنلاین", "سایر",
];

export const MAP_TRANSPORTS: readonly string[] = [
  "hysteria2", "vless-reality", "ech", "fragment", "dns-tunnel", "other",
];

export const MAP_TRANSPORT_LABELS: Record<string, string> = {
  hysteria2: "Hysteria2 (UDP/443)",
  "vless-reality": "VLESS Reality",
  ech: "ECH",
  fragment: "Fragment",
  "dns-tunnel": "تونل DNS (dnstt)",
  other: "سایر",
};

export type MapVerdict = "up" | "degraded" | "down" | "nodata";

export const MAP_VERDICT_LABELS: Record<MapVerdict, string> = {
  up: "🟢 باز",
  degraded: "🟡 مختل",
  down: "🔴 بسته",
  nodata: "⚪ کم‌دیتا",
};

export interface MapReport {
  isp: string;
  city: string;
  transport: string;
  rttMs: number | null;
  ok: boolean;
}

function sanitizeCity(value: unknown): string {
  const raw = typeof value === "string" ? value.slice(0, 60) : "";
  const cleaned = raw
    .replace(/<[^>]*>/gu, " ")
    .replace(/[<>&"'\\]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 40);
  return cleaned.length > 0 ? cleaned : "نامشخص";
}

export function parseMapReport(input: unknown): MapReport {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "invalid_input", "Expected a JSON object");
  }
  const body = input as Record<string, unknown>;
  const isp = typeof body.isp === "string" && MAP_ISPS.includes(body.isp) ? body.isp : "سایر";
  const transportRaw = typeof body.transport === "string" ? body.transport : (typeof body.tr === "string" ? body.tr : "");
  const transport = MAP_TRANSPORTS.includes(transportRaw) ? transportRaw : "other";
  const rawRtt = body.rttMs ?? body.rtt;
  let rttMs: number | null = null;
  if (typeof rawRtt === "number" && Number.isFinite(rawRtt)) rttMs = Math.min(10_000, Math.max(-1, Math.round(rawRtt)));
  const okValue = body.ok === undefined ? (rttMs !== null && rttMs >= 0) : body.ok === true || body.ok === 1;
  return { isp, city: sanitizeCity(body.city), transport, rttMs, ok: okValue === true };
}

export async function recordMapReport(env: Env, report: MapReport): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO map_reports (id, isp, city, transport, rtt_ms, ok, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    report.isp,
    report.city,
    report.transport,
    report.rttMs,
    report.ok ? 1 : 0,
    nowIso(),
    new Date(now + MAP_RETENTION_HOURS * 3_600_000).toISOString(),
  ).run();
}

interface MapCellRow {
  isp: string;
  city: string;
  transport: string;
  n: number;
  ok_count: number;
  rtts: string | null;
}

export interface MapCell {
  isp: string;
  city: string;
  reports: number;
  okRatio: number;
  medianRtt: number | null;
  verdict: MapVerdict;
  transports: Record<string, { reports: number; okRatio: number }>;
}

export interface MapTransportStat {
  transport: string;
  reports: number;
  okRatio: number;
}

export interface MapAggregate {
  updatedAt: string;
  windowHours: number;
  totalReports: number;
  cells: MapCell[];
  transports: MapTransportStat[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

function verdictFor(reports: number, okRatio: number): MapVerdict {
  if (reports < MAP_MIN_REPORTS) return "nodata";
  if (okRatio >= 0.8) return "up";
  if (okRatio >= 0.4) return "degraded";
  return "down";
}

export async function aggregateMap(env: Env, windowHours = MAP_WINDOW_HOURS): Promise<MapAggregate> {
  const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();
  const result = await env.DB.prepare(
    `SELECT isp, city, transport,
            COUNT(*) AS n,
            SUM(ok) AS ok_count,
            GROUP_CONCAT(CASE WHEN rtt_ms >= 0 THEN CAST(rtt_ms AS TEXT) ELSE NULL END) AS rtts
     FROM map_reports
     WHERE created_at > ?
     GROUP BY isp, city, transport`,
  ).bind(since).all<MapCellRow>();

  interface CellAccumulator {
    isp: string;
    city: string;
    reports: number;
    ok: number;
    rtts: number[];
    transports: Record<string, { reports: number; ok: number }>;
  }
  const cells = new Map<string, CellAccumulator>();
  const transportTotals = new Map<string, { reports: number; ok: number }>();
  let totalReports = 0;

  for (const row of result.results ?? []) {
    const key = `${row.isp}|${row.city}`;
    const cell = cells.get(key) ?? {
      isp: row.isp,
      city: row.city,
      reports: 0,
      ok: 0,
      rtts: [],
      transports: {},
    };
    const reports = row.n ?? 0;
    const ok = row.ok_count ?? 0;
    const rtts = (row.rtts ?? "").split(",").filter(Boolean).map(Number).filter(Number.isFinite);
    cell.reports += reports;
    cell.ok += ok;
    cell.rtts.push(...rtts);
    const previous = cell.transports[row.transport] ?? { reports: 0, ok: 0 };
    cell.transports[row.transport] = { reports: previous.reports + reports, ok: previous.ok + ok };
    cells.set(key, cell);

    const transport = transportTotals.get(row.transport) ?? { reports: 0, ok: 0 };
    transportTotals.set(row.transport, { reports: transport.reports + reports, ok: transport.ok + ok });
    totalReports += reports;
  }

  const ratio = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 100) / 100 : 0);

  const cellList: MapCell[] = [...cells.values()].map((cell) => ({
    isp: cell.isp,
    city: cell.city,
    reports: cell.reports,
    okRatio: ratio(cell.ok, cell.reports),
    medianRtt: median(cell.rtts),
    verdict: verdictFor(cell.reports, ratio(cell.ok, cell.reports)),
    transports: Object.fromEntries(Object.entries(cell.transports).map(([name, stat]) => ([
      name,
      { reports: stat.reports, okRatio: ratio(stat.ok, stat.reports) },
    ]))),
  })).sort((left, right) => left.okRatio - right.okRatio || right.reports - left.reports);

  const transportList: MapTransportStat[] = [...transportTotals.entries()].map(([transport, stat]) => ({
    transport,
    reports: stat.reports,
    okRatio: ratio(stat.ok, stat.reports),
  })).sort((left, right) => right.okRatio - left.okRatio || right.reports - left.reports);

  return {
    updatedAt: new Date().toISOString(),
    windowHours,
    totalReports,
    cells: cellList,
    transports: transportList,
  };
}

export function mapText(aggregate: MapAggregate): string {
  if (aggregate.totalReports === 0) {
    return [
      "🗺 <b>نقشه زندهٔ سانسور</b>",
      "",
      `در ${aggregate.windowHours} ساعت گذشته گزارشی ثبت نشده است.`,
      "با «📤 ثبت گزارش» وضعیت اتصال‌تان را اضافه کنید؛ نقشه فقط از گزارش‌های واقعی ساخته می‌شود.",
    ].join("\n");
  }
  const cells = aggregate.cells.slice(0, 8).map((cell) => [
    `• ${MAP_VERDICT_LABELS[cell.verdict]} — ${escapeHtml(cell.city)} / ${escapeHtml(cell.isp)}`,
    `  سلامت ${Math.round(cell.okRatio * 100)}٪ · میانه پینگ ${cell.medianRtt === null ? "—" : `${cell.medianRtt}ms`} · ${cell.reports} گزارش`,
  ].join("\n")).join("\n");
  const transports = aggregate.transports.map((item) =>
    `• <code>${escapeHtml(item.transport)}</code> — ${Math.round(item.okRatio * 100)}٪ از ${item.reports} گزارش`).join("\n");
  return [
    "🗺 <b>نقشه زندهٔ سانسور</b>",
    `پنجرهٔ زمانی: ${aggregate.windowHours} ساعت · به‌روزرسانی: ${escapeHtml(new Date(aggregate.updatedAt).toLocaleString("fa-IR"))}`,
    "",
    "📍 <b>شهر/اپراتور (خراب‌ها اول):</b>",
    cells,
    "",
    "🚚 <b>وضعیت ترانسپورت‌ها:</b>",
    transports,
    "",
    `🧾 ${aggregate.totalReports} گزارش ناشناس در بازه — بدون IP، بدون شناسه کاربر.`,
  ].join("\n");
}

export async function purgeExpiredMapReports(env: Env): Promise<number> {
  const result = await env.DB.prepare("DELETE FROM map_reports WHERE expires_at <= ?").bind(nowIso()).run();
  return result.meta.changes ?? 0;
}
