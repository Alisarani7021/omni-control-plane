/**
 * Independent DNS center (مرکز DNS): honest healthy-resolver discovery over a
 * user-supplied range, refreshed every 30 minutes by the cron, plus per-tenant
 * config builders (Master DNS / White DNS / Slipstream) that provision real
 * records through the tenant's own scoped Cloudflare connection.
 *
 * Honesty rule: a resolver is «healthy» only when it answers our canary names
 * with the globally-correct addresses over a real TCP/53 query from the Worker.
 * Blackhole answers are «fake», unexpected answers are «wrong», no answer is
 * «unreachable». Nothing is simulated.
 */
import { audit } from "./db";
import { HttpError } from "./http";
import { nowIso } from "./security";
import type { Env } from "./types";

export const DNS_SCAN_MIN_PREFIX = 24; // at most 256 addresses per range
export const DNS_SCAN_CHUNK = 128; // addresses probed per cron tick per range
export const DNS_SCAN_INTERVAL_MINUTES = 30;
export const DNS_SCAN_PROBE_TIMEOUT_MS = 2_500;
export const DNS_SCAN_RETENTION_HOURS = 24;
export const DNS_MAX_RANGES_PER_TENANT = 8;
/**
 * System baseline ranges the center always keeps scanning on its own so a
 * fresh tenant immediately has honest healthy upstreams (global anycast
 * resolvers). User ranges are added on top of these, never instead of them.
 */
export const DNS_AUTO_RANGES: readonly string[] = ["1.1.1.0/24", "8.8.8.0/24", "9.9.9.0/24"];
export const DNS_SCAN_MAX_RANGES_PER_TICK = 4;

export type DnsVerdict = "healthy" | "fake" | "wrong" | "unreachable";

interface Canary {
  name: string;
  expected: string[];
}

/** Canary names and their globally-correct A answers (checked against blackholes). */
export const DNS_CANARIES: readonly Canary[] = [
  { name: "cloudflare-dns.com", expected: ["1.1.1.1", "1.0.0.1"] },
  { name: "dns.google", expected: ["8.8.8.8", "8.8.4.4"] },
];

const BLACKHOLE = new Set(["127.0.0.1", "0.0.0.0", "10.10.34.34", "10.202.10.202"]);

export interface ParsedRange {
  cidr: string;
  ips: string[];
}

/** Accepts «a.b.c.d» or «a.b.c.d/24../32»; anything wider is rejected (scan cost). */
export function parseCidr(input: string): ParsedRange | null {
  const raw = input.trim();
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/u.exec(raw);
  if (!match) return null;
  const octets = [match[1], match[2], match[3], match[4]].map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  const prefix = match[5] === undefined ? 32 : Number(match[5]);
  if (prefix < DNS_SCAN_MIN_PREFIX || prefix > 32) return null;
  const base = ((octets[0] ?? 0) << 24) | ((octets[1] ?? 0) << 16) | ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
  const aligned = prefix === 0 ? 0 : (base >>> (32 - prefix)) << (32 - prefix);
  const count = 2 ** (32 - prefix);
  const ips: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = (aligned + index) >>> 0;
    ips.push(`${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`);
  }
  return { cidr: `${ips[0]}/${prefix}`, ips };
}

/** Minimal DNS wire encoder for a single A question. */
export function encodeDnsQuery(name: string, qtype = 1): Uint8Array {
  const labels = name.split(".").filter((label) => label.length > 0);
  let qnameLen = 0;
  for (const label of labels) qnameLen += label.length + 1;
  const buf = new Uint8Array(12 + qnameLen + 1 + 4);
  const view = new DataView(buf.buffer);
  view.setUint16(0, 0x1356); // id
  view.setUint16(2, 0x0100); // RD
  view.setUint16(4, 1); // qdcount
  let offset = 12;
  for (const label of labels) {
    buf[offset] = label.length;
    for (let index = 0; index < label.length; index += 1) buf[offset + 1 + index] = label.charCodeAt(index);
    offset += label.length + 1;
  }
  buf[offset] = 0;
  offset += 1;
  view.setUint16(offset, qtype);
  view.setUint16(offset + 2, 1); // IN
  return buf;
}

