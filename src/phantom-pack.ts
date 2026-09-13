/**
 * PHANTOM 20تایی — the honest half of the OMNI worker's generator: `domain + uuid`
 * in, twenty deterministic client configs in three subscription formats out.
 * Kept: packaging. Absent on purpose: measured-reachability claims, invented
 * "layers", and proxy hosting on our side.
 */

/** Config count, matching the old worker's "20تایی". */
export const PACK_SIZE = 20;

const PACK_PORTS = [443, 8443, 2053, 2083, 2087, 2096];
const PACK_FINGERPRINTS = ["chrome", "firefox", "safari", "edge", "ios", "android"];
const SS_METHODS = ["chacha20-ietf-poly1305", "aes-256-gcm", "2022-blake3-aes-128-gcm", "2022-blake3-chacha20-poly1305"];

export type PackKind = "vless" | "ss" | "hysteria2";

export interface PackEntry {
  label: string;
  kind: PackKind;
  port: number;
  link: string;
}

export interface PhantomPack {
  domain: string;
  uuid: string;
  entries: PackEntry[];
  counts: Record<PackKind, number>;
}

export function sanitizePackDomain(input: string): string | null {
  const raw = input.trim().toLowerCase();
  const withoutScheme = raw.includes("://") ? raw.slice(raw.indexOf("://") + 3) : raw;
  const host = withoutScheme.split("/")[0]?.split(":")[0] ?? "";
  if (host.length < 4 || host.length > 253 || !host.includes(".") || host.includes(" ")) return null;
  if (!/^[a-z0-9.-]+$/u.test(host)) return null;
  const parts = host.split(".");
  if (parts.some((part) => part.length === 0 || part.length > 63)) return null;
  if (!/^[a-z]{2,}$/u.test(parts[parts.length - 1] ?? "")) return null;
  return host;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** `new`/empty mints a fresh UUID; 8+ char ids pass through (some panels use short ids). */
export function normalizePackUuid(input: string | undefined): string {
  const value = (input ?? "").trim().toLowerCase();
  if (value.length === 0 || value === "new" || value === "uuid") return crypto.randomUUID();
  if (UUID_PATTERN.test(value)) return value;
  if (/^[a-z0-9-]{8,64}$/u.test(value)) return value;
  return crypto.randomUUID();
}

function toBase64(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toBase64Url(value: string): string {
  return toBase64(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** Accepts `example.com`, `https://example.com/x` or `example.com:443`. */
function vlessLink(domain: string, uuid: string, port: number, fingerprint: string, label: string, index: number): string {
  const params = new URLSearchParams({
    type: "ws",
    security: "tls",
    sni: domain,
    fp: fingerprint,
    alpn: "h2",
    host: domain,
    path: `/vless?ed=2048&security=tls&sni=${domain}`,
    seed: "null",
  });
  return `vless://${uuid}@${domain}:${port}?${params.toString()}#${encodeURIComponent(label)}-${index + 1}`;
}

function ssLink(domain: string, uuid: string, port: number, method: string, label: string): string {
  // Blake3-2022 wants a key of exactly 16 bytes; others take the uuid as-is.
  const key = method.startsWith("2022") ? toBase64(uuid.replace(/-/gu, "")).slice(0, 16) : uuid;
  const userinfo = toBase64Url(`${method}:${key}`);
  const params = new URLSearchParams({ plugin: "obfs-local;obfs=http;obfs-host=" + domain, obfsParam: domain });
  return `ss://${userinfo}@${domain}:${port}?${params.toString()}#${encodeURIComponent(label)}`;
}

function hysteria2Link(domain: string, uuid: string, port: number, label: string): string {
  const params = new URLSearchParams({ sni: domain, "obfs": "salamander", "obfs-password": uuid.slice(0, 8) });
  return `hy2://${uuid}@${domain}:${port}?${params.toString()}#${encodeURIComponent(label)}`;
}

export function buildPhantomPack(domainInput: string, uuidInput?: string): PhantomPack {
  const domain = sanitizePackDomain(domainInput);
  if (!domain) throw new Error("invalid_pack_domain");
  const uuid = normalizePackUuid(uuidInput);
  const entries: PackEntry[] = [];
  const counts: Record<PackKind, number> = { vless: 0, ss: 0, hysteria2: 0 };

  // Twelve VLESS/WS/TLS configs over the CDN-friendly ports and uTLS hello ids.
  for (let i = 0; i < 12; i += 1) {
    const port = PACK_PORTS[i % PACK_PORTS.length] ?? 443;
    const fingerprint = PACK_FINGERPRINTS[i % PACK_FINGERPRINTS.length] ?? "chrome";
    entries.push({ label: `VL-${port}-${fingerprint}`, kind: "vless", port, link: vlessLink(domain, uuid, port, fingerprint, `VL${port}`, i) });
    counts.vless += 1;
  }
  // Four Shadowsocks-2022 / AEAD ciphers.
  for (let i = 0; i < SS_METHODS.length; i += 1) {
    const port = PACK_PORTS[i % PACK_PORTS.length] ?? 443;
    entries.push({ label: `SS-${SS_METHODS[i]}`, kind: "ss", port, link: ssLink(domain, uuid, port, SS_METHODS[i] ?? "aes-256-gcm", `SS${port}`) });
    counts.ss += 1;
  }
  // Remaining slots: Hysteria2 over UDP on the usual high ports.
  const hyPorts = [8443, 443, 2087, 2053, 50000];
  while (entries.length < PACK_SIZE) {
    const index = entries.length - 12 - SS_METHODS.length;
    const port = hyPorts[index % hyPorts.length] ?? 443;
    entries.push({ label: `HY2-${port}`, kind: "hysteria2", port, link: hysteria2Link(domain, uuid, port, `HY2-${index + 1}`) });
    counts.hysteria2 += 1;
  }
  return { domain, uuid, entries, counts };
}

export function packToSubscription(pack: PhantomPack): string {
  return toBase64(pack.entries.map((entry) => entry.link).join("\n"));
}

export function packToClashYaml(pack: PhantomPack): string {
  const lines = ["proxies:"];
  for (const entry of pack.entries) {
    if (entry.kind === "vless") {
      lines.push(
        `  - name: "${entry.label}"`,
        "    type: vless",
        `    server: ${pack.domain}`,
        `    port: ${entry.port}`,
        `    uuid: ${pack.uuid}`,
        "    tls: true",
        "    network: ws",
        `    servername: ${pack.domain}`,
        "    udp: true",
        "    client-fingerprint: chrome",
        "    ws-opts:",
        `      path: "/vless?ed=2048&security=tls&sni=${pack.domain}"`,
        `      headers:`,
        `        Host: ${pack.domain}`,
      );
    } else if (entry.kind === "ss") {
      lines.push(
        `  - name: "${entry.label}"`,
        "    type: shadowsocks",
        `    server: ${pack.domain}`,
        `    port: ${entry.port}`,
        `    cipher: ${entry.label.replace("SS-", "")}`,
        `    password: ${pack.uuid}`,
      );
    } else {
      lines.push(
        `  - name: "${entry.label}",`,
        "    type: hysteria2",
        `    server: ${pack.domain}`,
        `    port: ${entry.port}`,
        `    password: ${pack.uuid}`,
        `    sni: ${pack.domain}`,
      );
    }
  }
  lines.push(
    "proxy-groups:",
    "  - name: PHANTOM",
    "    type: url-test",
    `    proxies: [${pack.entries.map((entry) => `"${entry.label}"`).join(", ")}]`,
    "    url: https://www.gstatic.com/generate_204",
    "    interval: 30",
  );
  return lines.join("\n");
}

export function packToSingBox(pack: PhantomPack): string {
  const outbounds = pack.entries.map((entry) => {
    if (entry.kind === "vless") {
      return {
        tag: entry.label,
        type: "vless",
        server: pack.domain,
        server_port: entry.port,
        uuid: pack.uuid,
        tls: { enabled: true, server_name: pack.domain, utls: { enabled: true, fingerprint: "chrome" } },
        transport: { type: "ws", path: `/vless?ed=2048&security=tls&sni=${pack.domain}`, headers: { Host: pack.domain } },
      };
    }
    if (entry.kind === "ss") {
      return { tag: entry.label, type: "shadowsocks", server: pack.domain, server_port: entry.port, method: entry.label.replace("SS-", ""), password: pack.uuid };
    }
    return { tag: entry.label, type: "hysteria2", server: pack.domain, server_port: entry.port, password: pack.uuid, tls: { enabled: true, server_name: pack.domain, insecure: true } };
  });
  return JSON.stringify(
    {
      log: { level: "info" },
      outbounds: [{ type: "selector", tag: "PHANTOM", outbounds: outbounds.map((entry) => entry.tag) }, ...outbounds],
    },
    null,
    2,
  );
}

export const PACK_WARNING =
  "⚠️ این فقط کانفیگ است، نه تست: هیچ‌کدام را اندازه نگرفته‌ایم. سرور باید خودش روی همین دامنه/پورت بالا باشد.";

const FA_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];

/** Persian digits for user-facing counters, so a line never mixes two numeral systems. */
export function faDigits(value: number | string): string {
  return String(value).replace(/\d/gu, (digit) => FA_DIGITS[Number(digit)] ?? digit);
}

/** Chat summary for a generated pack. The links are the product; nothing is stored server side. */
export function packLinkText(pack: PhantomPack, endpointBase: string): string {
  const query = `domain=${pack.domain}&uuid=${pack.uuid}`;
  return [
    `👻 <b>بستهٔ ${faDigits(pack.entries.length)} کانفیگ PHANTOM آماده شد</b>`,
    "",
    `🌐 دامنه: <code>${pack.domain}</code>`,
    `🔑 UUID: <code>${pack.uuid}</code>`,
    `🧮 VLESS ${faDigits(pack.counts.vless)} · SS ${faDigits(pack.counts.ss)} · Hysteria2 ${faDigits(pack.counts.hysteria2)}`,
    "",
    `📦 اشتراک (v2rayNG / Streisand / Happ):\n<code>${endpointBase}?${query}&format=v2ray</code>`,
    `🐱 Clash Meta:\n<code>${endpointBase}?${query}&format=clash</code>`,
    `🎵 sing-box:\n<code>${endpointBase}?${query}&format=singbox</code>`,
    "",
    PACK_WARNING,
    "",
    "🧨 این پیام UUID شما را نشان می‌دهد؛ بعد از افزودن به اپ، آن را حذف کنید.",
  ].join("\n");
}
