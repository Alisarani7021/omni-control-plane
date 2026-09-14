import { MAP_ISPS } from "./censorship-map";
import { HttpError } from "./http";
import { escapeHtml, nowIso } from "./security";
import type { Env } from "./types";

/**
 * DNS poisoning self-test ("اول تست، بعد تجویز").
 *
 * The client (a bash+python3 script served by this Worker, or any equivalent
 * tool) queries a fixed set of canary names through a fixed set of resolvers
 * and submits the RAW answers. The server only classifies them:
 * a canary answer that lands in a documented blackhole range (loopback,
 * unspecified, or the well-known Iranian injection address 10.10.34.34)
 * counts as fake. Counts are shown honestly ("۴ از  پاسخ جعلی") and fed into
 * the censorship-map aggregate per (isp, city).
 *
 * The server never fabricates resolver answers and never probes resolvers on
 * behalf of users (poisoning is only observable from inside the censored path).
 */

export const POISON_RETENTION_HOURS = 24;
export const POISON_WINDOW_HOURS = 6;

export interface PoisonResolver {
  id: string;
  label: string;
  /** IPv4 of the recursive resolver the client script queries (UDP/53). "system" = getaddrinfo. */
  ip: string | null;
}

export const POISON_RESOLVERS: readonly PoisonResolver[] = [
  { id: "system", label: "رزولور سامانه", ip: null },
  { id: "cf-1111", label: "1.1.1.1", ip: "1.1.1.1" },
  { id: "cf-doh", label: "dns.cloudflare.com (DoH)", ip: "https://dns.cloudflare.com/dns-query" },
  { id: "shecan", label: "Shecan", ip: "178.22.100.100" },
  { id: "melli", label: "رزولور ملی", ip: "178.22.122.100" },
  { id: "403online", label: "403.online", ip: "10.202.10.10" },
  { id: "radar", label: "Radar", ip: "10.202.10.202" },
];

export const POISON_CANARIES: readonly string[] = [
  "dns.google",
  "cloudflare.com",
  "www.wikipedia.org",
];

/** Documented blackhole/poison answers. Anything else is treated as a real answer. */
export const POISON_BLACKHOLE: readonly string[] = ["0.0.0.0", "10.10.34.34"];

export function isBlackholeAnswer(answer: string): boolean {
  const value = answer.trim().toLowerCase();
  if (value.startsWith("127.")) return true;
  return POISON_BLACKHOLE.includes(value);
}

export interface PoisonEntry {
  resolver: string;
  canary: string;
  answers: string[];
}

export interface PoisonVerdict {
  total: number;
  fake: number;
  perResolver: { resolver: string; total: number; fake: number }[];
}

/** Pure evaluation of one submitted test run. */
export function evaluatePoisonTest(entries: PoisonEntry[]): PoisonVerdict {
  const perResolver = new Map<string, { total: number; fake: number }>();
  let total = 0;
  let fake = 0;
  for (const entry of entries) {
    const bucket = perResolver.get(entry.resolver) ?? { total: 0, fake: 0 };
    let entryFake = 0;
    for (const answer of entry.answers) {
      total += 1;
      bucket.total += 1;
      if (isBlackholeAnswer(answer)) {
        fake += 1;
        entryFake += 1;
        bucket.fake += 1;
      }
    }
    perResolver.set(entry.resolver, bucket);
  }
  return {
    total,
    fake,
    perResolver: [...perResolver.entries()].map(([resolver, stat]) => ({ resolver, ...stat })),
  };
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

export interface PoisonReportInput {
  isp: string;
  city: string;
  entries: PoisonEntry[];
}

export function parsePoisonReport(input: unknown): PoisonReportInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "invalid_input", "Expected a JSON object");
  }
  const body = input as Record<string, unknown>;
  const rawEntries = body.entries ?? body.results;
  if (!Array.isArray(rawEntries) || rawEntries.length === 0 || rawEntries.length > 64) {
    throw new HttpError(400, "invalid_input", "entries list is invalid");
  }
  const knownResolvers = new Set(POISON_RESOLVERS.map((resolver) => resolver.id));
  const knownCanaries = new Set(POISON_CANARIES);
  const entries: PoisonEntry[] = [];
  for (const raw of rawEntries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const resolver = typeof item.resolver === "string" && knownResolvers.has(item.resolver) ? item.resolver : null;
    const canary = typeof item.canary === "string" && knownCanaries.has(item.canary.toLowerCase()) ? item.canary.toLowerCase() : null;
    const answersRaw = Array.isArray(item.answers) ? item.answers : [];
    if (!resolver || !canary) continue;
    const answers = answersRaw
      .filter((answer): answer is string => typeof answer === "string")
      .map((answer) => answer.slice(0, 64))
      .slice(0, 16);
    entries.push({ resolver, canary, answers });
  }
  if (entries.length === 0) throw new HttpError(400, "invalid_input", "No usable resolver answers");
  const isp = typeof body.isp === "string" && MAP_ISPS.includes(body.isp) ? body.isp : "سایر";
  return { isp, city: sanitizeCity(body.city), entries };
}