/** Parses rcode + A answers from a DNS response buffer. */
export function parseDnsResponse(buf: Uint8Array): { rcode: number; answers: string[] } {
  if (buf.length < 12) return { rcode: 99, answers: [] };
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const rcode = view.getUint8(3) & 0x0f;
  const ancount = view.getUint16(6);
  let offset = 12;
  const qdcount = view.getUint16(4);
  for (let question = 0; question < qdcount; question += 1) {
    while (offset < buf.length) {
      const length = buf[offset] ?? 0;
      offset += 1;
      if (length === 0) break;
      if ((length & 0xc0) === 0xc0) {
        offset += 1;
        break;
      }
      offset += length;
    }
    offset += 4;
  }
  const answers: string[] = [];
  for (let index = 0; index < ancount && offset + 12 <= buf.length; index += 1) {
    // name (pointer or labels)
    if ((buf[offset] ?? 0) & 0xc0) {
      offset += 2;
    } else {
      while (offset < buf.length) {
        const length = buf[offset] ?? 0;
        offset += 1;
        if (length === 0) break;
        offset += length;
      }
    }
    if (offset + 10 > buf.length) break;
    const rtype = view.getUint16(offset);
    const rdlength = view.getUint16(offset + 8);
    offset += 10;
    if (rtype === 1 && rdlength === 4 && offset + 4 <= buf.length) {
      answers.push(`${buf[offset] ?? 0}.${buf[offset + 1] ?? 0}.${buf[offset + 2] ?? 0}.${buf[offset + 3] ?? 0}`);
    }
    offset += rdlength;
  }
  return { rcode, answers };
}

export function classifyAnswers(answers: string[], expected: readonly string[]): DnsVerdict {
  if (answers.some((answer) => BLACKHOLE.has(answer))) return "fake";
  if (answers.some((answer) => expected.includes(answer))) return "healthy";
  return answers.length > 0 ? "wrong" : "unreachable";
}

interface ScanSocket {
  output: { getWriter(): { write(chunk: Uint8Array): Promise<void> } };
  input: { getReader(): { read(): Promise<{ done?: boolean; value?: Uint8Array }> } };
  close(): Promise<void>;
}

interface ProbeResult {
  verdict: DnsVerdict;
  rttMs: number | null;
}

/** Real TCP/53 query against one candidate resolver (canary #1). */
export async function probeResolver(ip: string): Promise<ProbeResult> {
  const canary = DNS_CANARIES[0] ?? { name: "cloudflare-dns.com", expected: ["1.1.1.1", "1.0.0.1"] };
  const started = Date.now();
  try {
    // Minimal structural typing: the bundled workers-types socket surface is
    // narrower than the runtime API (see Cloudflare docs for TCP sockets).
    const { connect } = (await import("cloudflare:sockets")) as unknown as {
      connect(address: string): ScanSocket;
    };
    const socket = connect(`${ip}:53`);
    const writer = socket.output.getWriter();
    const query = encodeDnsQuery(canary.name);
    const framed = new Uint8Array(query.length + 2);
    framed[0] = (query.length >> 8) & 0xff;
    framed[1] = query.length & 0xff;
    framed.set(query, 2);
    await writer.write(framed);
    const reader = socket.input.getReader();
    const timer = setTimeout(() => {
      socket.close().catch(() => undefined);
    }, DNS_SCAN_PROBE_TIMEOUT_MS);
    const first = await reader.read();
    clearTimeout(timer);
    socket.close().catch(() => undefined);
    const header = first.done || !first.value ? null : new Uint8Array(first.value);
    if (!header) return { verdict: "unreachable", rttMs: null };
    const rttMs = Date.now() - started;
    let body = new Uint8Array(0);
    if (header.length >= 2) {
      const length = ((header[0] ?? 0) << 8) | (header[1] ?? 0);
      body = header.length - 2 >= length ? header.slice(2, 2 + length) : header.slice(2);
    }
    const { rcode, answers } = parseDnsResponse(body);
    if (rcode !== 0) return { verdict: "wrong", rttMs };
    return { verdict: classifyAnswers(answers, canary.expected), rttMs };
  } catch {
    return { verdict: "unreachable", rttMs: null };
  }
}

