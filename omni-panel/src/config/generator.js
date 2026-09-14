/**
 * Config generation.
 *
 * One pure module, no DOM, no globals — so the exact same code produces the
 * subscription string on the edge and in the unit tests. Zeus builds these
 * strings inline in three different places with three slightly different
 * escaping rules, which is why some clients parse its output and others don't.
 */

export const TLS_PORTS = new Set([443, 8443, 2053, 2083, 2087, 2096]);

/**
 * @param {object} o
 * @param {string} o.uuid
 * @param {string} o.host      SNI / Host header (your worker subdomain)
 * @param {string} o.address   what actually goes in the connection field — a
 *                             Cloudflare clean IP when one is configured
 * @param {number} o.port
 * @param {string} [o.path]    WS path, defaults to `/{uuid}`
 * @param {object} [o.opts]    fragment / fingerprint / mux extras
 */
export function vlessUri({ uuid, host, address, port, path, opts = {} }) {
  const q = new URLSearchParams({
    encryption: "none",
    security: TLS_PORTS.has(Number(port)) ? "tls" : "",
    type: "ws",
    host,
    sni: host,
    alpn: "http/1.1",
    path: path || `/${uuid}`,
  });
  if (opts.fingerprint) q.set("fp", opts.fingerprint);
  if (opts.mux) { q.set("mux", String(opts.mux)); q.set("xmux", "maxStreams=8"); }
  if (opts.pbk) {
    q.set("pbk", opts.pbk);
    q.set("sid", opts.sid || "");
    q.set("spx", opts.spx || "/");
    q.set("security", "reality");
  }
  // v2rayNG / Happ fragment syntax. Order matters for some clients.
  if (opts.fragment) {
    q.set("fragment", opts.fragment.size || "100-200");
    q.set("fragmentPackets", opts.fragment.packets || "tlshello");
    if (opts.fragment.interval) q.set("fragmentInterval", opts.fragment.interval);
  }
  // PattN / PattNG extra fields.
  if (opts.fm) q.set("fm", opts.fm);
  if (opts.cs) q.set("cs", opts.cs);
  if (opts.mask) { q.set("mask", opts.mask.host || host); q.set("maskSni", opts.mask.sni || host); }

  const addr = address || host;
  return `vless://${uuid}@${addr}:${port}?${q.toString()}#${encodeURIComponent(opts.remark || host)}`;
}

export function trojanUri({ password, host, address, port, path, opts = {} }) {
  const q = new URLSearchParams({
    security: TLS_PORTS.has(Number(port)) ? "tls" : "",
    type: "ws",
    host,
    sni: host,
    alpn: "http/1.1",
    path: path || `/${password}`,
  });
  if (opts.fingerprint) q.set("fp", opts.fingerprint);
  return `trojan://${password}@${address || host}:${port}?${q.toString()}#${encodeURIComponent(opts.remark || host)}`;
}

