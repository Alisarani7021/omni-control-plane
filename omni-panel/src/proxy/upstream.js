/**
 * Per-connection upstream relays (SOCKS5 / SOCKS4 / HTTP CONNECT).
 *
 * Used when a user has their own clean VPS in front of Cloudflare, or when the
 * panel routes through a donated node. Kept as a separate module so it can be
 * unit-tested and swapped without touching the VLESS core.
 */
import { isIpv4 } from "../net/dns.js";

/** Lazily imported so this module is testable in plain Node. See src/proxy/vless.js. */
let _connect = null;
async function connect(opts) {
  if (!_connect) ({ connect: _connect } = await import("cloudflare:sockets"));
  return _connect(opts);
}

export function parseProxy(spec, defaultPort = 1080) {
  // host:port | user:pass@host:port | socks5://user:pass@host:port
  const m = /^(?:(?<proto>socks5|socks4|http):\/\/)?(?:(?<user>[^:@/]+):(?<pass>[^@/]*)@)?(?<host>[^:/]+)(?::(?<port>\d+))?$/i.exec(
    String(spec).trim(),
  );
  if (!m) return null;
  const host = m.groups.host;
  // Reject anything with whitespace or an implausible hostname — silently
  // "accepting" a malformed spec means the tunnel fails later, far from the
  // cause, which is exactly how Zeus's proxy tester confuses people.
  if (/\s/.test(host) || !/^[a-z0-9.-]+$/i.test(host) || host.length > 253) return null;
  const port = Number(m.groups.port || defaultPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    proto: (m.groups.proto || "socks5").toLowerCase(),
    user: m.groups.user || null,
    pass: m.groups.pass || "",
    host,
    port,
  };
}

/**
 * Placeholder / documentation addresses that can never be a real upstream.
 * The form's own example (`user:pass@1.2.3.4:1080`) got saved as a live value
 * once, and every connection then died at "upstream silent" — red -1 ms in
 * every client app, far from the cause. Reject them at the API boundary.
 */
const EXAMPLE_HOSTS = new Set([
  "1.2.3.4", "0.0.0.0", "127.0.0.1", "localhost",
  "example.com", "example.org", "example.net",
  "proxy.example.com", "your.proxy.com", "host",
]);
export function isExampleUpstream(spec) {
  const p = typeof spec === "string" ? parseProxy(spec) : spec;
  if (!p) return true; // unparseable specs fail later, far from the cause
  const h = String(p.host).toLowerCase();
  if (EXAMPLE_HOSTS.has(h)) return true;
  if (/^127\./.test(h)) return true;                     // loopback
  if (/^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(h)) return true; // TEST-NET 1-3
  return false;
}

export async function connectViaProxy(spec, destHost, destPort) {
  const p = typeof spec === "string" ? parseProxy(spec) : spec;
  if (!p) return connect({ hostname: destHost, port: destPort });
  if (p.proto === "http") return httpConnect(p, destHost, destPort);
  if (p.proto === "socks4") return socks4(p, destHost, destPort);
  return socks5(p, destHost, destPort);
}

async function open(p) {
  const socket = connect({ hostname: p.host, port: p.port });
  await socket.opened;
  return socket;
}

async function readExact(reader, n) {
  const out = new Uint8Array(n);
  let got = 0;
  while (got < n) {
    const { done, value } = await reader.read();
    if (done) throw new Error("proxy closed handshake early");
    const take = Math.min(value.byteLength, n - got);
    out.set(value.subarray(0, take), got);
    got += take;
    if (take < value.byteLength) throw new Error("proxy handshake frame overrun");
  }
  return out;
}

export async function socks5(p, destHost, destPort) {
  const socket = await open(p);
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();

  const auth = p.user ? [0x00, 0x02] : [0x00];
  await writer.write(new Uint8Array([0x05, auth.length, ...auth]));
  const ver = await readExact(reader, 2);
  if (ver[0] !== 0x05) throw new Error("not a socks5 proxy");

  if (ver[1] === 0x02 && p.user) {
    const u = new TextEncoder().encode(p.user);
    const pw = new TextEncoder().encode(p.pass);
    await writer.write(new Uint8Array([0x01, u.length, ...u, pw.length, ...pw]));
    const ok = await readExact(reader, 2);
    if (ok[1] !== 0x00) throw new Error("socks5 auth rejected");
  } else if (ver[1] === 0xff) {
    throw new Error("socks5 no acceptable auth");
  }

  const addr = encodeAddress(destHost, destPort);
  await writer.write(new Uint8Array([0x05, 0x01, 0x00, ...addr]));
  const head = await readExact(reader, 4);
  if (head[1] !== 0x00) throw new Error(`socks5 reply code ${head[1]}`);
  const skip = head[3] === 1 ? 4 : head[3] === 4 ? 16 : (await readExact(reader, 1))[0];
  await readExact(reader, skip + 2);

  writer.releaseLock();
  reader.releaseLock();
  return socket;
}

export async function socks4(p, destHost, destPort) {
  const socket = await open(p);
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const ip = isIpv4(destHost) ? destHost.split(".").map(Number) : [0, 0, 0, 1];
  const uid = new TextEncoder().encode(p.user || "");
  await writer.write(new Uint8Array([0x04, 0x01, (destPort >> 8) & 0xff, destPort & 0xff, ...ip, ...uid, 0x00]));
  const res = await readExact(reader, 8);
  if (res[1] !== 0x5a) throw new Error(`socks4 reply ${res[1]}`);
  writer.releaseLock();
  reader.releaseLock();
  return socket;
}

export async function httpConnect(p, destHost, destPort) {
  const socket = await open(p);
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const auth = p.user ? `Proxy-Authorization: Basic ${btoa(`${p.user}:${p.pass}`)}\r\n` : "";
  await writer.write(new TextEncoder().encode(`CONNECT ${destHost}:${destPort} HTTP/1.1\r\nHost: ${destHost}:${destPort}\r\n${auth}\r\n`));
  let buf = new Uint8Array(0);
  while (!new TextDecoder().decode(buf).includes("\r\n\r\n")) {
    const { done, value } = await reader.read();
    if (done) throw new Error("http proxy closed");
    const merged = new Uint8Array(buf.byteLength + value.byteLength);
    merged.set(buf, 0);
    merged.set(value, buf.byteLength);
    buf = merged;
  }
  const status = Number(new TextDecoder().decode(buf).split(" ")[1]);
  if (status !== 200) throw new Error(`http CONNECT failed: ${status}`);
  writer.releaseLock();
  reader.releaseLock();
  return socket;
}

function encodeAddress(host, port) {
  const portBytes = [(port >> 8) & 0xff, port & 0xff];
  if (isIpv4(host)) return [0x01, ...host.split(".").map(Number), ...portBytes];
  if (host.includes(":")) {
    const bytes = new Array(16).fill(0);
    host.split(":").forEach((g, i) => {
      const n = parseInt(g || "0", 16);
      bytes[i * 2] = (n >> 8) & 0xff;
      bytes[i * 2 + 1] = n & 0xff;
    });
    return [0x04, ...bytes, ...portBytes];
  }
  const dom = [...new TextEncoder().encode(host)];
  return [0x03, dom.length, ...dom, ...portBytes];
}

/** Health probe used by the auto-fallback logic and the nodes table. */
export async function probeProxy(spec, { target = "https://cp.cloudflare.com", timeoutMs = 6000 } = {}) {
  const started = Date.now();
  try {
    const socket = await connectViaProxy(spec, new URL(target).hostname, 443);
    socket.close();
    return { ok: true, latencyMs: Date.now() - started };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started, error: String(e?.message || e) };
  }
}
