import { rateLimit } from "./db";
import { HttpError } from "./http";
import type { Env } from "./types";

/**
 * PHANTOM client-config generator, ported from the retired standalone
 * `worker.js` (OMNI-PHANTOM ULTIMATE) so the bot sections users knew
 * (👻 PHANTOM 20تایی / 🛡️ 10تایی ساده) work again — but natively, with the
 * honest caveats the old panel never printed:
 *
 * - L1 (Arvan IP + spoofed SNI) and L3 (Warp) links are EXPERIMENTAL decoys:
 *   TLS terminates on the Arvan/CF edge and never reaches a VLESS handler.
 * - L2 (clean CF IP + SNI = the user's own domain) is the RELIABLE layer.
 *
 * Only client-side link generation lives here; nothing is deployed and no
 * third-party code is fetched.
 */

export interface PhantomFragment {
  len: string;
  interval: string;
  packets: string;
}

export interface PhantomLink {
  tier: "L1-Arvan" | "L2-CF" | "L3-Warp";
  sni: string;
  ip: string;
  port: number;
  type: "ws" | "xhttp" | "grpc";
  path: string;
  fp: string;
  frag: PhantomFragment;
  link: string;
}

export interface PhantomPackage {
  vless: PhantomLink[];
  ss: string[];
  hy: string[];
}

const ARVAN_CLEAN_IPS = [
  "185.143.232.1", "185.143.232.13", "185.143.232.36", "185.143.233.9",
  "185.143.233.14", "185.143.234.18", "185.143.234.22", "94.182.182.10",
  "37.32.16.11", "185.143.232.100", "185.143.232.20", "185.143.232.42",
  "185.143.233.48", "185.143.234.12", "37.32.20.15", "37.255.81.1",
  "94.182.182.22", "185.143.234.120",
];
const CF_CLEAN_IPS = [
  "104.16.132.229", "104.17.209.9", "172.67.73.161", "104.21.32.115",
  "104.26.12.188", "172.67.182.201", "162.159.140.38", "104.16.18.15",
  "104.17.24.15", "172.67.12.188", "162.159.36.1", "104.21.64.1",
  "172.67.73.88", "104.26.10.12",
];
const WARP_IPS = ["188.114.96.1", "188.114.97.1", "162.159.192.1", "162.159.193.1", "162.159.193.10", "188.114.96.10"];
const WHITELIST_SNI = ["snapp.ir", "digikala.com", "myket.ir", "aparat.com", "divar.ir", "cdn.mediad.ir", "bmi.ir", "telewebion.com"];
const ARVAN_PORTS = [443, 8443, 2053, 2087, 2096];
const UTLS_FPS = ["chrome", "firefox", "safari", "randomized", "chrome_120", "firefox_128", "ios"];

function rand<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T;
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function genevaFragment(): PhantomFragment {
  return {
    len: `${randInt(10, 30)}-${randInt(40, 100)}`,
    interval: `${randInt(1, 5)}-${randInt(10, 20)}`,
    packets: rand(["tlshello", "1-1", "1-2", "1-3"] as const),
  };
}

function utlsFp(): string {
  return rand(UTLS_FPS);
}

function vlessLink(uuid: string, ip: string, port: number, params: string, label: string): string {
  return `vless://${uuid}@${ip}:${port}?${params}#${encodeURIComponent(label)}`;
}

