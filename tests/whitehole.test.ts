import { describe, expect, it } from "vitest";
import {
  assembleWhiteHoleDrop,
  buildWhiteHolePayload,
  renderFetchScript,
  validateDropDomain,
  whiteHoleRecordValue,
  whiteHoleText,
  WHITEHOLE_MAX_SHARDS,
  WHITEHOLE_SHARD_CHARS,
} from "../src/whitehole";
import type { CleanIpRanking } from "../src/clean-ip";
import { HttpError } from "../src/http";

function ranking(overrides: Partial<CleanIpRanking> = {}): CleanIpRanking {
  return {
    operator: { key: "mci", label: "همراه اول", asn: "AS197207", dns: "178.22.122.100", ports: [443], preferred: [] },
    city: { key: "tehran", label: "تهران" },
    generatedAt: new Date().toISOString(),
    measured: 1,
    poolSize: 2,
    rows: [
      {
        ip: "185.143.232.13", tier: "arvan", port: 443, sni: "snapp.ir", fingerprint: "chrome", fragment: "20-60",
        latencyMs: 26, lossPct: 0, reports: 4, okRatio: 1, ageHours: 0.5, measured: true, preferred: true, score: 14, status: "verified",
      },
      {
        ip: "104.16.132.229", tier: "cloudflare", port: 443, sni: "104.16.132.229", fingerprint: "firefox", fragment: "12-70",
        latencyMs: null, lossPct: null, reports: 0, okRatio: null, ageHours: null, measured: false, preferred: false, score: 1_000_000, status: "nodata",
      },
    ],
    ...overrides,
  };
}

function decodeShards(drop: { shards: string[]; checksum: number }, total: number): string {
  const joined = drop.shards.map((shard, index) => whiteHoleRecordValue(index, total, drop.checksum, shard))
    .map((value) => value.replace(/^v13;p\d+=/, "").replace(/;n=.*$/u, ""))
    .join("");
  const normalized = joined.replaceAll("-", "+").replaceAll("_", "/");
  return Buffer.from(normalized + "=".repeat((4 - (normalized.length % 4)) % 4), "base64").toString("utf8");
}

describe("whitehole dead-drop payload", () => {
  it("publishes reachability hints only — never a subscription or credential", () => {
    const payload = buildWhiteHolePayload(ranking(), "example.com");
    expect(payload.ips.map((row) => row.ip)).toEqual(["185.143.232.13", "104.16.132.229"]);
    expect(payload.dns[0]).toBe("178.22.122.100");
    const serialized = JSON.stringify(payload).toLowerCase();
    for (const forbidden of ["/sub", "subscription", "token", "password", "secret", "vless://"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("reassembles to the exact payload through base64url shards", () => {
    const payload = buildWhiteHolePayload(ranking(), "example.com");
    const drop = assembleWhiteHoleDrop(payload);
    expect(drop.shards.length).toBeGreaterThan(0);
    expect(drop.shards.length).toBeLessThanOrEqual(WHITEHOLE_MAX_SHARDS);
    expect(drop.shards.every((shard) => shard.length <= WHITEHOLE_SHARD_CHARS)).toBe(true);
    expect(drop.recordNames).toEqual(["ghost1", "ghost2", "ghost3", "ghost4"].slice(0, drop.shards.length));
    expect(JSON.parse(decodeShards(drop, drop.shards.length))).toEqual(JSON.parse(JSON.stringify(payload)));
  });

  it("caps the record count so a huge pool cannot flood DNS", () => {
    const wide = ranking({
      poolSize: 600,
      rows: Array.from({ length: 60 }, (_unused, index) => ({
        ip: `203.0.${Math.floor(index / 256)}.${index % 256}`,
        tier: "cloudflare" as const,
        port: 443,
        sni: "example.com",
        fingerprint: "chrome",
        fragment: "10-40",
        latencyMs: index,
        lossPct: 0,
        reports: 1,
        okRatio: 1,
        ageHours: 1,
        measured: true,
        preferred: false,
        score: index,
        status: "verified" as const,
      })),
    });
    const drop = assembleWhiteHoleDrop(buildWhiteHolePayload(wide, "example.com", 400));
    expect(drop.shards.length).toBe(WHITEHOLE_MAX_SHARDS);
  });

  it("keeps the record value parseable by the shell reader", () => {
    const value = whiteHoleRecordValue(0, 3, 42, "abc");
    expect(value).toBe("v13;p1=abc;n=3;c=42");
  });
});

describe("whitehole domain handling and reader script", () => {
  it("accepts hostnames and rejects everything else", () => {
    expect(validateDropDomain("Sub.Example.COM")).toBe("sub.example.com");
    for (const bad of ["", "not a domain", "example", "$(reboot)", "a".repeat(300) + ".com", "example.com; rm -rf /"]) {
      expect(() => validateDropDomain(bad)).toThrow(HttpError);
    }
  });

  it("renders a reader script without executing anything", () => {
    const script = renderFetchScript("example.com");
    expect(script.startsWith("#!/bin/bash")).toBe(true);
    expect(script).toContain('DOMAIN="example.com"');
    expect(script).toContain("dig +short TXT");
    expect(script).toContain("178.22.122.100");
    expect(script).not.toContain("rm -rf");
  });

  it("explains the no-secret rule when nothing was published yet", () => {
    const text = whiteHoleText(null, "https://control.example.com");
    expect(text).toContain("هیچ لینک اشتراک");
    expect(text).not.toContain("sub/");
  });
});
