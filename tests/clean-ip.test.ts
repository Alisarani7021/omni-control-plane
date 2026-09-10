import { describe, expect, it } from "vitest";
import {
  cleanIpPool,
  cleanIpRankingText,
  parseCleanIpReport,
  purgeExpiredCleanIpReports,
  rankCleanIps,
  recordCleanIpReport,
  CLEAN_IP_FRESHNESS_HOURS,
} from "../src/clean-ip";
import { HttpError } from "../src/http";
import type { Env } from "../src/types";

interface Captured {
  sql: string;
  params: unknown[];
}

interface RankingRow {
  ip: string;
  latency_ms: number;
  loss_pct: number;
  ok_count: number;
  report_count: number;
  updated_at: string;
}

function radarEnv(rows: RankingRow[]): { env: Env; captured: Captured[] } {
  const captured: Captured[] = [];
  const DB = {
    prepare(sql: string) {
      const record: Captured = { sql, params: [] };
      captured.push(record);
      return {
        bind(...params: unknown[]) {
          record.params = params;
          return {
            run: async () => ({ success: true, meta: { changes: 1 } }),
            first: async () => null,
            all: async <T>() => (sql.includes("FROM clean_ip_reports") ? { results: rows as unknown as T[] } : { results: [] as T[] }),
          };
        },
      };
    },
  };
  return { env: { DB } as unknown as Env, captured };
}

const freshDate = new Date(Date.now() - 3_600_000).toISOString();
const staleDate = new Date(Date.now() - (CLEAN_IP_FRESHNESS_HOURS + 6) * 3_600_000).toISOString();

describe("clean-ip report parsing", () => {
  it("accepts V13 fields and the legacy short aliases", () => {
    expect(parseCleanIpReport({ ip: "185.143.232.1", latencyMs: 42.6, lossPct: 1.2, ok: true, operator: "MCI", city: "Tehran" }))
      .toEqual({ ip: "185.143.232.1", operator: "mci", city: "tehran", latencyMs: 43, lossPct: 1.2, ok: true });
    expect(parseCleanIpReport({ ip: "104.16.132.229", t: 88, loss: 3, ok: 1, asn: "AS49100", city: "Isfahan" }))
      .toEqual({ ip: "104.16.132.229", operator: "irancell", city: "isfahan", latencyMs: 88, lossPct: 3, ok: true });
  });

  it("treats an unknown city as a separate bucket instead of dropping the report", () => {
    const parsed = parseCleanIpReport({ ip: "104.16.132.229", t: 50, ok: true, city: "Yazd" });
    expect(parsed.city).toBe("other");
  });

  it("rejects non-IPv4, private ranges and impossible latencies", () => {
    expect(() => parseCleanIpReport({ ip: "not-an-ip", t: 40 })).toThrow(HttpError);
    expect(() => parseCleanIpReport({ ip: "10.0.0.5", t: 40 })).toThrow(HttpError);
    expect(() => parseCleanIpReport({ ip: "185.143.232.1", t: 60_000 })).toThrow(/out of range/u);
    expect(() => parseCleanIpReport("nope")).toThrow(HttpError);
  });

  it("clamps loss into 0..100", () => {
    expect(parseCleanIpReport({ ip: "185.143.232.1", t: 40, loss: 900 }).lossPct).toBe(100);
    expect(parseCleanIpReport({ ip: "185.143.232.1", t: 40, loss: -20 }).lossPct).toBe(0);
  });

  it("keeps 'could not measure' as -1 instead of pretending 0ms", () => {
    expect(parseCleanIpReport({ ip: "185.143.232.1", t: -1, ok: false }).latencyMs).toBe(-1);
    const { env, captured } = radarEnv([]);
    void recordCleanIpReport(env, { ip: "185.143.232.1", operator: "mci", city: "tehran", latencyMs: -1, lossPct: 0, ok: false });
    const insert = captured.find((item) => item.sql.includes("INSERT INTO clean_ip_reports"));
    expect(insert?.params[3]).toBe(-1);
  });
});

