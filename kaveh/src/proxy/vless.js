/**
 * VLESS over WebSocket — the actual proxy core.
 *
 * Protocol notes (VLESS v0):
 *   byte 0        version (0)
 *   bytes 1-16    UUID (raw, not the dashed string)
 *   byte 17       addon length, followed by that many addon bytes
 *   next byte     command: 0x01 TCP, 0x02 UDP
 *   next 2 bytes  destination port, big-endian
 *   next byte     address type: 0x01 IPv4, 0x02 domain, 0x03 IPv6
 *   then          address (4 / 1+len / 16 bytes)
 *   remainder     first payload bytes
 * Response: version byte (0x00) then raw bytes.
 */
import { tunnel } from "./tunnel.js";
import { resolveOne, isIpv4, isIpv6 } from "../net/dns.js";
import { getUserByUuid, hydrate } from "../db/users.js";
import { tooMany, forbidden } from "../core/errors.js";
import { doStub } from "../core/env.js";
import { connectViaProxy } from "./upstream.js";

/**
 * `cloudflare:sockets` only exists on the Workers runtime. Importing it lazily
 * keeps every pure function in this file (header parsing, UUID conversion,
 * admission control) unit-testable in plain Node — `npm test` needs no
 * miniflare, no network, and no Cloudflare account.
 */
let _connect = null;
async function connect(opts) {
  if (!_connect) ({ connect: _connect } = await import("cloudflare:sockets"));
  return _connect(opts);
}

const decoder = new TextDecoder();

