import { HttpError } from "./http";
import { escapeHtml, nowIso } from "./security";
import type { Env } from "./types";

/**
 * «مستقیم داخل کشور» race — tunnel vs direct, per domain, crowd-measured.
 *
 * The biggest everyday pain is not filtering: domestic traffic (.ir, banks,
 * Aparat) going through the tunnel and back (≈400ms instead of ≈40ms).
 * Clients that measure both paths submit the pair; the winner per domain is
 * served as a sing-box rule-set so routing fixes itself automatically —
 * no user training, no fabricated numbers.
 */

export const RACE_RETENTION_DAYS = 7;
export const RACE_MIN_SAMPLES = 2;

export interface RaceReportInput {
  domain: string;
  directMs: number | null;
  tunnelMs: number | null;
}

export function parseRaceReport(input: unknown): RaceReportInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "invalid_input", "Expected a JSON object");
  }
  const body = input as Record<string, unknown>;
  const domain = typeof body.domain === "string" ? body.domain.toLowerCase().replace(/[^a-z0-9.-]/gu, "").slice(0, 120) : "";
  if (!/^[a-z0-9.-]{4,120}$/u.test(domain)) throw new HttpError(400, "invalid_input", "domain is invalid");
  const ms = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? Math.min(30_000, Math.max(0, Math.round(value))) : null;
  const directMs = ms(body.directMs);
  const tunnelMs = ms(body.tunnelMs);
  if (directMs === null && tunnelMs === null) throw new HttpError(400, "invalid_input", "At least one measurement is required");
  return { domain, directMs, tunnelMs };
}

export function raceWinner(directMs: number | null, tunnelMs: number | null): "direct" | "tunnel" | "tie" {
  if (directMs === null || tunnelMs === null) return "tie";
  if (directMs === tunnelMs) return "tie";
  return directMs < tunnelMs ? "direct" : "tunnel";
}

export async function recordRaceReport(env: Env, report: RaceReportInput): Promise<void> {
  const winner = raceWinner(report.directMs, report.tunnelMs);
  const now = nowIso();
  const expires = new Date(Date.now() + RACE_RETENTION_DAYS * 86_400_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO race_reports (domain, direct_ms, tunnel_ms, winner, samples, updated_at, expires_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(domain) DO UPDATE SET
       direct_ms = COALESCE(excluded.direct_ms, race_reports.direct_ms),
       tunnel_ms = COALESCE(excluded.tunnel_ms, race_reports.tunnel_ms),
       winner = excluded.winner,
       samples = samples + 1,
       updated_at = excluded.updated_at,
       expires_at = excluded.expires_at`,
  ).bind(report.domain, report.directMs, report.tunnelMs, winner, now, expires).run();
}

export interface RaceRow {
  domain: string;
  direct_ms: number | null;
  tunnel_ms: number | null;
  winner: string;
  samples: number;
}

export async function listRaceWinners(env: Env): Promise<RaceRow[]> {
  const rows = await env.DB.prepare(
    "SELECT domain, direct_ms, tunnel_ms, winner, samples FROM race_reports WHERE expires_at > ? ORDER BY samples DESC, updated_at DESC LIMIT 50",
  ).bind(nowIso()).all<RaceRow>();
  return rows.results ?? [];
}

/** Domains whose crowd race says "direct wins with confidence". */
function isUsableRow(row: RaceRow): boolean {
  return typeof row.domain === "string" && row.domain.length > 0;
}

export async function directRaceDomains(env: Env): Promise<string[]> {
  const rows = await listRaceWinners(env);
  return rows
    .filter((row) => isUsableRow(row) && row.winner === "direct" && row.samples >= RACE_MIN_SAMPLES)
    .map((row) => row.domain);
}

export function buildDomainRuleSet(domains: string[]): Record<string, unknown> {
  return {
    version: 2,
    rules: [{ domain: domains.length > 0 ? domains : ["invalid.local"] }],
  };
}

export function raceLine(rows: RaceRow[]): string | null {
  const measured = rows.filter((row) => isUsableRow(row) && row.direct_ms !== null && row.tunnel_ms !== null);
  if (measured.length === 0) return null;
  const top = measured[0];
  if (!top) return null;
  return `🏁 مسابقه تونل/مستقیم: <code>${escapeHtml(top.domain)}</code> مستقیم ${top.direct_ms}ms در برابر تونل ${top.tunnel_ms}ms (${top.samples} گزارش) — برنده‌ها خودکار direct می‌شوند.`;
}

export async function purgeExpiredRaceReports(env: Env): Promise<number> {
  const result = await env.DB.prepare("DELETE FROM race_reports WHERE expires_at <= ?").bind(nowIso()).run();
  return result.meta.changes ?? 0;
}
