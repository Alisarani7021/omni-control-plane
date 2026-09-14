import { describe, expect, it } from "vitest";
import {
  evaluatePoisonTest,
  isBlackholeAnswer,
  parseMtuReport,
  parsePoisonReport,
  POISON_CANARIES,
  POISON_RESOLVERS,
  renderDnsTestScript,
} from "../src/dns-poison";
import { raceWinner, parseRaceReport } from "../src/domestic-race";

describe("DNS poisoning self-test", () => {
  it("treats documented blackhole answers as fake only", () => {
    expect(isBlackholeAnswer("127.0.0.1")).toBe(true);
    expect(isBlackholeAnswer("0.0.0.0")).toBe(true);
    expect(isBlackholeAnswer("10.10.34.34")).toBe(true);
    expect(isBlackholeAnswer("104.16.1.1")).toBe(false);
  });

  it("counts fake answers per resolver honestly", () => {
    const verdict = evaluatePoisonTest([
      { resolver: "melli", canary: POISON_CANARIES[0] ?? "dns.google", answers: ["127.0.0.1", "10.10.34.34"] },
      { resolver: "cf-1111", canary: POISON_CANARIES[0] ?? "dns.google", answers: ["8.8.4.4"] },
    ]);
    expect(verdict.total).toBe(3);
    expect(verdict.fake).toBe(2);
    expect(verdict.perResolver.find((item) => item.resolver === "melli")?.fake).toBe(2);
    expect(verdict.perResolver.find((item) => item.resolver === "cf-1111")?.fake).toBe(0);
  });

  it("rejects unknown resolvers and canaries at ingest", () => {
    expect(() =>
      parsePoisonReport({ entries: [{ resolver: "evil", canary: "evil.com", answers: ["1.2.3.4"] }] }),
    ).toThrow();
    const parsed = parsePoisonReport({
      isp: "همراه‌اول",
      city: "تهران",
      entries: [{ resolver: POISON_RESOLVERS[1]?.id, canary: POISON_CANARIES[0], answers: ["127.0.0.1"] }],
    });
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.isp).toBe("همراه‌اول");
  });

  it("clamps MTU crowd reports into the measured range", () => {
    expect(parseMtuReport({ isp: "رایتل", city: "کرج", mtu: 1180 }).mtu).toBe(1180);
    expect(() => parseMtuReport({ mtu: 64 })).toThrow();
    expect(() => parseMtuReport({ mtu: "1180" })).toThrow();
  });

  it("ships a client script that submits raw answers only", () => {
    const script = renderDnsTestScript("https://control.example.com");
    expect(script).toContain("#!/usr/bin/env bash");
    expect(script).toContain("api/v1/telemetry/dns-poison");
    expect(script).toContain("178.22.122.100");
    expect(script).not.toContain("BOT_TOKEN");
  });
});

describe("domestic race", () => {
  it("picks the faster path and ties honestly", () => {
    expect(raceWinner(40, 400)).toBe("direct");
    expect(raceWinner(400, 40)).toBe("tunnel");
    expect(raceWinner(40, 40)).toBe("tie");
    expect(raceWinner(null, 40)).toBe("tie");
  });

  it("sanitizes race reports", () => {
    expect(() => parseRaceReport({ domain: "x", directMs: 1 })).toThrow();
    const parsed = parseRaceReport({ domain: "Aparat.com", directMs: 40, tunnelMs: 400 });
    expect(parsed.domain).toBe("aparat.com");
  });
});