/** Full 3-tier package: 7 Arvan + 7 CF + 6 Warp VLESS, plus SS2022/HY2 samples. */
export function generatePhantomConfigs(domain: string, uuid: string): PhantomPackage {
  const all: PhantomLink[] = [];
  // Layer 1: Arvan — WS + XHTTP (experimental decoy)
  for (let i = 0; i < 7; i++) {
    const sni = WHITELIST_SNI[i % WHITELIST_SNI.length] as string;
    const ip = ARVAN_CLEAN_IPS[i % ARVAN_CLEAN_IPS.length] as string;
    const port = ARVAN_PORTS[i % ARVAN_PORTS.length] as number;
    const frag = genevaFragment();
    const fp = utlsFp();
    const type: PhantomLink["type"] = i % 2 === 0 ? "ws" : "xhttp";
    const path = type === "xhttp" ? "/xhttp?mode=auto" : "/?ed=2048";
    const ech = i % 3 === 0 ? "&ech=true" : "";
    const link = vlessLink(
      uuid, ip, port,
      `encryption=none&security=tls&sni=${sni}&fp=${fp}&type=${type}&host=${domain}&path=${encodeURIComponent(path)}${ech}&fragment=${frag.len},${frag.interval},${frag.packets}`,
      `[L1-Arvan] ${sni}-${type}-${port}`,
    );
    all.push({ tier: "L1-Arvan", sni, ip, port, type, path, fp, frag, link });
  }
  // Layer 2: CF — WS + gRPC + fragment (the reliable path)
  for (let i = 0; i < 7; i++) {
    const sni = domain;
    const ip = CF_CLEAN_IPS[i % CF_CLEAN_IPS.length] as string;
    const port = 443;
    const frag = genevaFragment();
    const fp = utlsFp();
    const type: PhantomLink["type"] = i % 3 === 0 ? "grpc" : "ws";
    const path = type === "grpc" ? "grpc-mode" : "/?ed=2048";
    const link = vlessLink(
      uuid, ip, port,
      `encryption=none&security=tls&sni=${sni}&fp=${fp}&type=${type}&host=${domain}&path=${encodeURIComponent(path)}&fragment=${frag.len},${frag.interval},${frag.packets}&allowInsecure=1`,
      `[L2-CF] ${type}-${ip}`,
    );
    all.push({ tier: "L2-CF", sni, ip, port, type, path, fp, frag, link });
  }
  // Layer 3: Warp on Warp (experimental decoy)
  for (let i = 0; i < 6; i++) {
    const ip = WARP_IPS[i % WARP_IPS.length] as string;
    const sni = rand(WHITELIST_SNI);
    const frag = genevaFragment();
    const fp = utlsFp();
    const path = "/?ed=2048";
    const link = vlessLink(
      uuid, ip, 443,
      `encryption=none&security=tls&sni=${sni}&fp=${fp}&type=ws&host=${domain}&path=${encodeURIComponent(path)}&fragment=${frag.len},${frag.interval},${frag.packets}`,
      `[L3-Warp] ${sni}`,
    );
    all.push({ tier: "L3-Warp", sni, ip, port: 443, type: "ws", path, fp, frag, link });
  }

  const ssKey = btoa(uuid.replace(/-/gu, "")).substring(0, 32);
  const ss = [
    `ss://2022-blake3-aes-128-gcm:${ssKey}@${rand(ARVAN_CLEAN_IPS)}:443#${encodeURIComponent("[SS2022] Arvan-Cloak")}`,
    `ss://2022-blake3-chacha20-poly1305:${ssKey}@${rand(CF_CLEAN_IPS)}:443#${encodeURIComponent("[SS2022] CF-Cloak")}`,
  ];
  const hy = [
    `hysteria2://${uuid}@${rand(ARVAN_CLEAN_IPS)}:443?insecure=1&sni=${rand(WHITELIST_SNI)}#${encodeURIComponent("[HY2-QUIC] Arvan")}`,
    `tuic://${uuid}:${uuid}@${rand(CF_CLEAN_IPS)}:443?congestion_control=bbr&udp_relay_mode=native&alpn=h3&sni=${domain}#${encodeURIComponent("[TUIC] CF")}`,
  ];
  return { vless: all, ss, hy };
}

