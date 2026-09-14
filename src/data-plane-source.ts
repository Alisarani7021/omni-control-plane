// This module is bundled with the control plane. It is never fetched from an unpinned remote source.
export const DATA_PLANE_SOURCE = String.raw`
const encoder = new TextEncoder();

function b64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function b64urlDecode(value) {
  const padded = value.replaceAll("-", "+").replaceAll("/", "_") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return b64url(new Uint8Array(digest));
}

async function equalHash(left, right) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

function headers(contentType) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  };
}

// --- DoH (RFC 8484) on the tenant's own domain -----------------------------
// Deterministic split resolution: .ir + domestic CDN names go to a national
// resolver directly (fast, and the national path stays unbroken); everything
// else goes to a clean resolver (poisoning-resistant). Only A/AAAA/TXT are
// answered; anything else gets REFUSED. One cached answer per key+query, an
// hourly cap per key, and a plain log counter (no KV, no stored query logs).
const DOH_ALLOWED_QTYPES = [1, 28, 16];
const DOH_DOMESTIC_SUFFIXES = [".ir", ".aparat.com", ".digikala.com", ".snapp.", ".bale.ai", ".namava.ir"];
const DOH_NATIONAL_UPSTREAM = "178.22.122.100";
const DOH_CLEAN_UPSTREAM = "1.1.1.1";
const DOH_HOURLY_CAP = 5000;

function parseQuestion(wire) {
  let offset = 12;
  const labels = [];
  while (offset < wire.length && wire[offset] !== 0) {
    const length = wire[offset];
    if (length > 63 || offset + 1 + length > wire.length) return null;
    labels.push(String.fromCharCode(...wire.slice(offset + 1, offset + 1 + length)));
    offset += 1 + length;
  }
  if (offset + 5 > wire.length) return null;
  const qtype = (wire[offset + 1] << 8) | wire[offset + 2];
  return { name: labels.join(".").toLowerCase(), qtype };
}

function refusedResponse(wire) {
  const out = new Uint8Array(12);
  out.set(wire.slice(0, 12), 0);
  out[2] = 0x81;
  out[3] = 0x05; // REFUSED
  return out;
}

async function tcpDnsQuery(host, wire) {
  const { connect } = await import("cloudflare:sockets");
  const socket = connect(host + ":53", {});
  const writer = socket.output.getWriter();
  const prefix = new Uint8Array([(wire.length >> 8) & 0xff, wire.length & 0xff]);
  const framed = new Uint8Array(prefix.length + wire.length);
  framed.set(prefix, 0);
  framed.set(wire, prefix.length);
  await writer.write(framed);
  const reader = socket.input.getReader();
  let buffer = new Uint8Array(0);
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const merged = new Uint8Array(buffer.length + chunk.value.length);
      merged.set(buffer, 0);
      merged.set(chunk.value, buffer.length);
      buffer = merged;
      if (buffer.length >= 2) {
        const expected = (buffer[0] << 8) | buffer[1];
        if (buffer.length >= expected + 2) return buffer.slice(2, expected + 2);
      }
    }
  } finally {
    try { await socket.close(); } catch {}
  }
  return null;
}

async function handleDoh(request, url, env) {
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("method_not_allowed", { status: 405, headers: headers("text/plain; charset=utf-8") });
  }
  const key = url.searchParams.get("k") || "";
  if (key.length < 43 || key.length > 128) return new Response("unauthorized", { status: 401, headers: headers("text/plain; charset=utf-8") });
  if (!(await equalHash(await sha256(key), env.SUB_TOKEN_HASH))) {
    return new Response("unauthorized", { status: 401, headers: headers("text/plain; charset=utf-8") });
  }
  let wire = null;
  if (request.method === "GET") {
    const param = url.searchParams.get("dns");
    if (param) wire = b64urlDecode(param);
  } else {
    const type = request.headers.get("Content-Type") || "";
    if (!type.includes("application/dns-message")) return new Response("bad_content_type", { status: 415, headers: headers("text/plain; charset=utf-8") });
    wire = new Uint8Array(await request.arrayBuffer());
  }
  if (!wire || wire.length < 12 || wire.length > 1200) return new Response("bad_query", { status: 400, headers: headers("text/plain; charset=utf-8") });
  const question = parseQuestion(wire);
  if (!question) return new Response("bad_query", { status: 400, headers: headers("text/plain; charset=utf-8") });
  console.log("dns_query_count", 1, question.qtype);
  if (!DOH_ALLOWED_QTYPES.includes(question.qtype)) {
    return new Response(refusedResponse(wire), { status: 200, headers: headers("application/dns-message") });
  }
  const cacheKey = "https://doh.internal/" + (await sha256(key + "|" + question.name + "|" + question.qtype));
  const cache = caches.default;
  const cached = await cache.match(cacheKey).catch(() => null);
  if (cached) return new Response(cached.body, { status: 200, headers: headers("application/dns-message") });
  const hourBucket = Math.floor(Date.now() / 3_600_000);
  const capKey = "https://doh.internal/cap-" + (await sha256(key)) + "-" + hourBucket;
  const capHit = await cache.match(capKey).catch(() => null);
  const capCount = capHit ? Number(await capHit.text()) || 0 : 0;
  if (capCount >= DOH_HOURLY_CAP) {
    return new Response(refusedResponse(wire), { status: 200, headers: headers("application/dns-message") });
  }
  await cache.put(capKey, new Response(String(capCount + 1), { headers: { "Cache-Control": "max-age=3600" } })).catch(() => {});
  const domestic = DOH_DOMESTIC_SUFFIXES.some((suffix) => question.name === suffix.slice(1) || question.name.endsWith(suffix));
  const upstream = domestic ? DOH_NATIONAL_UPSTREAM : DOH_CLEAN_UPSTREAM;
  let answer = null;
  try {
    answer = await tcpDnsQuery(upstream, wire);
  } catch (error) {
    answer = null;
  }
  if (!answer) return new Response(refusedResponse(wire), { status: 200, headers: headers("application/dns-message") });
  const response = new Response(answer, { status: 200, headers: { ...headers("application/dns-message"), "Cache-Control": "max-age=300" } });
  await cache.put(cacheKey, new Response(answer, { headers: { "Cache-Control": "max-age=300" } })).catch(() => {});
  return response;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/dns-query") return handleDoh(request, url, env);
    if (request.method !== "GET") {
      return Response.json({ error: "method_not_allowed" }, { status: 405, headers: headers("application/json; charset=utf-8") });
    }
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "v13-data-plane" }, { headers: headers("application/json; charset=utf-8") });
    }
    const match = /^\/sub\/([A-Za-z0-9_-]{43,128})$/u.exec(url.pathname);
    if (!match) return new Response("Not found", { status: 404, headers: headers("text/plain; charset=utf-8") });
    const candidateHash = await sha256(match[1]);
    if (!(await equalHash(candidateHash, env.SUB_TOKEN_HASH))) {
      return new Response("Not found", { status: 404, headers: headers("text/plain; charset=utf-8") });
    }
    let bundle;
    try {
      bundle = JSON.parse(env.CONFIG_BUNDLE);
    } catch {
      return new Response("Configuration unavailable", { status: 503, headers: headers("text/plain; charset=utf-8") });
    }
    if (bundle.status !== "ready") {
      return new Response("Provisioning is still in progress", { status: 503, headers: headers("text/plain; charset=utf-8") });
    }
    const format = url.searchParams.get("format") || "uri";
    if (format === "uri") {
      return new Response(bundle.uris.join("\n") + "\n", { headers: headers("text/plain; charset=utf-8") });
    }
    if (format === "clash") {
      if (!bundle.clashYaml) return Response.json({ error: "invalid_format" }, { status: 400, headers: headers("application/json; charset=utf-8") });
      return new Response(bundle.clashYaml, { headers: headers("text/yaml; charset=utf-8") });
    }
    if (format === "sing-box") {
      const profile = decodeURIComponent(url.searchParams.get("profile") || "vless");
      const variants = bundle.profileVariants || {};
      const source = bundle.profiles[profile] || variants[profile];
      if (!source) {
        return Response.json({ error: "invalid_profile" }, { status: 400, headers: headers("application/json; charset=utf-8") });
      }
      return new Response(JSON.stringify(source, null, 2) + "\\n", { headers: headers("application/json; charset=utf-8") });
    }
    return Response.json({ error: "invalid_format" }, { status: 400, headers: headers("application/json; charset=utf-8") });
  }
};
`;