export async function addScanRange(env: Env, tenantId: string, cidr: string): Promise<ParsedRange> {
  const parsed = parseCidr(cidr);
  if (!parsed) throw new HttpError(400, "invalid_input", "Range must be an IPv4 or /24../32 CIDR");
  const duplicate = await env.DB.prepare("SELECT id FROM dns_scan_ranges WHERE tenant_id = ? AND cidr = ?")
    .bind(tenantId, parsed.cidr)
    .first<{ id: string }>();
  if (duplicate) {
    throw new HttpError(409, "invalid_deployment_state", `Range ${parsed.cidr} is already registered; it keeps auto-scanning`);
  }
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM dns_scan_ranges WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= DNS_MAX_RANGES_PER_TENANT) {
    throw new HttpError(409, "invalid_deployment_state", `At most ${DNS_MAX_RANGES_PER_TENANT} active scan ranges per tenant`);
  }
  await env.DB.prepare(
    "INSERT INTO dns_scan_ranges (id, tenant_id, cidr, ips_total, cursor, created_at) VALUES (?, ?, ?, ?, 0, ?)",
  )
    .bind(crypto.randomUUID(), tenantId, parsed.cidr, parsed.ips.length, nowIso())
    .run();
  return parsed;
}

/**
 * Keeps the system baseline ranges present for every tenant: any missing auto
 * range is (re)added on each scan-view render and cron pass, so the center
 * always has something scanning "by itself", even for tenants that already
 * handed in their own ranges before this feature existed.
 */
export async function ensureAutoRanges(env: Env, tenantId: string): Promise<number> {
  let added = 0;
  for (const cidr of DNS_AUTO_RANGES) {
    const existing = await env.DB.prepare("SELECT id FROM dns_scan_ranges WHERE tenant_id = ? AND cidr = ?")
      .bind(tenantId, cidr)
      .first<{ id: string }>();
    if (existing) continue;
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM dns_scan_ranges WHERE tenant_id = ?")
      .bind(tenantId)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= DNS_MAX_RANGES_PER_TENANT) break;
    const parsed = parseCidr(cidr);
    if (!parsed) continue;
    await env.DB.prepare(
      "INSERT INTO dns_scan_ranges (id, tenant_id, cidr, ips_total, cursor, created_at) VALUES (?, ?, ?, ?, 0, ?)",
    )
      .bind(crypto.randomUUID(), tenantId, parsed.cidr, parsed.ips.length, nowIso())
      .run();
    added += 1;
  }
  if (added > 0) console.log("dns_auto_ranges_seeded", { tenantId, added });
  return added;
}

export interface ScanProgress {
  scanned: number;
  total: number;
  healthy: number;
  fake: number;
  wrong: number;
  unreachable: number;
}

export interface RangeScanSummary {
  cidr: string;
  total: number;
  healthy: number;
  fake: number;
  wrong: number;
  unreachable: number;
  top: Array<{ ip: string; rttMs: number | null }>;
}

/**
 * Immediate full-precision pass over every address of a range (waves of 16
 * parallel TCP/53 probes), replacing the range's stored results. Used the
 * moment the user hands a range to the bot; cron keeps refreshing afterwards.
 */