describe("clean-ip ranking", () => {
  it("puts measured IPs first and never invents a measurement", async () => {
    const { env } = radarEnv([
      { ip: "185.143.232.13", latency_ms: 30, loss_pct: 0, ok_count: 5, report_count: 5, updated_at: freshDate },
      { ip: "104.16.132.229", latency_ms: 900, loss_pct: 0, ok_count: 4, report_count: 4, updated_at: freshDate },
    ]);
    const ranking = await rankCleanIps(env, { operator: "mci", city: "tehran", limit: 41 });
    expect(ranking.rows[0]?.ip).toBe("185.143.232.13");
    expect(ranking.rows[0]?.status).toBe("verified");
    expect(ranking.rows[1]?.ip).toBe("104.16.132.229");
    expect(ranking.rows[1]?.status).toBe("degraded");
    const unmeasured = ranking.rows.filter((row) => !row.measured);
    expect(unmeasured.length).toBeGreaterThan(0);
    expect(unmeasured.every((row) => row.status === "nodata" && row.latencyMs === null)).toBe(true);
    expect(ranking.measured).toBe(2);
  });

  it("flags an IP that clients report as unreachable as risky", async () => {
    const { env } = radarEnv([
      { ip: "185.143.232.36", latency_ms: 60, loss_pct: 0, ok_count: 1, report_count: 9, updated_at: freshDate },
    ]);
    const ranking = await rankCleanIps(env, { operator: "mci", city: "tehran", limit: 41 });
    expect(ranking.rows[0]?.status).toBe("risky");
  });

  it("ignores stale reports but still counts them", async () => {
    const { env } = radarEnv([
      { ip: "185.143.232.1", latency_ms: 20, loss_pct: 0, ok_count: 2, report_count: 2, updated_at: staleDate },
    ]);
    const ranking = await rankCleanIps(env, { operator: "mci", city: "tehran", limit: 41 });
    const row = ranking.rows.find((item) => item.ip === "185.143.232.1");
    expect(row?.measured).toBe(false);
    expect(row?.reports).toBe(2);
  });

  it("shows reachability-only reports without a fake latency", async () => {
    const { env } = radarEnv([
      { ip: "185.143.233.9", latency_ms: -1, loss_pct: 0, ok_count: 1, report_count: 1, updated_at: freshDate },
    ]);
    const ranking = await rankCleanIps(env, { operator: "mci", city: "tehran", limit: 41 });
    const row = ranking.rows.find((item) => item.ip === "185.143.233.9");
    expect(row?.measured).toBe(true);
    expect(row?.latencyMs).toBeNull();
    expect(cleanIpRankingText(ranking, "https://control.example.com")).toContain("بدون پینگ");
  });

  it("renders HTML-safe text without undefined values", async () => {
    const { env } = radarEnv([{ ip: "<script>", latency_ms: 40, loss_pct: 0, ok_count: 1, report_count: 1, updated_at: freshDate }]);
    const text = cleanIpRankingText(await rankCleanIps(env, { limit: 41 }), "https://control.example.com");
    expect(text).not.toContain("<script>");
    expect(text).not.toMatch(/undefined|null/);
    expect(text).toContain("بدون داده");
    expect(text).toContain("/api/v1/telemetry/clean-ip");
  });

  it("keeps the static pool free of duplicates and private ranges", () => {
    const pool = cleanIpPool();
    expect(new Set(pool.map((entry) => entry.ip)).size).toBe(pool.length);
    expect(pool.length).toBeGreaterThan(30);
    expect(pool.every((entry) => /^\d{1,3}(\.\d{1,3}){3}$/u.test(entry.ip))).toBe(true);
  });

  it("purges only expired rows", async () => {
    const { env, captured } = radarEnv([]);
    await purgeExpiredCleanIpReports(env);
    expect(captured.some((item) => /DELETE FROM clean_ip_reports WHERE expires_at/u.test(item.sql))).toBe(true);
  });
});
