import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OMNI_MENU_TEXT_SATELLITE,
  formatDeploymentStatus,
  handleTelegramWebhook,
  isV13TelegramUpdate,
  omniMainMenuKeyboard,
  parseBotCommand,
} from "../src/telegram";
import type { Env, TelegramUpdate } from "../src/types";

const BOT = "OmniAiGateBot";
const SECRET = "test-webhook-secret";

interface FakeDbOptions {
  updateChanges?: number;
  rateLimited?: boolean;
  deployments?: Array<{ worker_name: string; status: string; node_hostname: string; updated_at: string }>;
}

function createEnv(options: FakeDbOptions = {}): { env: Env; statements: string[] } {
  const statements: string[] = [];
  const DB = {
    prepare(sql: string) {
      statements.push(sql);
      return {
        bind(..._params: unknown[]) {
          return {
            run: async () => ({
              success: true,
              meta: { changes: sql.includes("telegram_updates") ? (options.updateChanges ?? 1) : 1 },
            }),
            first: async <T>() => {
              if (sql.includes("FROM rate_limits")) {
                const now = Math.floor(Date.now() / 1000);
                return { window_started_at: now - (now % 60), hits: options.rateLimited ? 99 : 1 } as unknown as T;
              }
              if (sql.includes("FROM tenants")) return { id: "tenant-1" } as unknown as T;
              return null;
            },
            all: async <T>() => ({ results: (options.deployments ?? []) as unknown as T[] }),
          };
        },
      };
    },
  };
  const env = {
    DB,
    PUBLIC_BASE_URL: "https://control.example.com",
    BOT_USERNAME: BOT,
    LOGIN_LINK_TTL_SECONDS: "900",
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    TELEGRAM_WEBHOOK_SECRET: SECRET,
  } as unknown as Env;
  return { env, statements };
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

  it("issues a one-time login URL for /start v13 and /panel", async () => {
    for (const text of ["/start v13", "/panel"]) {
      const { env } = createEnv();
      const response = await handleTelegramWebhook(webhookRequest(privateMessage(text)), env);
      const payload = await response.json() as { reply_markup: { inline_keyboard: Array<Array<{ url?: string }>> } };
      const url = payload.reply_markup.inline_keyboard[0]?.[0]?.url ?? "";
      expect(url.startsWith("https://control.example.com/login?t=")).toBe(true);
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
    const keyboard = calls[1]?.body.reply_markup as { inline_keyboard: Array<Array<{ url?: string }>> };
    expect(keyboard.inline_keyboard[0]?.[0]?.url?.startsWith("https://control.example.com/login?t=")).toBe(true);
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
});
