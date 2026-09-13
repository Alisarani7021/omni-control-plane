import { describe, expect, it } from "vitest";
import { cleanIpFeed, phantomPackFeed, submitCleanIpReport, submitMapReport, whiteHoleReader } from "../src/telemetry-routes";
import type { Env } from "../src/types";

interface Captured {
  sql: string;
  params: unknown[];
}

interface Options {
  rateLimited?: boolean;
  reportRows?: Array<Record<string, unknown>>;
}

function env(options: Options = {}): { env: Env; captured: Captured[] } {
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
            first: async <T>() => {
              if (sql.includes("FROM rate_limits")) {
                const now = Math.floor(Date.now() / 1000);
                return { window_started_at: now - (now % 3_600), hits: options.rateLimited ? 999 : 1 } as unknown as T;
              }
              return null;
            },
            all: async <T>() => ({ results: (options.reportRows ?? []) as unknown as T[] }),
          };
        },
      };
    },
  };
  return { env: { DB, PUBLIC_BASE_URL: "https://control.example.com" } as unknown as Env, captured };
}

function post(body: unknown, ip = "203.0.113.7"): Request {
  return new Request("https://control.example.com/api/v1/telemetry/clean-ip", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify(body),
  });
}

describe("clean-ip telemetry API", () => {
  it("stores a validated client report", async () => {
    const { env: testEnv, captured } = env();
    const response = await submitCleanIpReport(
      post({ ip: "185.143.232.13", latencyMs: 26, lossPct: 0, ok: true, operator: "mci", city: "tehran" }),
      testEnv,
    );
    expect(response.status).toBe(201);
    const insert = captured.find((item) => item.sql.includes("INSERT INTO clean_ip_reports"));
    expect(insert?.params.slice(0, 6)).toEqual(["185.143.232.13", "mci", "tehran", 26, 0, 1]);
  });

  it("rate limits per address without storing the address", async () => {
    const { env: testEnv, captured } = env({ rateLimited: true });
    await expect(submitCleanIpReport(post({ ip: "185.143.232.13", latencyMs: 26 }), testEnv))
      .rejects.toMatchObject({ status: 429, code: "rate_limited" });
    const bucket = captured.find((item) => item.sql.includes("INSERT INTO rate_limits"));
    expect(String(bucket?.params[0])).toMatch(/^rum:\d{4}-\d{2}-\d{2}:[A-Za-z0-9_-]{32}$/u);
    expect(JSON.stringify(captured)).not.toContain("203.0.113.7");
  });

  it("rejects oversized and non-JSON payloads", async () => {
    const { env: testEnv } = env();
    const huge = new Request("https://control.example.com/api/v1/telemetry/clean-ip", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
      body: JSON.stringify({ ip: "185.143.232.13", note: "x".repeat(4_000) }),
    });
    await expect(submitCleanIpReport(huge, testEnv)).rejects.toMatchObject({ status: 413 });

    const wrongType = new Request("https://control.example.com/api/v1/telemetry/clean-ip", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "CF-Connecting-IP": "203.0.113.7" },
      body: "hello",
    });
    await expect(submitCleanIpReport(wrongType, testEnv)).rejects.toMatchObject({ status: 415 });
  });

  it("serves the ranked pool as JSON or plain text", async () => {
    const { env: testEnv } = env({
      reportRows: [{
        ip: "185.143.232.13", latency_ms: 26, loss_pct: 0, ok_count: 3, report_count: 3,
        updated_at: new Date().toISOString(),
      }],
    });
    const jsonView = await cleanIpFeed(new Request("https://control.example.com/api/v1/clean-ip?operator=mci&city=tehran&limit=5"), testEnv);
    const payload = await jsonView.json() as { measured: number; ranked: Array<{ ip: string; status: string }> };
    expect(payload.measured).toBe(1);
    expect(payload.ranked[0]?.ip).toBe("185.143.232.13");
    expect(jsonView.headers.get("Cache-Control")).toContain("max-age=60");

    const textView = await cleanIpFeed(new Request("https://control.example.com/api/v1/clean-ip?format=text"), testEnv);
    const body = await textView.text();
    expect(body.split("\n")[0]).toContain("185.143.232.13:443#mci-tehran");
    expect(body).toContain("latency=26ms");
    expect(body).toContain("no-data");
  });
});

