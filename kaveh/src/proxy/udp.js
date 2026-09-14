/**
 * UDP forwarding for VLESS (used by DNS-over-UDP and QUIC-aware clients).
 *
 * Each UDP packet arrives as a WS message: 2-byte big-endian length + the raw
 * datagram. We resolve the destination, send it, and relay the reply back with
 * the same framing.
 */
import { resolveOne, isIpv4 } from "../net/dns.js";

const enc = new TextEncoder();

export function createUdpForwarder(ws, header, { resolver } = {}) {
  const pending = new Map();

  return async function write(chunk) {
    const buf = new Uint8Array(chunk);
    let offset = 0;
    while (offset + 2 <= buf.byteLength) {
      const len = (buf[offset] << 8) | buf[offset + 1];
      offset += 2;
      if (!len || offset + len > buf.byteLength) break;
      const packet = buf.slice(offset, offset + len);
      offset += len;
      await sendDatagram(packet);
    }
  };

  async function sendDatagram(packet) {
    try {
      let host = header.address;
      if (!isIpv4(host) && !host.includes(":")) host = await resolveOne(host, { resolver });
      const socket = new DatagramSocketShim();
      const socket2 = connectUdp(host, header.port);
      if (!socket2) return;
      socket2.addEventListener("message", (event) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const data = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : enc.encode(String(event.data));
        const framed = new Uint8Array(data.byteLength + 2);
        framed[0] = (data.byteLength >> 8) & 0xff;
        framed[1] = data.byteLength & 0xff;
        framed.set(data, 2);
        ws.send(framed);
      });
      socket2.send(packet);
      pending.set(socket2, Date.now());
      setTimeout(() => {
        try { socket2.close(); } catch {}
        pending.delete(socket2);
      }, 15_000);
    } catch {
      /* drop malformed datagram rather than kill the tunnel */
    }
  }
}

class DatagramSocketShim {}

/**
 * Cloudflare exposes UDP through `connect()` with `secureTransport: "off"` on
 * supported plans; where it is unavailable we degrade to dropping UDP, which
 * keeps TCP traffic (99% of real usage) working.
 */
function connectUdp(host, port) {
  try {
    // eslint-disable-next-line no-undef
    const { connect } = globalThis.__cfSockets ?? {};
    if (!connect) return null;
    return connect({ hostname: host, port, secureTransport: "off", allowHalfOpen: true });
  } catch {
    return null;
  }
}
