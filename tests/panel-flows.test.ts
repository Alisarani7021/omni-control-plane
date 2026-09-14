import { describe, expect, it } from "vitest";
import {
  clearPanelFlow,
  FLOW_STEP_PACK_DOMAIN,
  FLOW_STEP_PACK_UUID,
  flowPrompt,
  loadPanelFlow,
  processPanelFlowText,
  savePanelFlow,
  FLOW_STEP_MAP_CITY,
  FLOW_STEP_RUM_LOSS,
  FLOW_STEP_RUM_PING,
} from "../src/panel-flows";
import type { Env } from "../src/types";

interface Row {
  flow: string;
  step: string;
  state_json: string;
  expires_at: string;
}

interface Captured {
  sql: string;
  params: unknown[];
}

function flowEnv(row?: Row): { env: Env; captured: Captured[]; store: Map<string, Row> } {
  const store = new Map<string, Row>();
  if (row) store.set("555", row);
  const captured: Captured[] = [];
  const DB = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          captured.push({ sql, params });
          return {
            run: async () => {
              if (sql.startsWith("INSERT INTO telegram_flows")) {
                const [userId, flow, step, stateJson, expiresAt] = params as string[];
                store.set(userId!, { flow: flow!, step: step!, state_json: stateJson!, expires_at: expiresAt! });
              }
              if (sql.startsWith("DELETE FROM telegram_flows")) store.delete(params[0] as string);
              return { success: true, meta: { changes: 1 } };
            },
            first: async <T>() => (store.get(params[0] as string) ?? null) as unknown as T | null,
            all: async () => ({ results: [] }),
          };
        },
      };
    },
  };
  return { env: { DB } as unknown as Env, captured, store };
}

describe("phantom pack flow", () => {
  it("collects the domain, then returns links without storing the pack", async () => {
    const { env, store, captured } = flowEnv();
    const flow = { flow: "pack" as const, step: FLOW_STEP_PACK_DOMAIN, data: {} };
    const first = await processPanelFlowText(env, "555", "tenant", flow, "https://Example.com/x");
    expect(first.kind).toBe("prompt");
    expect(store.get("555")?.step).toBe(FLOW_STEP_PACK_UUID);

    const rejected = await processPanelFlowText(env, "555", "tenant", { flow: "pack", step: FLOW_STEP_PACK_DOMAIN, data: {} }, "not a domain");
    expect(rejected.kind).toBe("prompt");
    expect(rejected.text).toContain("دامنهٔ معتبر نیست");

    const packEnv = { ...env, PUBLIC_BASE_URL: "https://control.example.com/" } as typeof env;
    const done = await processPanelFlowText(packEnv, "555", "tenant", flow, "new");
    expect(done.kind).toBe("done");
    expect(done.text).toContain("https://control.example.com/api/v1/pack?domain=example.com");
    expect(done.text).toContain("format=clash");
    expect(done.text).toContain("format=singbox");
    expect(done.text).toContain("این فقط کانفیگ است، نه تست");
    expect(store.size).toBe(0);
    // No pack row is ever written: the only statements are the flow upsert/clear.
    expect(captured.every((item) => item.sql.includes("telegram_flows"))).toBe(true);
  });
});

describe("panel flow store", () => {
  it("round-trips the active step and expires stale conversations", async () => {
    const { env } = flowEnv();
    await savePanelFlow(env, "555", { flow: "rum", step: FLOW_STEP_RUM_PING, data: { ip: "185.143.232.1", operator: "mci" } });
    const loaded = await loadPanelFlow(env, "555");
    expect(loaded?.step).toBe(FLOW_STEP_RUM_PING);
    expect(loaded?.data["ip"]).toBe("185.143.232.1");

    const expired = flowEnv({ flow: "rum", step: FLOW_STEP_RUM_PING, state_json: "{}", expires_at: "2020-01-01T00:00:00.000Z" });
    expect(await loadPanelFlow(expired.env, "555")).toBeNull();
    expect(expired.store.size).toBe(0);

    const unknown = flowEnv({ flow: "other", step: "x", state_json: "{}", expires_at: "2099-01-01T00:00:00.000Z" });
    expect(await loadPanelFlow(unknown.env, "555")).toBeNull();
    expect(await clearPanelFlow(env, "555")).toBeUndefined();
  });

  it("asks for buttons instead of clearing the flow on a button-only step", async () => {
    const { env, store } = flowEnv({ flow: "map", step: FLOW_STEP_MAP_CITY, state_json: JSON.stringify({ isp: "مخابرات" }), expires_at: "2099-01-01T00:00:00.000Z" });
    const flow = await loadPanelFlow(env, "555");
    const result = await processPanelFlowText(env, "555", "tenant-1", flow!, "تهران");
    expect(result.kind).toBe("prompt");
    expect(result.text).toContain("دکمه");
    expect(store.get("555")?.step).toBe(FLOW_STEP_MAP_CITY);
    expect(flowPrompt(flow!)).toContain("دکمه");
  });

  it("accepts a free-text ping after an IP was picked and then clears the flow", async () => {
    const { env, store, captured } = flowEnv({
      flow: "rum",
      step: FLOW_STEP_RUM_PING,
      state_json: JSON.stringify({ ip: "185.143.232.13", operator: "mci", city: "tehran" }),
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    const flow = await loadPanelFlow(env, "555");
    const first = await processPanelFlowText(env, "555", "tenant-1", flow!, "38ms");
    expect(first.kind).toBe("prompt");
    expect(first.text).toContain("قدم ۲");
    const stored = store.get("555");
    expect(stored?.step).toBe(FLOW_STEP_RUM_LOSS);
    expect(JSON.parse(stored!.state_json)["latencyMs"]).toBe("38");

    const second = await processPanelFlowText(env, "555", "tenant-1", (await loadPanelFlow(env, "555"))!, "0");
    expect(second.kind).toBe("done");
    expect(second.saved).toBe(true);
    expect(store.size).toBe(0);
    expect(captured.some((item) => item.sql.includes("INSERT INTO clean_ip_reports"))).toBe(true);
  });

  it("keeps a '-'-only answer as reachability without latency", async () => {
    const { env, captured } = flowEnv({
      flow: "rum",
      step: FLOW_STEP_RUM_LOSS,
      state_json: JSON.stringify({ ip: "104.16.132.229", operator: "irancell", city: "tehran", latencyMs: "" }),
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    const flow = await loadPanelFlow(env, "555");
    const result = await processPanelFlowText(env, "555", "tenant-1", flow!, "-");
    expect(result.kind).toBe("done");
    const insert = captured.find((item) => item.sql.includes("INSERT INTO clean_ip_reports"));
    expect(insert?.params[3]).toBe(-1);
    expect(insert?.params[4]).toBe(0);
  });
});
