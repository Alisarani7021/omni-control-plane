import { nowIso, sha256 } from "./security";
import type { Env } from "./types";

/**
 * National (IR) prefix intelligence from the public IRNIC/RIPE registry.
 *
 * - Once a day the cron fetches `delegated-irnic-extended-latest`, hashes it,
 *   diffs it against the stored snapshot and renders an honest card
 *   ("منبع: RIPE · +۱۴۲ رنج · −۳ رنج · sha256 …").
 * - The live range set backs the public sing-box rule-set used by every
 *   client profile for «مستقیم داخل کشور» routing.
 *
 * Only public registry data is stored; nothing is guessed.
 */

export const RIR_IR_URL = "https://ftp.ripe.net/pub/stats/irnic/delegated-irnic-extended-latest";
export const RIR_SNAPSHOT_RETENTION_DAYS = 14;
export const RIR_FETCH_TIMEOUT_MS = 30_000;

export interface IspRange {
  cidr: string;
  family: "ipv4" | "ipv6";
}

/** Parse delegated-extended lines: registry|cc|type|start|length|date|status[|...]. */
export function parseDelegatedIrnic(text: string): IspRange[] {
  const ranges: IspRange[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || line.trim().length === 0) continue;
    const parts = line.split("|");
    const [, cc, type, start, lengthRaw] = parts;
    if (parts[0] !== "irnic" || cc !== "IR" || !start || !lengthRaw) continue;
    if (type === "ipv4") {
      const hosts = Number(lengthRaw);
      if (!Number.isFinite(hosts) || hosts <= 0 || (hosts & (hosts - 1)) !== 0) continue;
      const prefix = 32 - Math.log2(hosts);
      if (prefix < 0 || prefix > 32 || !Number.isInteger(prefix)) continue;
      ranges.push({ cidr: `${start}/${prefix}`, family: "ipv4" });
    } else if (type === "ipv6") {
      const prefix = Number(lengthRaw);
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) continue;
      ranges.push({ cidr: `${start}/${prefix}`, family: "ipv6" });
    }
  }
  return ranges;
}

export function diffRanges(previous: Set<string>, next: Set<string>): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const cidr of next) if (!previous.has(cidr)) added.push(cidr);
  for (const cidr of previous) if (!next.has(cidr)) removed.push(cidr);
  return { added, removed };
}

export interface RirSnapshotRow {
  day: string;
  sha256: string;
  range_count: number;
  added: number;
  removed: number;
  fetched_at: string;
  source_url: string;
}

export async function latestRirSnapshot(env: Env): Promise<RirSnapshotRow | null> {
  return env.DB.prepare("SELECT day, sha256, range_count, added, removed, fetched_at, source_url FROM rir_ir_snapshots ORDER BY day DESC LIMIT 1")
    .bind()
    .first<RirSnapshotRow>();
}

export async function currentIrRanges(env: Env): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT cidr FROM geoip_ir_current ORDER BY cidr").bind().all<{ cidr: string }>();
  return (rows.results ?? []).map((row) => row.cidr);
}

export interface RirRefreshResult {
  updated: boolean;
  sha256: string | null;
  added: number;
  removed: number;
  rangeCount: number;
}

/** Daily refresh: fetch, hash, diff, replace. Fetch failure keeps the old snapshot. */
export async function refreshGeoipIr(env: Env): Promise<RirRefreshResult> {
  const today = nowIso().slice(0, 10);
  const existing = await env.DB.prepare("SELECT sha256 FROM rir_ir_snapshots WHERE day = ?").bind(today).first<{ sha256: string }>();
  if (existing) {
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM geoip_ir_current").first<{ n: number }>();
    return { updated: false, sha256: existing.sha256, added: 0, removed: 0, rangeCount: count?.n ?? 0 };
  }
  let text: string;
  try {
    const response = await fetch(RIR_IR_URL, { signal: AbortSignal.timeout(RIR_FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`rir_http_${response.status}`);
    text = await response.text();
  } catch (error) {
    console.error("rir_fetch_failed", { message: error instanceof Error ? error.message : String(error) });
    return { updated: false, sha256: null, added: 0, removed: 0, rangeCount: 0 };
  }
  const digest = await sha256(text);
  const ranges = parseDelegatedIrnic(text);
  if (ranges.length === 0) {
    console.error("rir_parse_empty", { sha256: digest });
    return { updated: false, sha256: digest, added: 0, removed: 0, rangeCount: 0 };
  }
  const previous = new Set(await currentIrRanges(env));
  const next = new Set(ranges.map((range) => range.cidr));
  const { added, removed } = diffRanges(previous, next);
  const familyOf = new Map(ranges.map((range) => [range.cidr, range.family] as const));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM geoip_ir_current"),
    ...chunks([...next], 30).map((batch) =>
      env.DB.prepare(`INSERT INTO geoip_ir_current (cidr, family, first_seen_day) VALUES ${batch.map(() => "(?, ?, ?)").join(", ")}`)
        .bind(...batch.flatMap((cidr) => [cidr, familyOf.get(cidr) === "ipv6" ? "ipv6" : "ipv4", today])),
    ),
    env.DB.prepare(
      "INSERT INTO rir_ir_snapshots (id, day, source_url, sha256, range_count, added, removed, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), today, RIR_IR_URL, digest, next.size, added.length, removed.length, nowIso()),
  ]);
  return { updated: true, sha256: digest, added: added.length, removed: removed.length, rangeCount: next.size };
}

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

export function rirCardLine(snapshot: RirSnapshotRow | null): string {
  if (!snapshot) {
    return "🇮🇷 رنج‌های ملی: هنوز snapshot ریجستری گرفته نشده است (cron روزانه).";
  }
  const plus = snapshot.added > 0 ? `+${snapshot.added}` : "۰";
  const minus = snapshot.removed > 0 ? `−${snapshot.removed}` : "۰";
  return `🇮🇷 رنج‌های ملی: منبع RIPE/IRNIC · ${plus}/${minus} نسبت به پیشین · ${snapshot.range_count} رنج · sha256 <code>${snapshot.sha256.slice(0, 12)}</code> · ${snapshot.day}`;
}

/** sing-box remote rule-set (format: source JSON) for «مستقیم داخل کشور». */
export function buildRuleSet(cidrs: string[]): Record<string, unknown> {
  return {
    version: 2,
    rules: [{ ip_cidr: cidrs }],
  };
}

export async function purgeOldRirSnapshots(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - RIR_SNAPSHOT_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
  const result = await env.DB.prepare("DELETE FROM rir_ir_snapshots WHERE day < ?").bind(cutoff).run();
  return result.meta.changes ?? 0;
}
