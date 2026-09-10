import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OMNI_MENU_TEXT_CLEAN_IP,
  OMNI_MENU_TEXT_DONATE,
  OMNI_MENU_TEXT_SATELLITE,
  faErrorMessage,
  formatDeploymentStatus,
  handleTelegramWebhook,
  isV13TelegramUpdate,
  omniMainMenuKeyboard,
  parseBotCommand,
} from "../src/telegram";
import { HttpError } from "../src/http";
import type { Env, TelegramUpdate } from "../src/types";

const BOT = "OmniAiGateBot";
const SECRET = "test-webhook-secret";

interface FakeDbOptions {
  updateChanges?: number;
  rateLimited?: boolean;
  deployments?: Array<Record<string, string>>;
  wizardRow?: { flow: string; step: string; state_json: string; expires_at: string } | null;
  flowRow?: { flow: string; step: string; state_json: string; expires_at: string } | null;
  telemetryRows?: Array<Record<string, unknown>>;
  insertResults?: Record<string, unknown>;
}

interface CapturedStatement {
  sql: string;
  params: unknown[];
}

function createEnv(options: FakeDbOptions = {}): { env: Env; statements: string[]; executed: CapturedStatement[] } {
  const statements: string[] = [];
  const executed: CapturedStatement[] = [];
  let lastRateWindow: number | null = null;
  const DB = {
    prepare(sql: string) {
      statements.push(sql);
      const record: CapturedStatement = { sql, params: [] };
      return {
        bind(...params: unknown[]) {
          record.params = params;
          return {
            record,
            run: async () => {
              executed.push(record);
              if (sql.includes("INSERT INTO rate_limits")) lastRateWindow = Number(params[1]);
              return {
                success: true,
                meta: { changes: sql.includes("telegram_updates") ? (options.updateChanges ?? 1) : 1 },
              };
            },
            first: async <T>() => {
              executed.push(record);
              if (sql.includes("FROM rate_limits")) {
                const now = Math.floor(Date.now() / 1000);
                return {
                  window_started_at: lastRateWindow ?? now - (now % 60),
                  hits: options.rateLimited ? 99 : 1,
                } as unknown as T;
              }
              if (sql.includes("FROM tenants")) return { id: "tenant-1", display_name: "Ali" } as unknown as T;
              if (sql.includes("FROM telegram_wizards")) return (options.wizardRow ?? null) as unknown as T;
              if (sql.includes("FROM telegram_flows")) return (options.flowRow ?? null) as unknown as T;
              if (sql.includes("COUNT(*)")) return (options.insertResults?.["count"] ?? { count: 0 }) as unknown as T;
              return (options.insertResults?.[sql.slice(0, 24)] ?? null) as unknown as T;
            },
            all: async <T>() => {
              executed.push(record);
              if (sql.includes("FROM deployments")) return { results: (options.deployments ?? []) as unknown as T[] };
              return { results: (options.telemetryRows ?? []) as unknown as T[] };
            },
          };
        },
      };
    },
    batch: async (batchedStatements: Array<{ record?: CapturedStatement }>) => {
      for (const statement of batchedStatements) {
        if (statement?.record) executed.push(statement.record);
      }
      return [];
    },
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
  return { env, statements, executed };
}

function webhookRequest(update: unknown, secret = SECRET): Request {
  return new Request("https://control.example.com/telegram/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
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

afterEach(() => vi.unstubAllGlobals());

describe("omni command parsing", () => {
  it("parses commands, args and same-bot mentions", () => {
    expect(parseBotCommand("/start", BOT)).toEqual({ command: "start", args: [] });
    expect(parseBotCommand("/start v13", BOT)).toEqual({ command: "start", args: ["v13"] });
    expect(parseBotCommand("/panel@OmniAiGateBot", BOT)).toEqual({ command: "panel", args: [] });
    expect(parseBotCommand("/panel@OtherBot", BOT)).toBeNull();
    expect(parseBotCommand("hello", BOT)).toBeNull();
    expect(parseBotCommand("/", BOT)).toBeNull();
    expect(parseBotCommand(undefined, BOT)).toBeNull();
  });

  it("detects V13/Omni-private updates for external routing", () => {
    expect(isV13TelegramUpdate(callbackQuery("v13:login"), BOT)).toBe(true);
    expect(isV13TelegramUpdate(callbackQuery("omni:home"), BOT)).toBe(true);
    expect(isV13TelegramUpdate(callbackQuery("shop:buy"), BOT)).toBe(false);
    expect(isV13TelegramUpdate(privateMessage("/status"), BOT)).toBe(true);
    expect(isV13TelegramUpdate(privateMessage(OMNI_MENU_TEXT_SATELLITE), BOT)).toBe(true);
    expect(isV13TelegramUpdate(privateMessage("/unknown"), BOT)).toBe(false);
    expect(isV13TelegramUpdate(privateMessage("free text"), BOT)).toBe(false);
  });

  it("exposes the dedicated private-environment button in the main menu", () => {
    const keyboard = omniMainMenuKeyboard();
    const flat = keyboard.inline_keyboard.flat();
    expect(flat).toContainEqual({ text: "🛰️ ورود به محیط اختصاصی V13", callback_data: "v13:login" });
  });

  it("formats deployment status in Persian without secrets", () => {
    expect(formatDeploymentStatus([])).toContain("هنوز استقراری ندارید");
    const text = formatDeploymentStatus([
      { worker_name: "v13-node", status: "ready", node_hostname: "node.example.com", updated_at: "2026-09-10T00:00:00.000Z" },
      { worker_name: "v13-old", status: "failed", node_hostname: "old.example.com", updated_at: "2026-09-09T00:00:00.000Z" },
    ]);
    expect(text).toContain("v13-node");
    expect(text).toContain("فعال ✅");
    expect(text).toContain("ناموفق ❌");
    expect(text).not.toContain("token");
  });
});

describe("omni telegram webhook", () => {
  it("rejects a wrong webhook secret", async () => {
    const { env } = createEnv();
    await expect(handleTelegramWebhook(webhookRequest(privateMessage("/start"), "wrong"), env)).rejects.toThrow(
      "Unauthorized",
    );
  });

  it("ignores duplicate updates without issuing a login link", async () => {
    const { env, statements } = createEnv({ updateChanges: 0 });
    const response = await handleTelegramWebhook(webhookRequest(privateMessage("/panel")), env);
    expect(await response.json()).toEqual({ ok: true });
    expect(statements.some((sql) => sql.includes("login_links"))).toBe(false);
  });

  it("ignores non-private chats", async () => {
    const { env } = createEnv();
    const update: TelegramUpdate = {
      update_id: 3001,
      message: { message_id: 1, chat: { id: -100, type: "group" }, from: { id: 555, is_bot: false, first_name: "Ali" }, text: "/start" },
    };
    const response = await handleTelegramWebhook(webhookRequest(update), env);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("answers /start with the Omni main menu", async () => {
    const { env } = createEnv();
    const response = await handleTelegramWebhook(webhookRequest(privateMessage("/start")), env);
    const payload = await response.json() as { method: string; reply_markup: { inline_keyboard: Array<Array<{ callback_data?: string }>> } };
    expect(payload.method).toBe("sendMessage");
    expect(payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data)).toContain("v13:login");
  });

  it("issues in-Telegram and browser login URLs for /start v13 and /panel", async () => {
    for (const text of ["/start v13", "/panel"]) {
      const { env } = createEnv();
      const response = await handleTelegramWebhook(webhookRequest(privateMessage(text)), env);
      const payload = await response.json() as {
        reply_markup: { inline_keyboard: Array<Array<{ url?: string; web_app?: { url: string } }>> };
      };
      const rows = payload.reply_markup.inline_keyboard;
      expect(rows[0]?.[0]?.web_app?.url?.startsWith("https://control.example.com/login?t=")).toBe(true);
      expect(rows[1]?.[0]?.url?.startsWith("https://control.example.com/login?t=")).toBe(true);
      expect(rows[0]?.[0]?.web_app?.url).not.toBe(rows[1]?.[0]?.url);
    }
  });

  it("reports deployment status for /status", async () => {
    const { env } = createEnv({
      deployments: [{ worker_name: "v13-node", status: "awaiting_agent", node_hostname: "node.example.com", updated_at: "2026-09-10T00:00:00.000Z" }],
    });
    const response = await handleTelegramWebhook(webhookRequest(privateMessage("/status")), env);
    const payload = await response.json() as { text: string };
    expect(payload.text).toContain("v13-node");
    expect(payload.text).toContain("در انتظار نصب روی VPS");
  });

  it("rate-limits fast senders", async () => {
    const { env } = createEnv({ rateLimited: true });
    const response = await handleTelegramWebhook(webhookRequest(privateMessage("/start")), env);
    const payload = await response.json() as { text: string };
    expect(payload.text).toContain("خیلی سریع");
  });

  it("forwards unknown commands to the external Omni worker when configured", async () => {
    const { env } = createEnv();
    env.OMNI_FALLBACK_URL = "https://omni.example.com/telegram/webhook";
    env.OMNI_FALLBACK_SECRET = "omni-secret";
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await handleTelegramWebhook(webhookRequest(privateMessage("/shop")), env);
    expect(await response.json()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://omni.example.com/telegram/webhook");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer omni-secret");
  });

  it("answers unknown commands with the menu when no fallback is configured", async () => {
    const { env } = createEnv();
    const response = await handleTelegramWebhook(webhookRequest(privateMessage("/shop")), env);
    const payload = await response.json() as { text: string; reply_markup: object };
    expect(payload.text).toContain("منوی اصلی");
    expect(payload.reply_markup).toBeDefined();
  });

  it("handles the login callback with answerCallbackQuery plus a URL button", async () => {
    const { env } = createEnv();
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return Response.json({ ok: true, result: true });
      }),
    );
    const response = await handleTelegramWebhook(webhookRequest(callbackQuery("v13:login")), env);
    expect(await response.json()).toEqual({ ok: true });
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.telegram.org/bottest-bot-token/answerCallbackQuery",
      "https://api.telegram.org/bottest-bot-token/sendMessage",
    ]);
    const keyboard = calls[1]?.body.reply_markup as {
      inline_keyboard: Array<Array<{ url?: string; web_app?: { url: string } }>>;
    };
    expect(keyboard.inline_keyboard[0]?.[0]?.web_app?.url?.startsWith("https://control.example.com/login?t=")).toBe(true);
    expect(keyboard.inline_keyboard[1]?.[0]?.url?.startsWith("https://control.example.com/login?t=")).toBe(true);
  });

  it("handles the status callback by editing the menu message", async () => {
    const { env } = createEnv({
      deployments: [{ worker_name: "v13-node", status: "ready", node_hostname: "node.example.com", updated_at: "2026-09-10T00:00:00.000Z" }],
    });
    const methods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        methods.push(url.split("/").pop() ?? "");
        return Response.json({ ok: true, result: true });
      }),
    );
    const response = await handleTelegramWebhook(webhookRequest(callbackQuery("v13:status")), env);
    expect(await response.json()).toEqual({ ok: true });
    expect(methods).toEqual(["answerCallbackQuery", "editMessageText"]);
  });

  it("routes wizard callbacks and /cancel to the V13 section", () => {
    expect(isV13TelegramUpdate(callbackQuery("wiz:conn:11111111-1111-4111-8111-111111111111"), BOT)).toBe(true);
    expect(isV13TelegramUpdate(privateMessage("/cancel"), BOT)).toBe(true);
  });

  it("cancels an in-progress wizard with /cancel", async () => {
    const { env, statements } = createEnv();
    const response = await handleTelegramWebhook(webhookRequest(privateMessage("/cancel")), env);
    const payload = await response.json() as { text: string };
    expect(payload.text).toContain("لغو شد");
    expect(statements.some((sql) => sql.includes("DELETE FROM telegram_wizards"))).toBe(true);
  });

  it("lists deployments from the native menu text", async () => {
    const { env } = createEnv({
      deployments: [{
        id: "11111111-1111-4111-8111-111111111111",
        worker_name: "v13-node",
        status: "ready",
        node_hostname: "node.example.com",
        updated_at: "2026-09-10T00:00:00.000Z",
      }],
    });
    const response = await handleTelegramWebhook(webhookRequest(privateMessage("📦 استقرارها")), env);
    const payload = await response.json() as {
      reply_markup: { inline_keyboard: Array<Array<{ callback_data?: string }>> };
    };
    const callbacks = payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
    expect(callbacks).toContain("v13:dep:11111111-1111-4111-8111-111111111111");
    expect(callbacks).toContain("v13:dep:new");
  });

  it("feeds free text into the active wizard step", async () => {
    const { env } = createEnv({
      wizardRow: {
        flow: "deploy",
        step: "workerName",
        state_json: JSON.stringify({
          connectionId: "11111111-1111-4111-8111-111111111111",
          connectionName: "example.com",
          accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          accountName: "Example",
          zoneId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          zoneName: "example.com",
        }),
        expires_at: "2099-01-01T00:00:00.000Z",
      },
    });
    const response = await handleTelegramWebhook(webhookRequest(privateMessage("v13-test")), env);
    const payload = await response.json() as { text: string };
    expect(payload.text).toContain("قدم ۲");
    expect(payload.text).toContain("example.com");
  });

  it("rejects invalid wizard input and stays on the same step", async () => {
    const { env } = createEnv({
      wizardRow: {
        flow: "deploy",
        step: "workerName",
        state_json: JSON.stringify({
          connectionId: "11111111-1111-4111-8111-111111111111",
          accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          zoneId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          zoneName: "example.com",
        }),
        expires_at: "2099-01-01T00:00:00.000Z",
      },
    });
    const response = await handleTelegramWebhook(webhookRequest(privateMessage("BAD NAME!!")), env);
    const payload = await response.json() as { text: string };
    expect(payload.text).toContain("معتبر نیست");
    expect(payload.text).toContain("قدم ۱");
  });

  it("maps worker errors to Persian, with reconnect as a special case", () => {
    expect(faErrorMessage(new HttpError(409, "deployment_resource_conflict", "taken"))).toContain("قبلاً استفاده شده");
    expect(faErrorMessage(new HttpError(409, "cloudflare_reconnect_required", "reconnect"))).toBeNull();
    expect(faErrorMessage(new HttpError(409, "cloudflare_connection_busy", "busy"))).toContain("استقرار فعال");
    expect(faErrorMessage(new Error("boom"))).toContain("خطای موقت");
  });
});