/** sing-box JSON — what Hiddify/Streisand/v2Box actually import. */
export function singBoxConfig(items, { remoteDns = "https://8.8.8.8/dns-query", directDns = "https://cloudflare-dns.com/dns-query" } = {}) {
  const outbounds = items.map((it, i) => ({
    type: "vless",
    tag: it.remark || `node-${i}`,
    server: it.address || it.host,
    server_port: Number(it.port),
    uuid: it.uuid,
    tls: {
      enabled: true,
      server_name: it.host,
      utls: it.fingerprint ? { enabled: true, fingerprint: it.fingerprint } : undefined,
      insecure: false,
    },
    transport: {
      type: "ws",
      path: it.path || `/${it.uuid}`,
      headers: { Host: it.host },
      max_early_data: 2048,
      early_data_header_name: "Sec-WebSocket-Protocol",
    },
    multiplex: it.mux ? { enabled: true, max_streams: 8 } : undefined,
  }));

  return {
    log: { level: "warn", timestamp: true },
    dns: {
      servers: [
        { tag: "remote", address: remoteDns, detour: "select" },
        { tag: "direct", address: directDns, detour: "direct" },
        { tag: "block", address: "rcode://success" },
      ],
      rules: [{ outbound: "any", server: "direct" }],
      final: "remote",
    },
    inbounds: [
      { type: "tun", tag: "tun-in", inet4_address: "172.19.0.1/30", auto_route: true, strict_route: true, stack: "system" },
    ],
    outbounds: [
      { type: "selector", tag: "select", outbounds: ["auto", ...outbounds.map((o) => o.tag)] },
      { type: "urltest", tag: "auto", outbounds: outbounds.map((o) => o.tag), url: "https://cp.cloudflare.com", interval: "3m" },
      { type: "direct", tag: "direct" },
      { type: "block", tag: "block" },
      { type: "dns", tag: "dns-out" },
      ...outbounds,
    ],
    route: {
      rules: [
        { protocol: "dns", outbound: "dns-out" },
        { ip_is_private: true, outbound: "direct" },
        { domain_suffix: [".ir", ".melli"], outbound: "direct" },
      ],
      final: "select",
      auto_detect_interface: true,
    },
  };
}

/** Clash / Clash.Meta YAML. Hand-rolled so we ship zero dependencies. */
export function clashYaml(items) {
  const esc = (s) => `"${String(s).replaceAll('"', '\\"')}"`;
  const proxies = items.map((it) => ({
    name: it.remark || `${it.host}-${it.port}`,
    type: "vless",
    server: it.address || it.host,
    port: Number(it.port),
    uuid: it.uuid,
    tls: true,
    servername: it.host,
    "client-fingerprint": it.fingerprint || "chrome",
    network: "ws",
    "ws-opts": { path: it.path || `/${it.uuid}`, headers: { Host: it.host }, "max-early-data": 2048, "early-data-header-name": "Sec-WebSocket-Protocol" },
  }));
  const lines = [];
  lines.push("mixed-port: 7890");
  lines.push("allow-lan: false");
  lines.push("mode: rule");
  lines.push("log-level: warning");
  lines.push("proxies:");
  for (const p of proxies) {
    lines.push(`  - name: ${esc(p.name)}`);
    lines.push(`    type: ${p.type}`);
    lines.push(`    server: ${esc(p.server)}`);
    lines.push(`    port: ${p.port}`);
    lines.push(`    uuid: ${esc(p.uuid)}`);
    lines.push(`    tls: true`);
    lines.push(`    servername: ${esc(p.servername)}`);
    lines.push(`    client-fingerprint: ${esc(p["client-fingerprint"])}`);
    lines.push(`    network: ws`);
    lines.push(`    ws-opts:`);
    lines.push(`      path: ${esc(p["ws-opts"].path)}`);
    lines.push(`      max-early-data: 2048`);
    lines.push(`      early-data-header-name: Sec-WebSocket-Protocol`);
    lines.push(`      headers:`);
    lines.push(`        Host: ${esc(p["ws-opts"].headers.Host)}`);
  }
  lines.push("proxy-groups:");
  lines.push(`  - name: "SELECT"`);
  lines.push(`    type: select`);
  lines.push(`    proxies:`);
  for (const p of proxies) lines.push(`      - ${esc(p.name)}`);
  lines.push("rules:");
  lines.push(`  - DOMAIN-SUFFIX,ir,DIRECT`);
  lines.push(`  - GEOIP,IR,DIRECT`);
  lines.push(`  - MATCH,SELECT`);
  return lines.join("\n");
}

/** The `/sub/<token>` body every Iranian client understands. */
export function base64Subscription(uris) {
  return btoa(unescape(encodeURIComponent(uris.join("\n"))));
}

export function subscriptionInfoHeader({ used, total, expireAt }) {
  const parts = [`upload=0`, `download=${used}`, `total=${total}`];
  if (expireAt) parts.push(`expire=${Math.floor(expireAt / 1000)}`);
  return parts.join(";");
}