describe("censorship map API", () => {
  it("stores an anonymous report", async () => {
    const { env: testEnv, captured } = env();
    const response = await submitMapReport(
      new Request("https://control.example.com/api/v1/telemetry/map", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.8" },
        body: JSON.stringify({ isp: "مخابرات", city: "تهران", transport: "fragment", rtt: 61, ok: 1 }),
      }),
      testEnv,
    );
    expect(response.status).toBe(201);
    const insert = captured.find((item) => item.sql.includes("INSERT INTO map_reports"));
    expect(insert?.params.slice(1, 7)).toEqual(["مخابرات", "تهران", "fragment", 61, 1, expect.any(String)]);
    expect(JSON.stringify(captured)).not.toContain("203.0.113.8");
  });
});

describe("whitehole reader script", () => {
  it("returns a shell script for a valid domain only", async () => {
    const { env: testEnv } = env();
    const request = new Request("https://control.example.com/api/v1/whitehole/fetch.sh?domain=Example.com");
    const response = await whiteHoleReader(request, testEnv);
    expect(response.headers.get("Content-Type")).toContain("text/x-shellscript");
    expect(await response.text()).toContain('DOMAIN="example.com"');

    await expect(whiteHoleReader(new Request("https://control.example.com/api/v1/whitehole/fetch.sh?domain=$(id)"), testEnv))
      .rejects.toMatchObject({ status: 400 });
  });
});

describe("phantom pack feed", () => {
  const UUID = "11111111-2222-3333-4444-555555555555";
  const get = (format: string, domain = "example.com") =>
    new Request(`https://control.example.com/api/v1/pack?domain=${domain}&uuid=${UUID}&format=${format}`, {
      headers: { "CF-Connecting-IP": "203.0.113.9" },
    });

  it("serves all three client formats from the same input", async () => {
    const { env: testEnv, captured } = env();
    const subscription = await phantomPackFeed(get("v2ray"), testEnv);
    expect(subscription.headers.get("Cache-Control")).toBe("no-store");
    expect(atob(await subscription.text()).split("\n")).toHaveLength(20);

    const { env: clashEnv } = env();
    const clash = await phantomPackFeed(get("clash"), clashEnv);
    expect(clash.headers.get("Content-Type")).toContain("text/yaml");
    expect(await clash.text()).toContain("proxy-groups:");

    const { env: singEnv } = env();
    const singBox = JSON.parse(await (await phantomPackFeed(get("singbox"), singEnv)).text()) as { outbounds: unknown[] };
    expect(singBox.outbounds).toHaveLength(21);

    const { env: jsonEnv } = env();
    const body = await (await phantomPackFeed(get("json"), jsonEnv)).json() as { counts: Record<string, number>; note: string };
    const counts = body.counts as Record<string, number>;
    expect((counts["vless"] ?? 0) + (counts["ss"] ?? 0) + (counts["hysteria2"] ?? 0)).toBe(20);
    expect(body.note).toContain("never stored");
    // Generation is stateless: the only SQL is the rate bucket.
    expect(captured.every((item) => item.sql.includes("rate_limits"))).toBe(true);
  });

  it("refuses a malformed domain and an oversized uuid", async () => {
    const { env: testEnv } = env();
    await expect(phantomPackFeed(get("json", "bad host"), testEnv)).rejects.toMatchObject({ status: 400, code: "invalid_domain" });
    const { env: longEnv } = env();
    const request = new Request(`https://control.example.com/api/v1/pack?domain=example.com&uuid=${"a".repeat(80)}`, {
      headers: { "CF-Connecting-IP": "203.0.113.10" },
    });
    await expect(phantomPackFeed(request, longEnv)).rejects.toMatchObject({ status: 400 });
  });
});
