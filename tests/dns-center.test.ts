import { describe, expect, it } from "vitest";
import {
  classifyAnswers,
  DNS_CANARIES,
  encodeDnsQuery,
  parseCidr,
  parseDnsResponse,
  rangeRoundSummary,
  replaceScanRange,
  runScanTick,
} from "../src/dns-center";

describe("DNS center range parsing", () => {
  it("accepts single IPs and /24../32 CIDRs", () => {
    expect(parseCidr("1.1.1.1")?.ips).toEqual(["1.1.1.1"]);
    expect(parseCidr("178.22.122.0/24")?.ips).toHaveLength(256);
    expect(parseCidr("178.22.122.7/30")?.ips).toEqual(["178.22.122.4", "178.22.122.5", "178.22.122.6", "178.22.122.7"]);
  });

  it("rejects wide ranges, bad octets and garbage", () => {
    expect(parseCidr("10.0.0.0/16")).toBeNull();
    expect(parseCidr("300.1.1.1")).toBeNull();
    expect(parseCidr("example.com")).toBeNull();
    expect(parseCidr("")).toBeNull();
  });
});

describe("DNS wire format", () => {
  it("encodes a single A question", () => {
    const wire = encodeDnsQuery("dns.google");
    expect(wire[4]).toBe(0);
    expect(wire[5]).toBe(1); // qdcount
    expect(wire[12]).toBe(3); // label length "dns"
  });

  it("parses a synthetic NOERROR answer with one A record", () => {
    const response = new Uint8Array([
      0x13, 0x56, 0x81, 0x80, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
      0x03, 0x64, 0x6e, 0x73, 0x06, 0x67, 0x6f, 0x6f, 0x67, 0x6c, 0x65, 0x00,
      0x00, 0x01, 0x00, 0x01,
      0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x04, 8, 8, 8, 8,
    ]);
    const parsed = parseDnsResponse(response);
    expect(parsed.rcode).toBe(0);
    expect(parsed.answers).toEqual(["8.8.8.8"]);
  });
});

describe("honest verdicts", () => {
  const expected = (DNS_CANARIES[1] ?? DNS_CANARIES[0])?.expected ?? [];
  it("marks globally-correct answers healthy", () => {
    expect(classifyAnswers(["8.8.8.8"], ["8.8.8.8", "8.8.4.4"])).toBe("healthy");
  });
  it("marks blackhole answers fake", () => {
    expect(classifyAnswers(["127.0.0.1"], expected)).toBe("fake");
    expect(classifyAnswers(["10.10.34.34"], expected)).toBe("fake");
  });
  it("marks unexpected answers wrong and empty answers unreachable", () => {
    expect(classifyAnswers(["93.184.216.34"], expected)).toBe("wrong");
    expect(classifyAnswers([], expected)).toBe("unreachable");
  });
});

describe("single-slot scanner: replace + bounded ticks", () => {
  function makeEnv(rangeRow: { cidr: string; cursor: number; ips_total: number } | null) {
    const executed: Array<{ sql: string; params: unknown[] }> = [];
    const DB = {
      prepare(sql: string) {
        const record = { sql, params: [] as unknown[] };
        const api = {
          sql,
          params: record.params,
          bind(...params: unknown[]) {
            record.params = params;
            api.params = params;
            return api;
          },
          run: async () => {
            executed.push(record);
            return { success: true, meta: { changes: 1 } };
          },
          first: async <T>() => {
            executed.push(record);
            if (sql.includes("SELECT cidr, cursor, ips_total")) return rangeRow as unknown as T;
            if (sql.includes("SELECT cidr FROM dns_scan_ranges")) return (rangeRow ? { cidr: rangeRow.cidr } : null) as unknown as T;
            return null as unknown as T;
          },
          all: async <T>() => {
            executed.push(record);
            if (sql.includes("GROUP BY verdict")) return { results: [] as T[] };
            if (sql.includes("SELECT verdict, ip, rtt_ms")) {
              return { results: [{ verdict: "unreachable", ip: "1.1.1.1", rtt_ms: null }] as T[] };
            }
            if (sql.includes("SELECT id FROM dns_scan_ranges WHERE tenant_id")) {
              return { results: [{ id: "old-1" }] as T[] };
            }
            return { results: [] as T[] };
          },
        };
        return api;
      },
      batch: async (items: Array<{ sql: string; params: unknown[] }>) => {
        executed.push(...items);
        return [];
      },
    };
    return { env: { DB } as never, executed };
  }

  it("drops every stored range before registering the new one", async () => {
    const { env, executed } = makeEnv(null);
    const parsed = await replaceScanRange(env, "tenant-1", "178.22.122.4/30");
    expect(parsed.ips).toHaveLength(4);
    expect(executed.some((item) => item.sql.startsWith("DELETE FROM dns_scan_results WHERE range_id"))).toBe(true);
    expect(executed.some((item) => item.sql.startsWith("DELETE FROM dns_scan_ranges WHERE id"))).toBe(true);
    expect(executed.some((item) => item.sql.startsWith("INSERT INTO dns_scan_ranges"))).toBe(true);
  });

  it("one tick probes a bounded wave, stores honest verdicts and finishes a small range", async () => {
    const { env, executed } = makeEnv({ cidr: "178.22.122.4/30", cursor: 0, ips_total: 4 });
    const tick = await runScanTick(env, "range-9", 8000);
    expect(tick.done).toBe(true);
    expect(tick.progress.scanned).toBe(4);
    expect(tick.progress.unreachable).toBe(4); // node has no TCP/53: unreachable, never invented
    expect(tick.progress.healthy).toBe(0);
    expect(executed.filter((item) => item.sql.startsWith("INSERT INTO dns_scan_results")).length).toBe(4);
    expect(executed.some((item) => item.sql.startsWith("UPDATE dns_scan_ranges SET cursor = 0"))).toBe(true);
    const summary = await rangeRoundSummary(env, "range-9");
    expect(summary.total).toBe(1); // read back from stored rows only
    expect(summary.healthy).toBe(0);
  });
});

describe("cron resilience", () => {
  it("keeps scanning DNS ranges even when an earlier cron stage explodes", async () => {
    const executed: string[] = [];
    const DB = {
      prepare(sql: string) {
        const api = {
          sql,
          params: [] as unknown[],
          bind(...params: unknown[]) {
            api.params = params;
            return api;
          },
          run: async () => {
            executed.push(sql);
            return { success: true, meta: { changes: 1 } };
          },
          first: async <T>() => {
            executed.push(sql);
            if (sql.includes("mtu_reports")) throw new Error("no such table: mtu_reports");
            if (sql.includes("COUNT(*)")) return { n: 8 } as unknown as T;
            if (sql.includes("SELECT id FROM dns_scan_ranges")) return { id: "r" } as unknown as T;
            return null as unknown as T;
          },
          all: async <T>() => {
            executed.push(sql);
            if (sql.includes("DISTINCT tenant_id")) return { results: [{ tenant_id: "t1" }] as T[] };
            return { results: [] as T[] };
          },
        };
        return api;
      },
      batch: async () => [],
    };
    const env = { DB } as never;
    const worker = (await import("../src/index")).default;
    await worker.scheduled({ cron: "*/5 * * * *" } as never, env);
    expect(executed.some((sql) => sql.includes("FROM dns_scan_ranges"))).toBe(true);
  });
});
