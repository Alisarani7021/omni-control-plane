import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVlessHeader, buildVlessHeader, uuidToBytes, bytesToUuid, uuidFromRequest, _matchesBlock } from "../src/proxy/vless.js";

const UUID = "8f7e6d5c-4b3a-4918-8776-655443322110";

test("uuid round-trips through bytes", () => {
  assert.equal(bytesToUuid(uuidToBytes(UUID)), UUID);
  assert.equal(uuidToBytes(UUID).length, 16);
});

test("parses a TCP IPv4 header and keeps the payload intact", () => {
  const payload = new Uint8Array([0x16, 0x03, 0x01, 0xaa, 0xbb]);
  const head = buildVlessHeader({ uuid: UUID, cmd: 1, port: 443, address: "1.1.1.1" });
  const buf = new Uint8Array(head.byteLength + payload.byteLength);
  buf.set(head, 0);
  buf.set(payload, head.byteLength);

  const p = parseVlessHeader(buf);
  assert.equal(p.version, 0);
  assert.equal(p.uuid, UUID);
  assert.equal(p.isUDP, false);
  assert.equal(p.port, 443);
  assert.equal(p.address, "1.1.1.1");
  assert.deepEqual([...buf.slice(p.payloadStart)], [...payload]);
});

test("parses a domain address", () => {
  const head = buildVlessHeader({ uuid: UUID, cmd: 1, port: 8443, address: "api.openai.com" });
  const p = parseVlessHeader(head);
  assert.equal(p.addressType, 2);
  assert.equal(p.address, "api.openai.com");
  assert.equal(p.port, 8443);
  assert.equal(p.payloadStart, head.byteLength);
});

test("parses an IPv6 address", () => {
  const head = buildVlessHeader({ uuid: UUID, cmd: 1, port: 443, address: "2606:4700:4700:0000:0000:0000:0000:1111" });
  const p = parseVlessHeader(head);
  assert.equal(p.addressType, 3);
  assert.equal(p.address.replaceAll(":", "").length, 32);
});

test("marks UDP commands", () => {
  const p = parseVlessHeader(buildVlessHeader({ uuid: UUID, cmd: 2, port: 53, address: "8.8.8.8" }));
  assert.equal(p.isUDP, true);
  assert.equal(p.port, 53);
});

test("rejects a truncated header instead of tunneling garbage", () => {
  assert.throws(() => parseVlessHeader(new Uint8Array(10)), /too short/);
  assert.throws(() => parseVlessHeader(new Uint8Array([1, ...new Array(40).fill(0)])), /unsupported vless version/);
});

test("extracts uuid from ws paths and base64 paths", () => {
  assert.equal(uuidFromRequest(null, new URL(`https://x.dev/${UUID}`)), UUID);
  assert.equal(uuidFromRequest(null, new URL(`https://x.dev/${UUID}?ed=2048`)), UUID);
  const b64 = Buffer.from(UUID).toString("base64url");
  assert.equal(uuidFromRequest(null, new URL(`https://x.dev/${b64}`)), UUID);
  assert.equal(uuidFromRequest(null, new URL("https://x.dev/not-a-uuid")), null);
});

test("block list matches exact domains and subdomains only", () => {
  assert.equal(_matchesBlock("ads.example.com", ["example.com"]), true);
  assert.equal(_matchesBlock("example.com", ["*.example.com"]), true);
  assert.equal(_matchesBlock("notexample.com", ["example.com"]), false);
  assert.equal(_matchesBlock("api.openai.com", ["gemini.google.com"]), false);
});

/* ── regression: workerd delivers binary WS frames as Blob, not ArrayBuffer ── */
test("toBytes normalises ArrayBuffer, typed views, strings and Blob-like bodies", async () => {
  const { toBytes } = await import("../src/proxy/vless.js");
  const raw = new Uint8Array([0x00, 0x11, 0x22, 0xff]);

  assert.deepEqual(await toBytes(raw.buffer), raw, "ArrayBuffer");
  assert.deepEqual(await toBytes(raw), raw, "Uint8Array view");
  assert.deepEqual(await toBytes(new Uint16Array([0x1100, 0xff22]).buffer), new Uint8Array([0x00, 0x11, 0x22, 0xff]), "wide view");
  assert.deepEqual(await toBytes("abc"), new Uint8Array([97, 98, 99]), "string");

  // A Blob is what workerd actually hands us for a binary frame.
  const blob = new Blob([raw]);
  assert.equal(String(blob), "[object Blob]", "sanity: naive String() would corrupt the header");
  assert.deepEqual(await toBytes(blob), raw, "Blob must decode to the original bytes");
});

test("a full 131-byte frame survives the Blob path and parses as a header", async () => {
  const { toBytes } = await import("../src/proxy/vless.js");
  const head = buildVlessHeader({ uuid: UUID, cmd: 1, port: 80, address: "cp.cloudflare.com" });
  const payload = new TextEncoder().encode("GET / HTTP/1.1\r\nHost: cp.cloudflare.com\r\n\r\n");
  const frame = new Uint8Array(head.byteLength + payload.byteLength);
  frame.set(head, 0);
  frame.set(payload, head.byteLength);

  const received = await toBytes(new Blob([frame]));
  assert.equal(received.byteLength, frame.byteLength);
  const p = parseVlessHeader(received);
  assert.equal(p.address, "cp.cloudflare.com");
  assert.equal(p.port, 80);
  assert.equal(new TextDecoder().decode(received.slice(p.payloadStart)).startsWith("GET /"), true);
});
