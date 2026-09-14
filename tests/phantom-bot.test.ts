import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dnsttServerScript,
  isValidVpsIpv4,
  normalizeDnsttDomain,
  renderDnsttPackageText,
  serveDnsttScript,
} from "../src/dnstt";
import { handleTelegramWebhook, omniMainMenuKeyboard } from "../src/telegram";
import type { Env, TelegramUpdate } from "../src/types";

const BOT = "OmniAiGateBot";
const SECRET = "test-webhook-secret";

afterEach(() => vi.unstubAllGlobals());

function createEnv(options: { flowRow?: { flow: string; step: string; data: Record<string, string> } } = {}): { env: Env; statements: string[] } {
  const statements: string[] = [];
  let lastRateWindow: number | null = null;
  const DB = {
    prepare(sql: string) {
      statements.push(sql);
      const record = { sql, params: [] as unknown[] };
      return {
        bind(...params: unknown[]) {
          record.params = params;
          return {
            run: async () => {
              if (sql.includes("INSERT INTO rate_limits")) lastRateWindow = Number(params[1]);
              return { success: true, meta: { changes: 1 } };
            },
            first: async <T>() => {
              if (sql.includes("FROM rate_limits")) {
                const now = Math.floor(Date.now() / 1000);
                return { window_started_at: lastRateWindow ?? now - (now % 60), hits: 1 } as unknown as T;
              }
              if (sql.includes("FROM tenants")) return { id: "tenant-1", display_name: "Ali" } as unknown as T;
              if (sql.includes("FROM telegram_flows")) {
                if (!options.flowRow) return null as unknown as T;
                return {
                  flow: options.flowRow.flow,
                  step: options.flowRow.step,
                  state_json: JSON.stringify(options.flowRow.data),
                  expires_at: "2099-01-01T00:00:00.000Z",
                } as unknown as T;
              }
              if (sql.includes("FROM telegram_wizards")) return null as unknown as T;
              if (sql.includes("COUNT(*)")) return { count: 0 } as unknown as T;
              if (sql.includes("FROM ai_donations")) return null as unknown as T;
              return null as unknown as T;
            },
            all: async <T>() => ({ results: [] as T[] }),
          };
        },
      };
    },
    batch: async () => [],
  };
  const env = {
    DB,
    PUBLIC_BASE_URL: "https://control.example.com",
    BOT_USERNAME: BOT,
    LOGIN_LINK_TTL_SECONDS: "900",
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    TELEGRAM_WEBHOOK_SECRET: SECRET,
    TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ADMIN_TELEGRAM_IDS: "",
  } as unknown as Env;
  return { env, statements };
}

function webhookRequest(update: unknown): Request {
  return new Request("https://control.example.com/telegram/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": SECRET },
    body: JSON.stringify(update),
  });
}

function privateMessage(text: string, updateId = 1001): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: 7,
      chat: { id: 555, type: "private" },
      from: { id: 555, is_bot: false, first_name: "Ali" },
      text,
      date: Math.floor(Date.now() / 1000),
    },
  };
}

function callbackQuery(data: string, updateId = 2001): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: "callback-1",
      from: { id: 555, is_bot: false, first_name: "Ali" },
      message: { message_id: 9, chat: { id: 555, type: "private" } },
      data,
    },
  };
}

describe("dnstt helper", () => {
  it("validates vps ip and tunnel domain", () => {
    expect(isValidVpsIpv4("203.0.113.2")).toBe(true);
    expect(isValidVpsIpv4("999.1.1.1")).toBe(false);
    expect(isValidVpsIpv4("abc")).toBe(false);
    expect(normalizeDnsttDomain("https://t.example.ir/")).toBe("t.example.ir");
    expect(normalizeDnsttDomain("bad domain")).toBeNull();
  });

  it("prints DNS records, installer URL and client commands", () => {
    const text = renderDnsttPackageText("203.0.113.2", "t.example.ir", "https://control.example.com");
    expect(text).toContain("A tns.example.ir → 203.0.113.2");
    expect(text).toContain("NS t.example.ir → tns.example.ir");
    expect(text).toContain("https://control.example.com/api/v1/dnstt/server.sh?vps=203.0.113.2&domain=t.example.ir");
    expect(text).toContain("dnstt-client");
  });

  it("renders the auto-install script and rejects bad params", async () => {
    const script = dnsttServerScript("203.0.113.2", "t.example.ir");
    expect(script).toContain('VPS_IP="203.0.113.2"');
    expect(script).toContain('TUN="t.example.ir"');
    expect(script).toContain("dnstt-server");

    const { env } = createEnv();
    const bad = await serveDnsttScript(
      new Request("https://control.example.com/api/v1/dnstt/server.sh?vps=999.1.1.1&domain=t.example.ir"),
      env,
    );
    expect(bad.status).toBe(400);
    const good = await serveDnsttScript(
      new Request("https://control.example.com/api/v1/dnstt/server.sh?vps=203.0.113.2&domain=t.example.ir"),
      env,
    );
    expect(good.status).toBe(200);
    expect(await good.text()).toContain("systemctl enable --now dnstt");
  });
});