/** Honest 10-pack: only the reliable L2 (clean CF) layer, 10 configs. */
export function generateSimpleConfigs(domain: string, uuid: string): PhantomLink[] {
  const out: PhantomLink[] = [];
  for (let i = 0; i < 10; i++) {
    const sni = domain;
    const ip = CF_CLEAN_IPS[i % CF_CLEAN_IPS.length] as string;
    const frag = genevaFragment();
    const fp = utlsFp();
    const type: PhantomLink["type"] = i % 3 === 0 ? "grpc" : "ws";
    const path = type === "grpc" ? "grpc-mode" : "/?ed=2048";
    const link = vlessLink(
      uuid, ip, 443,
      `encryption=none&security=tls&sni=${sni}&fp=${fp}&type=${type}&host=${domain}&path=${encodeURIComponent(path)}&fragment=${frag.len},${frag.interval},${frag.packets}&allowInsecure=1`,
      `[L2-CF] ${type}-${i + 1}`,
    );
    out.push({ tier: "L2-CF", sni, ip, port: 443, type, path, fp, frag, link });
  }
  return out;
}

export function toV2RayBase64(lines: string[]): string {
  return btoa(unescape(encodeURIComponent(lines.join("\n"))));
}

export function toClashYaml(configs: PhantomLink[], domain: string, uuid: string): string {
  let yaml = "proxies:\n";
  configs.forEach((c, i) => {
    yaml += [
      `  - name: "${c.tier}-${i + 1}"`,
      "    type: vless",
      `    server: ${c.ip}`,
      `    port: ${c.port}`,
      `    uuid: ${uuid}`,
      "    tls: true",
      `    servername: ${c.sni}`,
      `    fingerprint: ${c.fp}`,
      `    network: ${c.type === "grpc" ? "grpc" : "ws"}`,
      "    ws-opts:",
      `      path: "${c.path}"`,
      "      headers:",
      `        Host: ${domain}`,
      "    fragmentation:",
      "      enabled: true",
      `      length: ${c.frag.len}`,
      `      interval: ${c.frag.interval}`,
    ].join("\n") + "\n";
  });
  yaml += "\nproxy-groups:\n  - name: OMNI-PHANTOM\n    type: url-test\n    proxies: ["
    + configs.map((c, i) => `"${c.tier}-${i + 1}"`).join(", ")
    + "]\n    url: https://www.gstatic.com/generate_204\n    interval: 30\n";
  return yaml;
}