export async function recordPoisonReport(env: Env, report: PoisonReportInput): Promise<PoisonVerdict> {
  const verdict = evaluatePoisonTest(report.entries);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO dns_poison_reports (id, isp, city, fake_count, total_count, detail, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    report.isp,
    report.city,
    verdict.fake,
    verdict.total,
    JSON.stringify(verdict.perResolver),
    nowIso(),
    new Date(now + POISON_RETENTION_HOURS * 3_600_000).toISOString(),
  ).run();
  return verdict;
}

export interface PoisonSummary {
  reports: number;
  fake: number;
  total: number;
  topCells: { isp: string; city: string; fake: number; total: number }[];
}

export async function poisonSummary(env: Env, windowHours = POISON_WINDOW_HOURS): Promise<PoisonSummary> {
  const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();
  const rows = await env.DB.prepare(
    `SELECT isp, city, SUM(fake_count) AS fake, SUM(total_count) AS total, COUNT(*) AS n
     FROM dns_poison_reports WHERE created_at > ?
     GROUP BY isp, city ORDER BY fake DESC LIMIT 5`,
  ).bind(since).all<{ isp: string; city: string; fake: number; total: number; n: number }>();
  const cells = (rows.results ?? []).map((row) => ({ isp: row.isp, city: row.city, fake: row.fake, total: row.total }));
  return {
    reports: (rows.results ?? []).length,
    fake: cells.reduce((sum, cell) => sum + cell.fake, 0),
    total: cells.reduce((sum, cell) => sum + cell.total, 0),
    topCells: cells,
  };
}

export function poisonLine(summary: PoisonSummary): string | null {
  if (summary.total === 0) return null;
  const top = summary.topCells[0];
  const where = top ? ` (${escapeHtml(top.city)}/${escapeHtml(top.isp)})` : "";
  return `🧪 مسمومیت DNS: ${summary.fake} از ${summary.total} پاسخ جعلی${where} — تست اول، تجویز بعد.`;
}

export async function purgeExpiredPoisonReports(env: Env): Promise<number> {
  const result = await env.DB.prepare("DELETE FROM dns_poison_reports WHERE expires_at <= ?").bind(nowIso()).run();
  return result.meta.changes ?? 0;
}

/** Crowd MTU telemetry (winner per isp/city of the five-size probe). */
export function parseMtuReport(input: unknown): { isp: string; city: string; mtu: number } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "invalid_input", "Expected a JSON object");
  }
  const body = input as Record<string, unknown>;
  const mtu = typeof body.mtu === "number" && Number.isInteger(body.mtu) ? body.mtu : Number.NaN;
  if (!Number.isInteger(mtu) || mtu < 512 || mtu > 1400) {
    throw new HttpError(400, "invalid_input", "mtu must be an integer between 512 and 1400");
  }
  const isp = typeof body.isp === "string" && MAP_ISPS.includes(body.isp) ? body.isp : "سایر";
  return { isp, city: sanitizeCity(body.city), mtu };
}

