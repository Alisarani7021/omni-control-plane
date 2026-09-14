#!/usr/bin/env node
/**
 * End-to-end tunnel probe against a running Worker.
 *
 *   node scripts/ws-probe.js ws://127.0.0.1:8787 <uuid> [targetHost] [targetPort]
 *
 * Builds a real VLESS request header with the *same* module the Worker uses to
 * parse it (src/proxy/vless.js), opens a WebSocket, sends an HTTP/1.1 GET, and
 * prints whatever comes back through the tunnel. If you see `HTTP/1.1`, the
 * whole path works: WS upgrade → admission control → header parse → connect()
 * → byte pump → Ledger report.
 */
import { buildVlessHeader } from "../src/proxy/vless.js";

const [wsBase = "ws://127.0.0.1:8787", uuid, host = "cp.cloudflare.com", port = "80"] = process.argv.slice(2);

const ws = new WebSocket(`${wsBase.replace(/^http/, "ws")}/${uuid}`);
ws.binaryType = "arraybuffer";

const timer = setTimeout(() => {
  console.error("✗ timeout — no response in 12s");
  process.exit(1);
}, 12_000);

let opened = false;
let bytes = 0;

ws.addEventListener("open", () => {
  const header = buildVlessHeader({ uuid, cmd: 1, port: Number(port), address: host });
  const req = new TextEncoder().encode(`GET / HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: kaveh-probe/1.0\r\nConnection: close\r\n\r\n`);
  const frame = new Uint8Array(header.byteLength + req.byteLength);
  frame.set(header, 0);
  frame.set(req, header.byteLength);
  console.log(`→ vless header ${header.byteLength}B (uuid ${uuid.slice(0, 8)}…, ${host}:${port}, TCP) + ${req.byteLength}B HTTP request`);
  ws.send(frame.buffer);
});

ws.addEventListener("message", (event) => {
  const buf = new Uint8Array(event.data);
  bytes += buf.byteLength;
  if (!opened) {
    opened = true;
    // First byte is the VLESS response header (version 0).
    console.log(`← response header: version ${buf[0]}`);
    const body = buf.slice(1);
    console.log(`← ${body.byteLength}B payload:\n${new TextDecoder().decode(body).split("\r\n").slice(0, 6).join("\n")}`);
  } else {
    console.log(`← +${buf.byteLength}B (total ${bytes}B)`);
  }
  if (/HTTP\/1\.[01] \d{3}/.test(new TextDecoder().decode(buf))) {
    clearTimeout(timer);
    console.log("\n✓ TUNNEL OK — bytes flowed client → Worker → origin → Worker → client");
    ws.close();
    process.exit(0);
  }
});

ws.addEventListener("error", (e) => {
  clearTimeout(timer);
  console.error(`✗ websocket error: ${e.message || e.error?.message || "unknown"}`);
  process.exit(1);
});

ws.addEventListener("close", (e) => {
  clearTimeout(timer);
  if (!opened) {
    console.error(`✗ closed before any data: code=${e.code} reason="${e.reason}"`);
    console.error("  403 = uuid ناشناخته / کاربر غیرفعال / منقضی / حجم تمام");
    console.error("  429 = سقف دستگاه همزمان پر شده (Ledger DO)");
    process.exit(1);
  }
});
