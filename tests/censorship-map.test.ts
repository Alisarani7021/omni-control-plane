import { describe, expect, it } from "vitest";
import { aggregateMap, mapText, parseMapReport } from "../src/censorship-map";
import type { Env } from "../src/types";

interface GroupRow {
  isp: string;
  city: string;
  transport: string;
  n: number;
  ok_count: number;
  rtts: string | null;
}

function mapEnv(rows: GroupRow[]): Env {
  const DB = {
    prepare() {
      return {
        bind(..._params: unknown[]) {
          return {
            run: async () => ({ success: true, meta: { changes: 1 } }),
            first: async () => null,
            all: async () => ({ results: rows }),
          };
        },
      };
    },
  };
  return { DB } as unknown as Env;
}

describe("censorship map reports", () => {
  it("falls back to safe values instead of trusting the client", () => {
    expect(parseMapReport({ isp: "ناشناخته", city: "تهران", transport: "magic", rtt: 40 })).toEqual({
      isp: "سایر",
      city: "تهران",
      transport: "other",
      rttMs: 40,
      ok: true,
    });
  });

  it("strips markup from the free-text city", () => {
    const parsed = parseMapReport({ isp: "ایرانسل", city: "  <b>شیراز</b>  ", transport: "hysteria2", ok: 1 });
    expect(parsed.city).toBe("شیراز");
    expect(parsed.ok).toBe(true);
    expect(parsed.rttMs).toBeNull();
  });

  it("accepts the legacy field names used by the OMNI sensor page", () => {
    const parsed = parseMapReport({ isp: "رایتل", city: "مشهد", tr: "ech", rtt: 12_000, ok: 0 });
    expect(parsed.rttMs).toBe(10_000);
    expect(parsed.transport).toBe("ech");
    expect(parsed.ok).toBe(false);
  });

  it("aggregates verdicts from real counts", async () => {
    const rows: GroupRow[] = [
      { isp: "همراه‌اول", city: "تهران", transport: "hysteria2", n: 4, ok_count: 4, rtts: "40,42,44,46" },
      { isp: "همراه‌اول", city: "تهران", transport: "fragment", n: 2, ok_count: 1, rtts: null },
      { isp: "ایرانسل", city: "شیراز", transport: "vless-reality", n: 5, ok_count: 0, rtts: null },
      { isp: "شاتل", city: "کرج", transport: "ech", n: 2, ok_count: 1, rtts: "90" },
    ];
    const aggregate = await aggregateMap(mapEnv(rows), 6);
    expect(aggregate.totalReports).toBe(13);

    const mci = aggregate.cells.find((cell) => cell.isp === "همراه‌اول");
    expect(mci?.reports).toBe(6);
    expect(mci?.medianRtt).toBe(44);
    expect(mci?.verdict).toBe("up");
    expect(mci?.transports.fragment).toEqual({ reports: 2, okRatio: 0.5 });

    const irancell = aggregate.cells.find((cell) => cell.isp === "ایرانسل");
    expect(irancell?.verdict).toBe("down");

    const shatel = aggregate.cells.find((cell) => cell.isp === "شاتل");
    expect(shatel?.verdict).toBe("nodata");

    expect(aggregate.transports[0]?.transport).toBe("hysteria2");
  });

  it("sorts broken cells first so operators see failures immediately", async () => {
    const rows: GroupRow[] = [
      { isp: "رایتل", city: "تبریز", transport: "hysteria2", n: 5, ok_count: 5, rtts: "30" },
      { isp: "مخابرات", city: "قم", transport: "fragment", n: 5, ok_count: 1, rtts: null },
    ];
    const aggregate = await aggregateMap(mapEnv(rows));
    expect(aggregate.cells[0]?.isp).toBe("مخابرات");
  });

  it("says so when there is no data", async () => {
    expect(mapText(await aggregateMap(mapEnv([])))).toContain("گزارشی ثبت نشده");
  });

  it("renders the populated map with verdict labels", async () => {
    const rows: GroupRow[] = [{ isp: "هوا‌وب", city: "اهواز", transport: "dns-tunnel", n: 4, ok_count: 2, rtts: "80,82" }];
    const text = mapText(await aggregateMap(mapEnv(rows)));
    expect(text).toContain("اهواز");
    expect(text).toContain("🟡 مختل");
    expect(text).toContain("گزارش ناشناس");
  });
});
