import { describe, expect, it } from "vitest";
import {
  buildPhantomPack,
  normalizePackUuid,
  PACK_SIZE,
  PACK_WARNING,
  packLinkText,
  packToClashYaml,
  packToSingBox,
  packToSubscription,
  sanitizePackDomain,
} from "../src/phantom-pack";

const UUID = "11111111-2222-3333-4444-555555555555";

describe("phantom pack generator", () => {
  it("builds twenty distinct configs over the three families", () => {
    const pack = buildPhantomPack("example.com", UUID);
    expect(pack.entries).toHaveLength(PACK_SIZE);
    expect(pack.counts.vless + pack.counts.ss + pack.counts.hysteria2).toBe(PACK_SIZE);
    expect(new Set(pack.entries.map((entry) => entry.link)).size).toBe(PACK_SIZE);
    expect(pack.entries.every((entry) => entry.link.includes("example.com"))).toBe(true);
    expect(new Set(pack.entries.map((entry) => entry.port)).size).toBeGreaterThan(2);
  });

  it("is deterministic: same input, same pack", () => {
    const first = buildPhantomPack("example.com", UUID);
    const second = buildPhantomPack("https://EXAMPLE.com:443/some/path", UUID);
    expect(second.entries.map((entry) => entry.link)).toEqual(first.entries.map((entry) => entry.link));
    expect(second.uuid).toBe(UUID);
  });

  it("accepts sloppy domains and rejects junk", () => {
    expect(sanitizePackDomain("https://Example.com/path")).toBe("example.com");
    expect(sanitizePackDomain("node.one.example.com")).toBe("node.one.example.com");
    expect(sanitizePackDomain("localhost")).toBeNull();
    expect(sanitizePackDomain("bad host.com")).toBeNull();
    expect(sanitizePackDomain("bad<hash>.com")).toBeNull();
    expect(sanitizePackDomain("example.1com")).toBeNull();
    expect(() => buildPhantomPack("localhost")).toThrow("invalid_pack_domain");
  });

  it("keeps a supplied uuid and mints one for empty or bogus input", () => {
    expect(normalizePackUuid(UUID)).toBe(UUID);
    expect(normalizePackUuid("panel-id-12345")).toBe("panel-id-12345");
    expect(normalizePackUuid("new")).toMatch(/^[0-9a-f-]{36}$/u);
    expect(normalizePackUuid("oops!")).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("renders every client format the old worker promised", () => {
    const pack = buildPhantomPack("example.com", UUID);
    const yaml = packToClashYaml(pack);
    expect(yaml.startsWith("proxies:")).toBe(true);
    expect(yaml.split('  - name: "').length - 1).toBe(PACK_SIZE);
    expect(yaml).toContain("proxy-groups:");

    const singBox = JSON.parse(packToSingBox(pack)) as { outbounds: Array<{ tag: string; type: string }> };
    expect(singBox.outbounds).toHaveLength(PACK_SIZE + 1);
    expect(singBox.outbounds[0]?.tag).toBe("PHANTOM");
    expect(singBox.outbounds[1]?.type).toBe("vless");

    const decoded = atob(packToSubscription(pack));
    expect(decoded.split("\n")).toHaveLength(PACK_SIZE);
    expect(decoded.split("\n")[0]).toMatch(/^vless:\/\//u);
  });

  it("links the pack without claiming anything was measured", () => {
    const pack = buildPhantomPack("example.com", UUID);
    const text = packLinkText(pack, "https://control.example.com/api/v1/pack");
    expect(text).toContain("بستهٔ ۲۰ کانفیگ");
    expect(text).toContain("VLESS ۱۲ · SS ۴ · Hysteria2 ۴");
    expect(text).toContain(PACK_WARNING);
    expect(text).not.toMatch(/۹۹٪|غول فعال|تست‌شده/u);
  });
});
