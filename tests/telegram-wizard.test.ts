import { describe, expect, it } from "vitest";
import type { BotConnectionBoundary } from "../src/bot-actions";
import {
  WIZARD_STEP_CONFIRM,
  applySniDefault,
  applyUfwChoice,
  beginDeployWizard,
  clearWizard,
  confirmSummary,
  loadWizard,
  processWizardText,
  validateWizardEmail,
  validateWizardIpv4,
  validateWizardSni,
  validateWizardSubdomain,
  validateWizardWorkerName,
} from "../src/telegram-wizard";
import type { Env } from "../src/types";

interface WizardRow {
  flow: string;
  step: string;
  state_json: string;
  expires_at: string;
}

function wizardEnv(seed?: Map<string, WizardRow>): { env: Env; store: Map<string, WizardRow> } {
  const store = seed ?? new Map<string, WizardRow>();
  const DB = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            run: async () => {
              if (sql.startsWith("INSERT INTO telegram_wizards")) {
                const [userId, flow, step, stateJson, expiresAt] = params as string[];
                store.set(userId!, { flow: flow!, step: step!, state_json: stateJson!, expires_at: expiresAt! });
              } else if (sql.startsWith("DELETE FROM telegram_wizards")) {
                store.delete(params[0] as string);
              }
              return { success: true, meta: { changes: 1 } };
            },
            first: async <T>() => {
              if (sql.includes("FROM telegram_wizards")) return (store.get(params[0] as string) ?? null) as unknown as T;
              return null;
            },
          };
        },
      };
    },
  };
  return { env: { DB } as unknown as Env, store };
}

const BOUNDARY: BotConnectionBoundary = {
  connectionId: "11111111-1111-4111-8111-111111111111",
  connectionName: "example.com",
  accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  accountName: "Example",
  zoneId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  zoneName: "example.com",
};

describe("wizard validators", () => {
  it("accepts valid worker names only", () => {
    expect(validateWizardWorkerName("v13-my-node")).toBeNull();
    expect(validateWizardWorkerName("V13-Node")).toBeNull();
    expect(validateWizardWorkerName("bad name")).not.toBeNull();
    expect(validateWizardWorkerName("-bad")).not.toBeNull();
  });

  it("requires subdomains of the connected zone", () => {
    expect(validateWizardSubdomain("sub.example.com", "example.com", undefined, "x")).toBeNull();
    expect(validateWizardSubdomain("sub.other.com", "example.com", undefined, "x")).toContain("example.com");
    expect(validateWizardSubdomain("node.example.com", "example.com", "node.example.com", "x")).toContain("متفاوت");
    expect(validateWizardSubdomain("not a host", "example.com", undefined, "x")).not.toBeNull();
  });

  it("requires a public IPv4 address", () => {
    expect(validateWizardIpv4("1.2.3.4")).toBeNull();
    expect(validateWizardIpv4("192.168.1.1")).not.toBeNull();
    expect(validateWizardIpv4("999.1.1.1")).not.toBeNull();
  });

  it("validates email and Reality target", () => {
    expect(validateWizardEmail("admin@example.com")).toBeNull();
    expect(validateWizardEmail("not-an-email")).not.toBeNull();
    expect(validateWizardSni("www.microsoft.com", "node.example.com")).toBeNull();
    expect(validateWizardSni("node.example.com", "node.example.com")).toContain("خودِ همین نود");
  });
});

describe("wizard lifecycle", () => {
  it("walks the full deploy flow and builds a confirm summary", async () => {
    const { env } = wizardEnv();
    const first = await beginDeployWizard(env, "555", BOUNDARY);
    expect(first.text).toContain("قدم ۱");

    const inputs: Array<[string, string]> = [
      ["v13-test", "قدم ۲"],
      ["sub.example.com", "قدم ۳"],
      ["node.example.com", "قدم ۴"],
      ["1.2.3.4", "قدم ۵"],
      ["admin@example.com", "قدم ۶"],
      ["www.microsoft.com", "قدم ۷"],
    ];
    for (const [text, expected] of inputs) {
      const wizard = await loadWizard(env, "555");
      expect(wizard).not.toBeNull();
      const result = await processWizardText(env, "555", wizard!, text);
      expect(result.text).toContain(expected);
    }

    const beforeUfw = await loadWizard(env, "555");
    const ufw = await applyUfwChoice(env, "555", beforeUfw!, true);
    expect(ufw.text).toContain("پیش‌فاکتور");

    const atConfirm = await loadWizard(env, "555");
    expect(atConfirm?.step).toBe(WIZARD_STEP_CONFIRM);
    const summary = confirmSummary(atConfirm!.state);
    for (const value of ["v13-test", "sub.example.com", "node.example.com", "1.2.3.4", "admin@example.com", "www.microsoft.com"]) {
      expect(summary).toContain(value);
    }
    expect(summary).toContain("UFW خودکار: بله");
  });

  it("applies the default Reality SNI via button", async () => {
    const { env } = wizardEnv();
    await beginDeployWizard(env, "555", BOUNDARY);
    for (const text of ["v13-test", "sub.example.com", "node.example.com", "1.2.3.4", "admin@example.com"]) {
      const wizard = await loadWizard(env, "555");
      await processWizardText(env, "555", wizard!, text);
    }
    const wizard = await loadWizard(env, "555");
    const result = await applySniDefault(env, "555", wizard!);
    expect(result.text).toContain("قدم ۷");
    expect((await loadWizard(env, "555"))?.state.realityServerName).toBe("www.microsoft.com");
  });

  it("expires stale wizards", async () => {
    const store = new Map<string, WizardRow>([
      ["555", {
        flow: "deploy",
        step: "workerName",
        state_json: JSON.stringify({ connectionId: "c", accountId: "a", zoneId: "z", zoneName: "example.com" }),
        expires_at: "2000-01-01T00:00:00.000Z",
      }],
    ]);
    const { env } = wizardEnv(store);
    expect(await loadWizard(env, "555")).toBeNull();
    expect(store.has("555")).toBe(false);
  });

  it("clears wizards on cancel", async () => {
    const { env, store } = wizardEnv();
    await beginDeployWizard(env, "555", BOUNDARY);
    expect(store.has("555")).toBe(true);
    await clearWizard(env, "555");
    expect(store.has("555")).toBe(false);
  });
});

describe("telegram callback payloads", () => {
  it("keeps every dynamic callback within the 64-byte limit", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const samples = [
      "v13:login",
      "v13:deps",
      "v13:dep:new",
      `v13:dep:${id}`,
      `v13:dep-retry:${id}`,
      `v13:dep-revoke:${id}`,
      `v13:dep-revoke-yes:${id}`,
      `v13:dep-boot:${id}`,
      `v13:dep-subs:${id}`,
      `v13:dep-subrot:${id}`,
      `v13:dep-subrot-yes:${id}`,
      "v13:conns",
      "v13:conn-new",
      `v13:conn-disc:${id}`,
      `v13:conn-disc-yes:${id}`,
      `wiz:conn:${id}`,
      "wiz:cancel",
      "wiz:sni-def",
      "wiz:ufw:1",
      "wiz:confirm",
      "v13:delmsg",
      "omni:home",
    ];
    const encoder = new TextEncoder();
    for (const sample of samples) {
      expect(encoder.encode(sample).byteLength).toBeLessThanOrEqual(64);
    }
  });
});
