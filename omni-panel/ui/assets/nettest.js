/**
 * nettest.js — a real VLESS client, in the panel, in the browser.
 *
 * v2rayNG's red "-1 ms" tells you *something* failed but not what. This opens
 * the actual tunnel from the panel itself: WebSocket → VLESS handshake → a real
 * HTTP request through the proxy → measure the round trip. Same-origin, so no
 * CORS, no extra permission, and it works from the phone that runs the panel.
 *
 * Protocol mirrors src/proxy/vless.js exactly:
 *   [0][uuid×16][addonLen=0][cmd=1 TCP][port BE][atyp][addr][payload…]
 *   server answers [0x00] then raw upstream bytes.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

function uuidBytes(uuid) {
  const hex = String(uuid).replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function header({ uuid, port, address }) {
  const dom = enc.encode(address);
  const parts = [
    new Uint8Array([0]),          // version
    uuidBytes(uuid),              // uuid
    new Uint8Array([0]),          // addon length
    new Uint8Array([1]),          // cmd: TCP
    new Uint8Array([(port >> 8) & 0xff, port & 0xff]),
    new Uint8Array([2]),          // atyp: domain
    new Uint8Array([dom.length]),
    dom,
  ];
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

/**
 * @returns {Promise<{ok:boolean, ms?:number, stage:"refused"|"noopen"|"nodata"|"ok", detail?:string}>}
 */
export function liveTest({ host, uuid, target = "httpbin.org", port = 80, timeoutMs = 9000 }) {
  return new Promise((resolve) => {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const url = `${scheme}://${host || location.host}/${uuid}`;
    let ws = null;
    let opened = 0;
    let done = false;
    let buf = "";
    let sawVersion = false;

    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws?.close(); } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => {
      finish(opened ? { ok: false, stage: "nodata" } : { ok: false, stage: "noopen" });
    }, timeoutMs);

    try {
      ws = new WebSocket(url);
    } catch {
      return finish({ ok: false, stage: "noopen" });
    }
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      opened = performance.now();
      const req = enc.encode(`GET /get HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`);
      const h = header({ uuid, port, address: target });
      const frame = new Uint8Array(h.byteLength + req.byteLength);
      frame.set(h, 0);
      frame.set(req, h.byteLength);
      ws.send(frame);
    };

    ws.onmessage = (e) => {
      const bytes = e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : enc.encode(String(e.data));
      let body = bytes;
      if (!sawVersion) { sawVersion = true; body = bytes.slice(1); }   // drop the 0x00 reply version
      buf += dec.decode(body, { stream: true });
      if (/HTTP\/1\.[01] \d{3}/.test(buf)) {
        finish({ ok: true, ms: Math.round(performance.now() - opened), stage: "ok" });
      }
    };

    ws.onclose = (e) => {
      if (done) return;
      // closed before any upstream byte: admission control rejected us, or the
      // tunnel died on connect. Distinguish by whether the WS ever opened.
      finish(opened
        ? { ok: false, stage: "nodata", detail: `close ${e.code}` }
        : { ok: false, stage: "refused", detail: `close ${e.code}` });
    };
    ws.onerror = () => { if (!done) finish(opened ? { ok: false, stage: "nodata" } : { ok: false, stage: "refused" }); };
  });
}