export async function recordMtuReport(env: Env, report: { isp: string; city: string; mtu: number }): Promise<void> {
  const now = Date.now();
  const expires = new Date(now + POISON_RETENTION_HOURS * 3_600_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO mtu_reports (isp, city, mtu, samples, updated_at, expires_at)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(isp, city) DO UPDATE SET
       mtu = CASE WHEN excluded.mtu > mtu_reports.mtu THEN excluded.mtu ELSE mtu_reports.mtu END,
       samples = samples + 1,
       updated_at = excluded.updated_at,
       expires_at = excluded.expires_at`,
  ).bind(report.isp, report.city, report.mtu, nowIso(), expires).run();
}

export async function mtuSuggestion(env: Env, isp?: string, city?: string): Promise<{ isp: string; city: string; mtu: number; samples: number } | null> {
  const row = isp && city
    ? await env.DB.prepare("SELECT isp, city, mtu, samples FROM mtu_reports WHERE isp = ? AND city = ? AND expires_at > ?")
      .bind(isp, city, nowIso()).first<{ isp: string; city: string; mtu: number; samples: number }>()
    : await env.DB.prepare("SELECT isp, city, mtu, samples FROM mtu_reports WHERE expires_at > ? ORDER BY samples DESC LIMIT 1")
      .bind(nowIso()).first<{ isp: string; city: string; mtu: number; samples: number }>();
  return row ?? null;
}

export async function purgeExpiredMtuReports(env: Env): Promise<number> {
  const result = await env.DB.prepare("DELETE FROM mtu_reports WHERE expires_at <= ?").bind(nowIso()).run();
  return result.meta.changes ?? 0;
}

/**
 * The client-side test script. It runs on the USER's machine (the only place
 * where poisoning is observable), submits raw answers, and prints the verdict
 * the server computed. No secret, no token, no install.
 */
export function renderDnsTestScript(origin: string): string {
  const resolvers = POISON_RESOLVERS.map((resolver) => `${resolver.id}|${resolver.ip ?? ""}`).join(" ");
  const canaries = POISON_CANARIES.join(" ");
  return `#!/usr/bin/env bash
# V13 DNS poisoning self-test — run on the machine whose DNS you distrust.
# Queries ${POISON_CANARIES.length} canary names through ${POISON_RESOLVERS.length} resolvers and submits RAW answers.
# The server classifies fake answers (blackhole ranges) and answers with the verdict.
set -Eeuo pipefail
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
RESOLVERS="${resolvers}"
CANARIES="${canaries}"
ENDPOINT="${origin}/api/v1/telemetry/dns-poison"
ISP="\${1:-سایر}"
CITY="\${2:-نامشخص}"
payload=$(python3 - "$RESOLVERS" "$CANARIES" <<'PY'
import base64, json, socket, struct, sys, random, urllib.request
resolvers, canaries = sys.argv[1].split(" "), sys.argv[2].split(" ")
def wire_query(name):
    tid = random.randint(0, 65535)
    header = struct.pack(">HHHHHH", tid, 0x0100, 1, 0, 0, 0)
    question = b"".join(bytes([len(p)]) + p.encode() for p in name.split(".")) + b"\\x00" + struct.pack(">HH", 1, 1)
    return tid, header + question
def parse_answers(data):
    answers, offset = [], 12
    while data[offset] != 0:
        offset += data[offset] + 1
    offset += 5
    count = struct.unpack(">H", data[6:8])[0]
    for _ in range(count):
        while offset < len(data):
            length = data[offset]
            if length == 0:
                offset += 1
                break
            if length & 0xC0:
                offset += 2
                break
            offset += length + 1
        rtype = struct.unpack(">H", data[offset:offset + 2])[0]
        rdlength = struct.unpack(">H", data[offset + 8:offset + 10])[0]
        rdata = data[offset + 10:offset + 10 + rdlength]
        if rtype == 1 and rdlength == 4:
            answers.append(".".join(str(byte) for byte in rdata))
        offset += 10 + rdlength
    return answers
def query(server, name):
    tid, packet = wire_query(name)
    try:
        if server == "":
            return [info[4][0] for info in socket.getaddrinfo(name, None, socket.AF_INET)]
        if server.startswith("https://"):
            request = urllib.request.Request(server, data=packet, headers={"Content-Type": "application/dns-message", "Accept": "application/dns-message"})
            with urllib.request.urlopen(request, timeout=6) as response:
                return parse_answers(response.read())
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(4)
            sock.sendto(packet, (server, 53))
            data = sock.recv(4096)
        return parse_answers(data)
    except OSError:
        return []
    except Exception:
        return []
out = []
for resolver in resolvers:
    rid, _, rip = resolver.partition("|")
    for canary in canaries:
        out.append({"resolver": rid, "canary": canary, "answers": query(rip, canary)})
print(json.dumps({"entries": out}, ensure_ascii=False))
PY
)
body=$(python3 -c "import json,sys; d=json.load(sys.stdin); d['isp']=sys.argv[1]; d['city']=sys.argv[2]; print(json.dumps(d, ensure_ascii=False))" <<<"$payload" "$ISP" "$CITY")
response=$(curl --fail --show-error --silent --proto '=https' --tlsv1.2 -H 'Content-Type: application/json' --data-binary "$body" "$ENDPOINT")
python3 -c "import json,sys; d=json.load(sys.stdin); print('جعلی: %d از %d پاسخ' % (d['fake'], d['total'])); [print('  %s: %d/%d' % (r['resolver'], r['fake'], r['total'])) for r in d['perResolver'] if r['fake']]" <<<"$response"
`;
}