export function toSingBoxJson(configs: PhantomLink[], ssLinks: string[], domain: string, uuid: string): string {
  const outbounds: Array<Record<string, unknown>> = configs.map((c, i) => ({
    type: "vless",
    tag: `${c.tier}-${i + 1}`,
    server: c.ip,
    server_port: c.port,
    uuid,
    tls: { enabled: true, server_name: c.sni, insecure: true, utls: { enabled: true, fingerprint: c.fp } },
    transport: { type: c.type === "grpc" ? "grpc" : "ws", path: c.path, headers: { Host: domain } },
    multiplex: { enabled: true, max_streams: 8 },
  }));
  ssLinks.forEach((s, i) => {
    const [, rest = ""] = s.split("://");
    const [methodPart = "", hostPart = ""] = rest.split("@");
    const [method = "", password = ""] = methodPart.split(":");
    const server = hostPart.split(":")[0] ?? "";
    outbounds.push({
      type: "shadowsocks",
      tag: `SS2022-${i + 1}`,
      server,
      server_port: 443,
      method,
      password,
    });
  });
  return JSON.stringify(
    { outbounds, route: { auto_detect_interface: true }, experimental: { cache_file: { enabled: true } } },
    null,
    2,
  );
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/u;

export function normalizePhantomDomain(input: string): string | null {
  const cleaned = input.trim().toLowerCase().replace(/^https?:\/\//u, "").split("/")[0]?.trim() ?? "";
  if (!DOMAIN_RE.test(cleaned) || cleaned.length > 253) return null;
  return cleaned;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Accepts a real UUID verbatim; anything else (including "new") becomes a fresh one. */
export function normalizePhantomUuid(input: string): string {
  const cleaned = input.trim().toLowerCase();
  if (UUID_RE.test(cleaned)) return cleaned;
  return crypto.randomUUID();
}

export interface PhantomSummary {
  domain: string;
  uuid: string;
  mode: "full" | "simple";
  baseUrl: string;
}

export function phantomSubUrls(summary: PhantomSummary): { v2ray: string; clash: string; singbox: string } {
  const base = `${summary.baseUrl}/api/v1/phantom?domain=${encodeURIComponent(summary.domain)}&uuid=${encodeURIComponent(summary.uuid)}`;
  return {
    v2ray: `${base}&format=v2ray`,
    clash: `${base}&format=clash`,
    singbox: `${base}&format=singbox`,
  };
}

export function renderPhantomPackageText(summary: PhantomSummary): string {
  const urls = phantomSubUrls(summary);
  if (summary.mode === "simple") {
    const configs = generateSimpleConfigs(summary.domain, summary.uuid);
    const lines = configs.map((c) => c.link);
    let out = `🛡️ <b>پکیج نت ملی 10تایی (لایهٔ قابل اتکا L2)</b>\n🌐 ${summary.domain}\n🔑 <code>${summary.uuid}</code>\n\n`;
    out += `<b>ساب V2Ray (base64):</b>\n<code>${toV2RayBase64(lines)}</code>\n\n`;
    out += `<b>ساب SingBox:</b>\n<code>${urls.singbox}</code>\n\n<b>نمونه:</b>\n`;
    configs.slice(0, 2).forEach((c, i) => {
      out += `\n${i + 1}. <code>${c.link}</code>`;
    });
    return out;
  }
  const pkg = generatePhantomConfigs(summary.domain, summary.uuid);
  let out = `👻 <b>PHANTOM 20تایی ساخته شد!</b>\n\n🌐 دامنه: <code>${summary.domain}</code>\n🔑 UUID: <code>${summary.uuid}</code>\n\n`;
  out += "<b>📡 ساب‌ها (3 فرمت):</b>\n";
  out += `• V2Ray (24 لینک): \n<code>${urls.v2ray}</code>\n`;
  out += `• Clash YAML: \n<code>${urls.clash}</code>\n`;
  out += `• SingBox JSON: \n<code>${urls.singbox}</code>\n\n`;
  out += "<b>نمونه 3 تا:</b>\n";
  pkg.vless.slice(0, 3).forEach((c, i) => {
    out += `\n${i + 1}. <code>${c.link}</code>\n   └ ${c.tier} | ${c.type} | fp:${c.fp} | frag:${c.frag.len}`;
  });
  out += "\n\n<b>لایه‌ها:</b> 7 Arvan + 7 CF + 6 Warp\n";
  out += "⚠️ صادقانه: لایه‌های L1/L3 دکوی آزمایشی‌اند (TLS در لبه تمام می‌شود)؛ مسیر قابل اتکا L2 است.";
  return out;
}

// ---------------------------------------------------------------------------
// Public subscription endpoint (GET /api/v1/phantom).
// ---------------------------------------------------------------------------

export async function phantomSubscription(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await rateLimit(env, `phantom:${clientIp}`, 60, 3600))) {
    throw new HttpError(429, "rate_limited", "Too many requests");
  }
  const domain = normalizePhantomDomain(url.searchParams.get("domain") ?? "");
  const uuid = url.searchParams.get("uuid") ?? "";
  if (!domain || !UUID_RE.test(uuid.toLowerCase())) {
    throw new HttpError(400, "invalid_params", "domain and uuid are required (uuid must be a UUID)");
  }
  const format = (url.searchParams.get("format") ?? "v2ray").toLowerCase();
  const pkg = generatePhantomConfigs(domain, uuid);
  const textPlain = { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" };
  if (format === "clash") {
    return new Response(toClashYaml(pkg.vless, domain, uuid), { headers: { "Content-Type": "text/yaml", "Access-Control-Allow-Origin": "*" } });
  }
  if (format === "singbox") {
    return new Response(toSingBoxJson(pkg.vless, pkg.ss, domain, uuid), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  }
  const lines = [...pkg.vless.map((c) => c.link), ...pkg.ss, ...pkg.hy];
  return new Response(toV2RayBase64(lines), { headers: textPlain });
}