describe("restored bot sections", () => {
  it("keeps the restored sections and drops Cursor, the net-intel hub and the open conns row", () => {
    const callbacks = omniMainMenuKeyboard().inline_keyboard.flat().map((button) => button.callback_data);
    expect(callbacks).toContain("v13:pack");
    expect(callbacks).toContain("v13:dep:new");
    expect(callbacks).toContain("v13:dns");
    expect(callbacks).toContain("v13:dnstt");
    // Removed per owner request; conns lives inside the environment only.
    expect(callbacks).not.toContain("v13:intel");
    expect(callbacks).not.toContain("v13:cursor");
    expect(callbacks).not.toContain("v13:conns");
  });

  it("gives a picked panel its own in-chat token flow instead of a connect form", async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ method: String(url).split("/").pop() ?? "", body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return Response.json({ ok: true, result: true });
    }));
    const { env, statements } = createEnv();
    const response = await handleTelegramWebhook(webhookRequest(callbackQuery("v13:dep-panel:bpb")), env);
    expect(await response.json()).toEqual({ ok: true });
    const edit = calls.find((call) => call.method === "editMessageText");
    expect(String(edit?.body?.["text"])).toContain("اتصال اختصاصی خودِ پنل");
    expect(statements.some((sql) => sql.includes("INSERT INTO telegram_flows"))).toBe(true);
  });

  it("rejects a malformed token in the panel token step and keeps the flow open", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, result: true })));
    const { env } = createEnv({ flowRow: { flow: "panel", step: "panel:token", data: { panel: "bpb", panel_name: "BPB" } } });
    const response = await handleTelegramWebhook(webhookRequest(privateMessage("short")), env);
    const payload = (await response.json()) as { text: string };
    expect(payload.text).toContain("⚠️");
  });

  it("walks the dnstt wizard: vps → domain → package", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, result: true })));
    const { env, statements } = createEnv();
    const start = await handleTelegramWebhook(webhookRequest(callbackQuery("v13:dnstt")), env);
    expect(await start.json()).toEqual({ ok: true });
    expect(statements.some((sql) => sql.includes("INSERT INTO telegram_flows"))).toBe(true);

    const vpsEnv = createEnv({ flowRow: { flow: "dnstt", step: "dnstt:vps", data: {} } }).env;
    const vpsStep = await handleTelegramWebhook(webhookRequest(privateMessage("203.0.113.2")), vpsEnv);
    const vpsPayload = (await vpsStep.json()) as { text: string };
    expect(vpsPayload.text).toContain("ساب‌دامنهٔ تونل");

    const domEnv = createEnv({ flowRow: { flow: "dnstt", step: "dnstt:domain", data: { vps: "203.0.113.2" } } }).env;
    const domStep = await handleTelegramWebhook(webhookRequest(privateMessage("t.example.ir", 1002)), domEnv);
    const domPayload = (await domStep.json()) as { text: string };
    expect(domPayload.text).toContain("پکیج dnstt آماده شد");
    expect(domPayload.text).toContain("/api/v1/dnstt/server.sh?vps=203.0.113.2&domain=t.example.ir");
  });

  it("rejects a bogus VPS IP in the dnstt flow", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, result: true })));
    const vpsEnv = createEnv({ flowRow: { flow: "dnstt", step: "dnstt:vps", data: {} } }).env;
    const response = await handleTelegramWebhook(webhookRequest(privateMessage("999.1.1.1")), vpsEnv);
    const payload = (await response.json()) as { text: string };
    expect(payload.text).toContain("IP معتبر نیست");
  });

  it("ignores the removed Cursor callback entirely", async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ method: String(url).split("/").pop() ?? "", body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return Response.json({ ok: true, result: true });
    }));
    const { env } = createEnv();
    const response = await handleTelegramWebhook(webhookRequest(callbackQuery("v13:cursor")), env);
    expect(await response.json()).toEqual({ ok: true });
    const sent = calls.map((call) => String(call.body?.["text"] ?? "")).join("\n");
    expect(sent).not.toContain("Cursor");
  });
});
