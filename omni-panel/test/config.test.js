import { test } from "node:test";
import assert from "node:assert/strict";
import { vlessUri, singBoxConfig, clashYaml, base64Subscription, subscriptionInfoHeader } from "../src/config/generator.js";
import { preset, presetList, PRESETS } from "../src/config/fragment.js";
import { pickCleanIps } from "../src/config/cleanip.js";
import { parseProxy, isExampleUpstream } from "../src/proxy/upstream.js";

const base = { uuid: "8f7e6d5c-4b3a-4918-8776-655443322110", host: "panel.workers.dev", address: "104.16.0.0", port: 443 };

test("vless uri carries every field a client needs", () => {
  const uri = vlessUri({ ...base, opts: { fingerprint: "chrome", fragment: preset("mci") } });
  assert.match(uri, /^vless:\/\/8f7e6d5c-4b3a-4918-8776-655443322110@104\.16\.0\.0:443\?/);
  const q = new URL(uri).searchParams;
  assert.equal(q.get("security"), "tls");
  assert.equal(q.get("sni"), "panel.workers.dev");
  assert.equal(q.get("host"), "panel.workers.dev");
  assert.equal(q.get("type"), "ws");
  assert.equal(q.get("path"), `/${base.uuid}`);
  assert.equal(q.get("fp"), "chrome");
  assert.equal(q.get("fragment"), "100-200");
  assert.equal(q.get("fragmentPackets"), "tlshello");
});

test("plain ws port drops the tls security flag", () => {
  const q = new URL(vlessUri({ ...base, port: 80 })).searchParams;
  assert.equal(q.get("security"), "");
});

test("sing-box output is importable JSON with the right shape", () => {
  const cfg = singBoxConfig([{ ...base, fingerprint: "safari", remark: "node" }]);
  const vless = cfg.outbounds.find((o) => o.type === "vless");
  assert.equal(vless.server, base.address);
  assert.equal(vless.server_port, 443);
  assert.equal(vless.tls.server_name, base.host);
  assert.equal(vless.tls.utls.fingerprint, "safari");
  assert.equal(vless.transport.type, "ws");
  assert.ok(cfg.outbounds.some((o) => o.type === "selector"));
  assert.ok(cfg.route.rules.some((r) => r.domain_suffix?.includes(".ir")));
  assert.equal(JSON.parse(JSON.stringify(cfg)).outbounds.length, cfg.outbounds.length);
});

test("clash yaml is line-structured and names every proxy", () => {
  const y = clashYaml([{ ...base, remark: "kaveh#1" }]);
  assert.match(y, /^mixed-port: 7890/m);
  assert.match(y, /- name: "kaveh#1"/);
  assert.match(y, /client-fingerprint: "chrome"/);
  assert.match(y, /- MATCH,SELECT$/m);
});

test("base64 subscription decodes back to the exact uri list", () => {
  const uris = [vlessUri(base), vlessUri({ ...base, address: "172.66.0.0" })];
  const b64 = base64Subscription(uris);
  assert.equal(Buffer.from(b64, "base64").toString("utf8"), uris.join("\n"));
});

test("subscription-userinfo header is what clients parse", () => {
  const h = subscriptionInfoHeader({ used: 1024, total: 2048, expireAt: 1800000000000 });
  assert.equal(h, "upload=0;download=1024;total=2048;expire=1800000000");
});

test("every ISP preset resolves and 'none' resolves to null", () => {
  assert.equal(preset("none"), null);
  for (const [id, def] of Object.entries(PRESETS)) {
    const p = preset(id);
    // Presets with no fragmentation (none, gaming) must resolve to null so the
    // generator omits the fragment params entirely.
    if (!def.size) assert.equal(p, null, `${id} should disable fragmentation`);
    else assert.ok(p.size && p.packets, `${id} must define size+packets`);
  }
  assert.ok(presetList().length >= 5);
});

test("clean-ip picker never returns duplicates and survives an empty pool", () => {
  const pool = ["1.1.1.1", "2.2.2.2", "3.3.3.3"];
  const picks = pickCleanIps(pool, 3, 12345);
  assert.equal(new Set(picks).size, 3);
  assert.ok(pickCleanIps([], 2).length === 2, "falls back to the built-in pool");
});

test("proxy spec parser handles every documented form", () => {
  assert.deepEqual(parseProxy("1.2.3.4:1080"), { proto: "socks5", user: null, pass: "", host: "1.2.3.4", port: 1080 });
  assert.deepEqual(parseProxy("u:p@1.2.3.4:1080"), { proto: "socks5", user: "u", pass: "p", host: "1.2.3.4", port: 1080 });
  assert.deepEqual(parseProxy("http://u:p@proxy.example:8080"), { proto: "http", user: "u", pass: "p", host: "proxy.example", port: 8080 });
  assert.equal(parseProxy("not a proxy at all"), null);
});

test("documentation/example upstreams are rejected before they can poison a user", () => {
  // The form placeholder (user:pass@1.2.3.4:1080) was once saved as a live
  // upstream: tunnel opened, upstream silent, every client showed red -1 ms.
  assert.ok(isExampleUpstream("user:pass@1.2.3.4:1080"));
  assert.ok(isExampleUpstream("socks5://u:p@example.com:1080"));
  assert.ok(isExampleUpstream("192.0.2.10:1080"), "TEST-NET-1");
  assert.ok(isExampleUpstream("198.51.100.7:1080"), "TEST-NET-2");
  assert.ok(isExampleUpstream("203.0.113.9:1080"), "TEST-NET-3");
  assert.ok(isExampleUpstream("localhost:1080"));
  assert.ok(isExampleUpstream("127.0.0.1:1080"));
  assert.ok(isExampleUpstream("not a proxy at all"), "unparseable must fail loud, not silent");
  assert.equal(isExampleUpstream("u:p@45.15.200.7:443"), false);
  assert.equal(isExampleUpstream("socks5://real.example.net:1080"), false);
});