export function uuidToBytes(uuid) {
  const hex = String(uuid).replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToUuid(bytes) {
  const h = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Pure function — unit-tested in test/vless.test.js without touching Workers. */
export function parseVlessHeader(buf) {
  if (buf.byteLength < 18) throw new Error("vless header too short");
  const version = buf[0];
  if (version !== 0) throw new Error(`unsupported vless version ${version}`);
  const uuid = bytesToUuid(buf.slice(1, 17));
  let offset = 17;
  const addonLen = buf[offset++];
  if (addonLen) offset += addonLen;
  const cmd = buf[offset++];
  const port = (buf[offset] << 8) | buf[offset + 1];
  offset += 2;
  const atyp = buf[offset++];
  let address;
  if (atyp === 1) {
    address = buf.slice(offset, offset + 4).join(".");
    offset += 4;
  } else if (atyp === 2) {
    const len = buf[offset++];
    address = decoder.decode(buf.slice(offset, offset + len));
    offset += len;
  } else if (atyp === 3) {
    const hex = [...buf.slice(offset, offset + 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
    address = hex.replace(/(.{4})(?=.)/g, "$1:");
    offset += 16;
  } else {
    throw new Error(`unknown address type ${atyp}`);
  }
  return {
    version,
    uuid,
    cmd,
    isUDP: cmd === 2,
    port,
    addressType: atyp,
    address,
    payloadStart: offset,
  };
}

export function buildVlessHeader({ uuid, cmd = 1, port, address }) {
  const uuidBytes = uuidToBytes(uuid);
  const parts = [new Uint8Array([0]), uuidBytes, new Uint8Array([0])]; // version, uuid, no addons
  const portBytes = new Uint8Array([(port >> 8) & 0xff, port & 0xff]);
  parts.push(new Uint8Array([cmd]), portBytes);
  if (isIpv4(address)) {
    parts.push(new Uint8Array([1]), new Uint8Array(address.split(".").map(Number)));
  } else if (isIpv6(address)) {
    const bytes = new Uint8Array(16);
    address.split(":").forEach((g, i) => {
      const n = parseInt(g || "0", 16);
      bytes[i * 2] = (n >> 8) & 0xff;
      bytes[i * 2 + 1] = n & 0xff;
    });
    parts.push(new Uint8Array([3]), bytes);
  } else {
    const dom = new TextEncoder().encode(address);
    parts.push(new Uint8Array([2]), new Uint8Array([dom.length]), dom);
  }
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

/** Extract a UUID from the WS path: `/uuid`, `/uuid?ed=2048`, or base64 in path. */
export function uuidFromRequest(request, url) {
  const seg = url.pathname.split("/").filter(Boolean)[0] || "";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return seg.toLowerCase();
  try {
    const dec = atob(seg.replace(/-/g, "+").replace(/_/g, "/"));
    if (/^[0-9a-f-]{36}$/i.test(dec)) return dec.toLowerCase();
  } catch {}
  return null;
}

/**
 * Admission control — the piece Zeus does *after* the tunnel is open, so an
 * expired user still gets a connection until the next quota write lands.
 */
export function admit(user, E) {
  if (!user) throw forbidden("uuid ناشناخته");
  if (!user.is_active) throw forbidden("کاربر غیرفعال است");
  if (user.expires_at && user.expires_at < Date.now()) throw forbidden("اشتراک منقضی شده");
  if (user.used_bytes >= user.quota_bytes) throw forbidden("حجم تمام شده");
  if (user.request_limit && user.requests_used >= user.request_limit) throw forbidden("سقف درخواست پر شده");
  return user;
}

export async function handleVlessWebSocket(request, E, ctx) {
  if ((request.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426, headers: { upgrade: "websocket" } });
  }
  const url = new URL(request.url);
  const uuid = uuidFromRequest(request, url);
  if (!uuid) return new Response("Bad Request", { status: 400 });

  const user = await getUserByUuid(E, uuid);
  if (!user) return new Response("Forbidden", { status: 403 });

  const pair = new WebSocketPair();
  const [client, ws] = Object.values(pair);

  // Device-limit check happens before we accept, using the global Ledger DO.
  const deviceHash = await sha8(`${uuid}|${request.headers.get("cf-connecting-ip")}|${request.headers.get("user-agent")}`);
  const ledger = doStub(E.ledger, "ledger");
  if (ledger && user.device_limit) {
    try {
      const res = await ledger.fetch(`https://ledger/admit?u=${encodeURIComponent(user.username)}&d=${deviceHash}&limit=${user.device_limit}`);
      const j = await res.json();
      if (!j.ok) {
        E.log?.warn("device_limit_reached", { user: user.username, devices: j.devices, limit: j.limit });
        return new Response("Too Many Devices", { status: 429 });
      }
    } catch (e) {
      // Fail open on DO errors: a limiter outage must not take down the proxy.
      E.log?.error("ledger_admit_failed", { e: String(e?.message || e) });
    }
  }

  try {
    ws.binaryType = "arraybuffer"; // not honoured on every runtime; toBytes() is the guarantee
  } catch {}
  ws.accept();
  E.log?.info("tunnel_open", { user: user.username, ip: request.headers.get("cf-connecting-ip") });

  let remoteSocket = null;
  let udpWriter = null;
  let opening = null;          // in-flight openTunnel promise
  const pendingChunks = [];    // bytes that arrived while the tunnel was opening
  let finished = false;
  const startedAt = Date.now();
  let up = 0;
  let down = 0;

  const report = (u, d) => {
    up += u;
    down += d;
  };

  // Early data (0-RTT) is delivered in this header by some clients.
  const earlyData = request.headers.get("sec-websocket-protocol");
  const firstChunk = earlyData ? safeB64ToBytes(earlyData) : null;

  const stream = makeReadableWebSocketStream(ws, firstChunk);

  stream
    .pipeTo(
      new WritableStream({
        async write(chunk, controller) {
          try {
            if (udpWriter) return await udpWriter(chunk);
            if (remoteSocket) return await writeToUpstream(chunk);

            // RACE GUARD. openTunnel() awaits DNS + connect(), which takes tens
            // of milliseconds. A client that sends its header and its first
            // payload in separate frames would otherwise have the *payload*
            // parsed as a second VLESS header — "vless header too short" — and
            // the tunnel dies before it ever opens. Only the first chunk is a
            // header; everything else queues until the socket exists.
            if (!opening) {
              opening = openTunnel(chunk, controller);
              await opening;
              return;
            }
            pendingChunks.push(chunk);
          } catch (e) {
            E.log?.error("tunnel_write_error", {
              user: user.username,
              e: String(e?.message || e),
              bytes: chunk?.byteLength ?? 0,
              head: [...new Uint8Array(chunk || []).slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join(" "),
            });
            finish();
            controller.error(e);
          }
        },
        close() { finish(); },
        abort() { finish(); },
      }),
    )
    .catch(() => finish());

  async function writeToUpstream(chunk) {
    const w = remoteSocket.writable.getWriter();
    try {
      await w.write(chunk);
      report(chunk.byteLength, 0);
    } finally {
      w.releaseLock();
    }
  }

  function finish() {
    // Idempotent: the error path, the close path and the abort path can all
    // reach it, and double-closing a WebSocket throws inside waitUntil, which
    // is how a Worker ends up with a "runtime canceled this request" exception.
    if (finished) return;
    finished = true;
    const duration = Date.now() - startedAt;
    try { ws.close(1000, ""); } catch {}
    try { remoteSocket?.close(); } catch {}
    // Report to the ledger exactly once per tunnel.
    if (ledger && (up || down)) {
      ctx.waitUntil(
        ledger.fetch(`https://ledger/report?u=${encodeURIComponent(user.username)}&up=${up}&down=${down}&d=${deviceHash}`).catch(() => {}),
      );
    }
    E.log?.info("tunnel_close", { user: user.username, up, down, ms: duration });
  }

  async function openTunnel(chunk, controller) {
    const buf = new Uint8Array(chunk);
    const header = parseVlessHeader(buf);
    if (header.uuid !== user.uuid) throw forbidden("uuid mismatch");
    const payload = buf.slice(header.payloadStart);

    // Per-user domain block list, enforced at the moment of connection.
    const blocked = user.block_list || [];
    if (blocked.length && matchesBlock(header.address, blocked)) {
      throw forbidden("مقصد توسط مدیر مسدود شده است");
    }

    if (header.isUDP) {
      udpWriter = createUdpForwarder(ws, header);
      if (payload.byteLength) await udpWriter(payload);
      return;
    }

    let host = header.address;
    if (!isIpv4(host) && !isIpv6(host)) {
      host = await resolveOne(host, { resolver: E.config.dohResolver });
    }

    // Optional upstream relay (SOCKS5/HTTP) for a user's own clean IP.
    const proxy = pickProxy(user);
    remoteSocket = proxy
      ? await connectViaProxy(proxy, host, header.port)
      : await connect({ hostname: host, port: header.port });

    // Bounded connect. `await socket.opened` with no timeout is how a proxy
    // ends up holding dead WebSockets: the client waits, the isolate pays, and
    // nothing is ever logged.
    const timeoutMs = Number(E.config.connectTimeoutMs || 8000);
    try {
      await Promise.race([
        remoteSocket.opened,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`upstream connect timeout after ${timeoutMs}ms`)), timeoutMs)),
      ]);
    } catch (e) {
      E.log?.warn("upstream_connect_failed", { user: user.username, host, port: header.port, ms: timeoutMs, e: String(e?.message || e) });
      try { remoteSocket.close(); } catch {}
      // The cause goes back to the client in the close reason. A WS close code
      // alone ("upstream unreachable") cannot distinguish DNS failure, a refused
      // port, a blocked destination and a timeout — and in production you often
      // cannot read Workers Logs. 123 bytes is the protocol limit for a reason
      // string, so it is clamped.
      const why = String(e?.message || e).replace(/\s+/g, " ").slice(0, 95);
      try { ws.close(1011, `upstream unreachable: ${why}`.slice(0, 120)); } catch {}
      throw e;
    }

    // VLESS response header: version byte only (no addons).
    ws.send(new Uint8Array([header.version]));

    if (payload.byteLength) await writeToUpstream(payload);
    // Anything that arrived while DNS/connect were in flight goes out now, in
    // order, before we start pumping the downstream direction.
    while (pendingChunks.length) await writeToUpstream(pendingChunks.shift());

    ctx.waitUntil(
      (async () => {
        const reader = remoteSocket.readable.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            down += value.byteLength;
            if (ws.readyState === WebSocket.OPEN) ws.send(value);
          }
        } catch {}
        finally {
          reader.releaseLock();
          finish();
        }
      })(),
    );
  }

  return new Response(null, { status: 101, webSocket: client });
}