describe("ported panel sections in the bot", () => {
  it("adds the ported sections to the main menu", () => {
    const callbacks = omniMainMenuKeyboard().inline_keyboard.flat().map((button) => button.callback_data);
    expect(callbacks).toContain("v13:ip");
    expect(callbacks).toContain("v13:map");
    expect(callbacks).toContain("v13:wh");
    expect(callbacks).toContain("v13:donate");
    expect(callbacks).toContain("v13:health");
    expect(callbacks).toContain("v13:usage");
  });

  it("treats the new plain-text menu labels as V13 updates", () => {
    expect(isV13TelegramUpdate(privateMessage(OMNI_MENU_TEXT_CLEAN_IP), BOT)).toBe(true);
    expect(isV13TelegramUpdate(privateMessage(OMNI_MENU_TEXT_DONATE), BOT)).toBe(true);
    expect(isV13TelegramUpdate(privateMessage("/cleanip"), BOT)).toBe(true);
    expect(isV13TelegramUpdate(callbackQuery("v13:ip:irancell:tehran"), BOT)).toBe(true);
  });

  it("renders the clean-IP radar with honest no-data rows", async () => {
    const { env } = createEnv();
    const response = await handleTelegramWebhook(webhookRequest(privateMessage("/cleanip")), env);
    const payload = await response.json() as { text: string; parse_mode?: string; reply_markup: { inline_keyboard: Array<Array<{ callback_data?: string }>> } };
    expect(payload.parse_mode).toBe("HTML");
    expect(payload.text).toContain("رادار IP تمیز");
    expect(payload.text).toContain("بدون داده");
    expect(payload.text).not.toMatch(/undefined|null/u);
    const callbacks = payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
    expect(callbacks).toContain("v13:ip:mci:tehran");
    expect(callbacks).toContain("v13:ip:report:mci:tehran");
    expect(callbacks).toContain("v13:wh");
  });

  it("switches operator and city through callbacks", async () => {
    const { env } = createEnv();
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ method: url.split("/").pop() ?? "", body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return Response.json({ ok: true, result: true });
    }));
    const response = await handleTelegramWebhook(webhookRequest(callbackQuery("v13:ip:irancell:shiraz")), env);
    expect(await response.json()).toEqual({ ok: true });
    const edit = calls.find((call) => call.method === "editMessageText");
    expect(String(edit?.body?.text)).toContain("ایرانسل");
    expect(String(edit?.body?.text)).toContain("شیراز");
  });

  it("starts the report flow from the radar and keeps it cancellable", async () => {
    const { env, statements } = createEnv();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, result: true })));
    const response = await handleTelegramWebhook(webhookRequest(callbackQuery("v13:ip:pick:185.143.232.1:mci:tehran")), env);
    expect(await response.json()).toEqual({ ok: true });
    expect(statements.some((sql) => sql.includes("INSERT INTO telegram_flows"))).toBe(true);
    expect(statements.some((sql) => sql.includes("DELETE FROM telegram_flows"))).toBe(false);

    const cancelResponse = await handleTelegramWebhook(webhookRequest(callbackQuery("v13:flow:cancel", 2002)), env);
    expect(await cancelResponse.json()).toEqual({ ok: true });
    expect(statements.some((sql) => sql.includes("DELETE FROM telegram_flows"))).toBe(true);
  });

  it("stores a crowd report from the pending flow without inventing numbers", async () => {
    const { env, executed } = createEnv({
      flowRow: {
        flow: "rum",
        step: "rum:loss",
        state_json: JSON.stringify({ ip: "185.143.232.1", operator: "mci", city: "tehran", latencyMs: "38" }),
        expires_at: "2099-01-01T00:00:00.000Z",
      },
    });
    const sendMessageBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sendMessageBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ ok: true, result: true });
    }));
    const response = await handleTelegramWebhook(webhookRequest(privateMessage("2")), env);
    const payload = await response.json() as { text: string };
    expect(payload.text).toContain("رادار IP تمیز");
    const insert = executed.find((item) => item.sql.includes("INSERT INTO clean_ip_reports"));
    expect(insert?.params[0]).toBe("185.143.232.1");
    expect(insert?.params[1]).toBe("mci");
    expect(insert?.params[3]).toBe(38);
    expect(String(sendMessageBodies[0]?.text)).toContain("ثبت شد");
  });

  it("refuses a bogus IP report and closes the flow", async () => {
    const { env } = createEnv({
      flowRow: {
        flow: "rum",
        step: "rum:loss",
        state_json: JSON.stringify({ ip: "999.1.1.1", operator: "mci", city: "tehran", latencyMs: "38" }),
        expires_at: "2099-01-01T00:00:00.000Z",
      },
    });
    const response = await handleTelegramWebhook(webhookRequest(privateMessage("abc")), env);
    const payload = await response.json() as { text: string };
    expect(payload.text).toContain("معتبر نیست");
  });

  it("renders the censorship map from anonymous reports only", async () => {
    const { env } = createEnv({
      telemetryRows: [
        { isp: "همراه‌اول", city: "تهران", transport: "hysteria2", n: 4, ok_count: 4, rtts: "40,42,44" },
        { isp: "ایرانسل", city: "شیراز", transport: "hysteria2", n: 5, ok_count: 0, rtts: null },
      ],
    });
    const response = await handleTelegramWebhook(webhookRequest(privateMessage("/map")), env);
    const payload = await response.json() as { text: string; parse_mode?: string };
    expect(payload.text).toContain("سانسور");
    expect(payload.text).toContain("🔴 بسته");
    expect(payload.text).toContain("🟢 باز");
    expect(payload.parse_mode).toBe("HTML");
  });

  it("shows the donation consent screen before any key is accepted", async () => {
    const { env, statements } = createEnv();
    const response = await handleTelegramWebhook(webhookRequest(privateMessage("/donate")), env);
    const payload = await response.json() as { text: string; reply_markup: { inline_keyboard: Array<Array<{ callback_data?: string }>> } };
    expect(payload.text).toContain("صف بازبینی");
    expect(payload.text).toContain("رمزنگاری");
    const callbacks = payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
    expect(callbacks).toContain("v13:donate:agree");
    expect(callbacks).not.toContain("v13:donate:review");
    expect(statements.some((sql) => sql.includes("ai_donations"))).toBe(false);
  });

  it("accepts a donated key, stores ciphertext and never echoes the key back", async () => {
    const rawKey = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
    const { env, executed } = createEnv({
      flowRow: {
        flow: "donate",
        step: "donate:key",
        state_json: "{}",
        expires_at: "2099-01-01T00:00:00.000Z",
      },
    });
    const response = await handleTelegramWebhook(webhookRequest(privateMessage(rawKey)), env);
    const payload = await response.json() as { text: string };
    expect(payload.text).toContain("کلید ثبت شد");
    expect(payload.text).toContain("sk-…7890");
    expect(payload.text).not.toContain(rawKey);
    const insert = executed.find((item) => item.sql.includes("INSERT INTO ai_donations"));
    expect(insert).toBeDefined();
    expect(JSON.stringify(insert?.params)).not.toContain(rawKey);
    const secret = executed.find((item) => item.sql.includes("INSERT INTO ai_donation_secrets"));
    expect(String(secret?.params[1])).toContain("v2.");
    expect(JSON.stringify(secret?.params)).not.toContain(rawKey);
  });

  it("rejects a too-short key without creating a donation row", async () => {
    const { env, executed } = createEnv({
      flowRow: {
        flow: "donate",
        step: "donate:key",
        state_json: "{}",
        expires_at: "2099-01-01T00:00:00.000Z",
      },
    });
    const response = await handleTelegramWebhook(webhookRequest(privateMessage("sk-short")), env);
    const payload = await response.json() as { text: string };
    expect(payload.text).toContain("⚠️");
    expect(executed.some((item) => item.sql.includes("INSERT INTO ai_donations"))).toBe(false);
  });

  it("keeps donation review admin-only", async () => {
    const { env } = createEnv();
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ method: url.split("/").pop() ?? "", body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return Response.json({ ok: true, result: true });
    }));
    await handleTelegramWebhook(webhookRequest(callbackQuery("v13:donate:review")), env);
    const answer = calls.find((call) => call.method === "answerCallbackQuery");
    expect(String(answer?.body?.text)).toContain("فقط ادمین");
    expect(answer?.body?.show_alert).toBe(true);

    const adminEnv = createEnv();
    adminEnv.env.ADMIN_TELEGRAM_IDS = "555";
    await handleTelegramWebhook(webhookRequest(callbackQuery("v13:donate:review", 2003)), adminEnv.env);
  });

  it("reports node health and usage from real counts", async () => {
    const { env } = createEnv({
      deployments: [{
        id: "11111111-1111-4111-8111-111111111111",
        worker_name: "v13-node",
        status: "ready",
        node_hostname: "node.example.com",
        vps_ipv4: "1.2.3.4",
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
    });
    const health = await handleTelegramWebhook(webhookRequest(privateMessage("/health")), env);
    const healthPayload = await health.json() as { text: string };
    expect(healthPayload.text).toContain("v13-node");
    expect(healthPayload.text).toContain("گزارش سلامت تازه دارد");
    expect(healthPayload.text).toContain("اندازه‌گیری ترافیک");

    const usage = await handleTelegramWebhook(webhookRequest(privateMessage("/usage")), env);
    const usagePayload = await usage.json() as { text: string };
    expect(usagePayload.text).toContain("استقرارها: 0");
    expect(usagePayload.text).not.toMatch(/15k|100k/);
  });

  it("shows the WhiteHole section and explains the no-secret rule", async () => {
    const { env } = createEnv();
    const response = await handleTelegramWebhook(webhookRequest(privateMessage("/whitehole")), env);
    const payload = await response.json() as { text: string; reply_markup: { inline_keyboard: Array<Array<{ callback_data?: string }>> } };
    expect(payload.text).toContain("هددراپ");
    expect(payload.text).toContain("هیچ لینک اشتراک");
    const callbacks = payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
    expect(callbacks).toContain("v13:wh:publish");
    expect(callbacks).toContain("v13:wh:clear");
  });

  it("asks for a Cloudflare connection before publishing a drop", async () => {
    const { env } = createEnv();
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ method: url.split("/").pop() ?? "", body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return Response.json({ ok: true, result: true });
    }));
    await handleTelegramWebhook(webhookRequest(callbackQuery("v13:wh:publish")), env);
    const edit = calls.find((call) => call.method === "sendMessage" || call.method === "editMessageText");
    expect(String(edit?.body?.text)).toContain("اتصال Cloudflare");
  });
});