export async function scanRangeNow(
  env: Env,
  tenantId: string,
  cidr: string,
  onProgress?: (progress: ScanProgress) => Promise<void>,
): Promise<RangeScanSummary> {
  const parsed = parseCidr(cidr);
  if (!parsed) throw new HttpError(400, "invalid_input", "Range must be an IPv4 or /24../32 CIDR");
  let row = await env.DB.prepare("SELECT id FROM dns_scan_ranges WHERE tenant_id = ? AND cidr = ?")
    .bind(tenantId, parsed.cidr)
    .first<{ id: string }>();
  if (!row) {
    await addScanRange(env, tenantId, parsed.cidr);
    row = await env.DB.prepare("SELECT id FROM dns_scan_ranges WHERE tenant_id = ? AND cidr = ?")
      .bind(tenantId, parsed.cidr)
      .first<{ id: string }>();
  }
  if (!row) throw new HttpError(500, "internal_error", "Scan range row missing after insert");
  const rangeId = row.id;
  const checkedAt = nowIso();
  const collected: Array<{ ip: string; verdict: DnsVerdict; rttMs: number | null }> = [];
  const progress: ScanProgress = { scanned: 0, total: parsed.ips.length, healthy: 0, fake: 0, wrong: 0, unreachable: 0 };
  for (let index = 0; index < parsed.ips.length; index += 16) {
    const wave = parsed.ips.slice(index, index + 16);
    const results = await Promise.all(wave.map((ip) => probeResolver(ip)));
    for (let offset = 0; offset < wave.length; offset += 1) {
      const verdict = results[offset]?.verdict ?? "unreachable";
      collected.push({ ip: wave[offset] ?? "", verdict, rttMs: results[offset]?.rttMs ?? null });
      progress.scanned += 1;
      if (verdict === "healthy") progress.healthy += 1;
      else if (verdict === "fake") progress.fake += 1;
      else if (verdict === "wrong") progress.wrong += 1;
      else progress.unreachable += 1;
    }
    if (onProgress) await onProgress({ ...progress });
  }
  await env.DB.prepare("DELETE FROM dns_scan_results WHERE range_id = ?").bind(rangeId).run();
  const inserts = collected.map((item) =>
    env.DB.prepare(
      "INSERT INTO dns_scan_results (id, range_id, ip, ok, rtt_ms, verdict, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), rangeId, item.ip, item.verdict === "healthy" ? 1 : 0, item.rttMs, item.verdict, checkedAt),
  );
  for (let index = 0; index < inserts.length; index += 100) {
    await env.DB.batch(inserts.slice(index, index + 100));
  }
  await env.DB.prepare("UPDATE dns_scan_ranges SET cursor = 0, last_scan_at = ?, finished_at = ? WHERE id = ?")
    .bind(checkedAt, checkedAt, rangeId)
    .run();
  const summary: RangeScanSummary = { cidr: parsed.cidr, total: collected.length, healthy: 0, fake: 0, wrong: 0, unreachable: 0, top: [] };
  for (const item of collected) {
    if (item.verdict === "healthy") {
      summary.healthy += 1;
      summary.top.push({ ip: item.ip, rttMs: item.rttMs });
    } else if (item.verdict === "fake") summary.fake += 1;
    else if (item.verdict === "wrong") summary.wrong += 1;
    else summary.unreachable += 1;
  }
  summary.top.sort((a, b) => (a.rttMs ?? 9999) - (b.rttMs ?? 9999));
  summary.top = summary.top.slice(0, 8);
  console.log("dns_range_full_scan", { cidr: summary.cidr, healthy: summary.healthy, total: summary.total });
  return summary;
}

/** Cron entry: probe due ranges chunk-by-chunk; a full pass repeats every 30 minutes. */
export async function scanDueRanges(env: Env): Promise<number> {
  const tenants = await env.DB.prepare("SELECT DISTINCT tenant_id FROM dns_scan_ranges").all<{ tenant_id: string }>();
  for (const row of tenants.results) {
    await ensureAutoRanges(env, row.tenant_id).catch(() => 0);
  }
  const cutoff = new Date(Date.now() - DNS_SCAN_INTERVAL_MINUTES * 60_000).toISOString();
  const due = await env.DB.prepare(
    `SELECT id, cidr, ips_total, cursor FROM dns_scan_ranges
     WHERE finished_at IS NULL OR last_scan_at IS NULL OR last_scan_at < ?
     ORDER BY created_at ASC LIMIT ${DNS_SCAN_MAX_RANGES_PER_TICK}`,
  )
    .bind(cutoff)
    .all<{ id: string; cidr: string; ips_total: number; cursor: number }>();
  let probed = 0;
  for (const range of due.results) {
    const parsed = parseCidr(range.cidr);
    if (!parsed) continue;
    const slice = parsed.ips.slice(range.cursor, range.cursor + DNS_SCAN_CHUNK);
    for (let index = 0; index < slice.length; index += 8) {
      const group = slice.slice(index, index + 8);
      const results = await Promise.all(group.map((ip) => probeResolver(ip)));
      for (let offset = 0; offset < group.length; offset += 1) {
        const ip = group[offset] ?? "";
        const result = results[offset] ?? { verdict: "unreachable" as DnsVerdict, rttMs: null };
        await env.DB.prepare(
          "INSERT INTO dns_scan_results (id, range_id, ip, ok, rtt_ms, verdict, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
          .bind(crypto.randomUUID(), range.id, ip, result.verdict === "healthy" ? 1 : 0, result.rttMs, result.verdict, nowIso())
          .run();
        probed += 1;
      }
    }
    const nextCursor = range.cursor + slice.length;
    const done = nextCursor >= range.ips_total;
    await env.DB.prepare(
      done
        ? "UPDATE dns_scan_ranges SET cursor = 0, last_scan_at = ?, finished_at = ? WHERE id = ?"
        : "UPDATE dns_scan_ranges SET cursor = ? WHERE id = ?",
    )
      .bind(...(done ? [nowIso(), nowIso(), range.id] : [nextCursor, range.id]))
      .run();
  }
  if (probed > 0) console.log("dns_scan_probed", { count: probed });
  return probed;
}

export interface HealthyResolver {
  ip: string;
  rtt_ms: number | null;
  checked_at: string;
  cidr: string;
}

/** Fresh (≤60 min) healthy resolvers across the tenant's ranges, fastest first. */
export async function healthyResolvers(env: Env, tenantId: string): Promise<HealthyResolver[]> {
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const rows = await env.DB.prepare(
    `SELECT r.ip AS ip, r.rtt_ms AS rtt_ms, r.checked_at AS checked_at, g.cidr AS cidr
     FROM dns_scan_results r JOIN dns_scan_ranges g ON g.id = r.range_id
     WHERE g.tenant_id = ? AND r.verdict = 'healthy' AND r.checked_at >= ?
     ORDER BY r.rtt_ms ASC LIMIT 20`,
  )
    .bind(tenantId, since)
    .all<HealthyResolver>();
  return rows.results;
}

export async function scanRangeStatus(env: Env, tenantId: string): Promise<
  Array<{ cidr: string; ips_total: number; cursor: number; last_scan_at: string | null }>
> {
  const rows = await env.DB.prepare(
    "SELECT cidr, ips_total, cursor, last_scan_at FROM dns_scan_ranges WHERE tenant_id = ? ORDER BY created_at DESC",
  )
    .bind(tenantId)
    .all<{ cidr: string; ips_total: number; cursor: number; last_scan_at: string | null }>();
  return rows.results;
}

export async function purgeOldDnsScans(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - DNS_SCAN_RETENTION_HOURS * 3_600_000).toISOString();
  const result = await env.DB.prepare("DELETE FROM dns_scan_results WHERE checked_at < ?").bind(cutoff).run();
  return result.meta.changes ?? 0;
}

/** DDR-style discovery record so clients can find the tenant's own DoH (RFC 9462). */
export function masterDnsSvcbContent(workerHostname: string): string {
  return `1 ${workerHostname}. alpn=h2 port=443`;
}

export async function logDnsCenterAction(
  env: Env,
  tenantId: string,
  actorId: string,
  action: string,
  resourceId: string,
): Promise<void> {
  await audit(env, {
    tenantId,
    actorType: "user",
    actorId,
    action,
    resourceType: "deployment",
    resourceId,
    outcome: "success",
  });
}