/**
 * Normalise a WebSocket message into bytes.
 *
 * workerd follows the browser WebSocket API: unless `binaryType` is set to
 * "arraybuffer", a binary frame is delivered as a **Blob**, and
 * `new Uint8Array(blob)` / `String(blob)` silently produce the 13 bytes
 * "[object Blob]" — which then fails the VLESS header parse and kills every
 * single connection. Reading it through `new Response(data).arrayBuffer()`
 * works for Blob, ArrayBuffer and typed-array views alike.
 */
export async function toBytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === "string") return new TextEncoder().encode(data);
  return new Uint8Array(await new Response(data).arrayBuffer());
}

function makeReadableWebSocketStream(ws, firstChunk) {
  let closed = false;
  return new ReadableStream({
    start(controller) {
      ws.addEventListener("message", (event) => {
        toBytes(event.data)
          .then((data) => { if (!closed) controller.enqueue(data); })
          .catch((e) => { if (!closed) controller.error(e); });
      });
      ws.addEventListener("close", () => {
        if (!closed) { closed = true; controller.close(); }
      });
      ws.addEventListener("error", () => {
        if (!closed) { closed = true; controller.error(new Error("ws error")); }
      });
      if (firstChunk) controller.enqueue(firstChunk);
    },
    cancel() { closed = true; },
  });
}

function safeB64ToBytes(s) {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function matchesBlock(address, list) {
  const a = String(address).toLowerCase();
  return list.some((p) => {
    const d = String(p).toLowerCase().replace(/^\*\./, "");
    return a === d || a.endsWith(`.${d}`);
  });
}

function pickProxy(user) {
  const list = user.proxies || [];
  if (!list.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}

async function sha8(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export { matchesBlock as _matchesBlock, safeB64ToBytes as _safeB64ToBytes };
