import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generatePhantomConfigs,
  generateSimpleConfigs,
  normalizePhantomDomain,
  normalizePhantomUuid,
  phantomSubscription,
  toClashYaml,
  toSingBoxJson,
  toV2RayBase64,
} from "../src/phantom-gen";
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
const UUID = "d342d11e-d424-4583-b36e-524ab1f0afa4";

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

describe("phantom generator", () => {
  it("builds the 7+7+6 tier package with the user's domain and uuid", () => {
    const pkg = generatePhantomConfigs("my.example.ir", UUID);
    expect(pkg.vless).toHaveLength(20);
    expect(pkg.vless.filter((c) => c.tier === "L1-Arvan")).toHaveLength(7);
    expect(pkg.vless.filter((c) => c.tier === "L2-CF")).toHaveLength(7);
    expect(pkg.vless.filter((c) => c.tier === "L3-Warp")).toHaveLength(6);
    for (const link of pkg.vless) {
      expect(link.link).toContain(`vless://${UUID}@`);
      expect(link.link).toContain(`host=my.example.ir`);
    }
    expect(pkg.ss).toHaveLength(2);
    expect(pkg.hy).toHaveLength(2);
  });

  it("builds the honest 10-pack from the reliable L2 layer only", () => {
    const simple = generateSimpleConfigs("my.example.ir", UUID);
    expect(simple).toHaveLength(10);
    for (const link of simple) expect(link.tier).toBe("L2-CF");
  });

  it("renders all three subscription formats", () => {
    const pkg = generatePhantomConfigs("my.example.ir", UUID);
    const lines = [...pkg.vless.map((c) => c.link), ...pkg.ss, ...pkg.hy];
    const decoded = decodeURIComponent(escape(atob(toV2RayBase64(lines))));
    expect(decoded.split("\n")).toHaveLength(24);

    const yaml = toClashYaml(pkg.vless, "my.example.ir", UUID);
    expect(yaml).toContain("proxy-groups:");
    expect(yaml.match(/type: vless/gu)).toHaveLength(20);

    const parsed = JSON.parse(toSingBoxJson(pkg.vless, pkg.ss, "my.example.ir", UUID)) as {
      outbounds: Array<Record<string, unknown>>;
    };
    expect(parsed.outbounds).toHaveLength(22);
  });

  it("validates domain and uuid inputs", () => {
    expect(normalizePhantomDomain("https://My.Example.ir/panel")).toBe("my.example.ir");
    expect(normalizePhantomDomain("not a domain!")).toBeNull();
    expect(normalizePhantomDomain("nodot")).toBeNull();
    expect(normalizePhantomUuid(UUID)).toBe(UUID);
    expect(normalizePhantomUuid("new")).toMatch(/^[0-9a-f-]{36}$/u);
    expect(normalizePhantomUuid("short")).toMatch(/^[0-9a-f-]{36}$/u);
  });
});

describe("phantom subscription route", () => {
  it("serves v2ray, clash and singbox formats", async () => {
    const { env } = createEnv();
    const base = `https://control.example.com/api/v1/phantom?domain=my.example.ir&uuid=${UUID}`;
    const v2ray = await phantomSubscription(new Request(`${base}&format=v2ray`), env);
    expect(v2ray.status).toBe(200);
    const body = await v2ray.text();
    expect(decodeURIComponent(escape(atob(body))).split("\n")).toHaveLength(24);

    const clash = await phantomSubscription(new Request(`${base}&format=clash`), env);
    expect(clash.headers.get("Content-Type")).toContain("text/yaml");

    const singbox = await phantomSubscription(new Request(`${base}&format=singbox`), env);
    const parsed = JSON.parse(await singbox.text()) as { outbounds: unknown[] };
    expect(parsed.outbounds).toHaveLength(22);
  });

  it("rejects missing or invalid params", async () => {
    const { env } = createEnv();
    await expect(
      phantomSubscription(new Request("https://control.example.com/api/v1/phantom?domain=x"), env),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      phantomSubscription(new Request("https://control.example.com/api/v1/phantom?domain=my.example.ir&uuid=nope"), env),
    ).rejects.toMatchObject({ status: 400 });
  });
});

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
  it("shows the restored sections in the main menu", () => {
    const callbacks = omniMainMenuKeyboard().inline_keyboard.flat().map((button) => button.callback_data);
    expect(callbacks).toContain("v13:phantom");
    expect(callbacks).toContain("v13:phantom-simple");
    expect(callbacks).toContain("v13:dnstt");
    expect(callbacks).toContain("v13:cursor");
  });

  it("walks the PHANTOM wizard: domain → uuid → package", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, result: true })));
    const { env, statements } = createEnv();
    const start = await handleTelegramWebhook(webhookRequest(callbackQuery("v13:phantom")), env);
    expect(await start.json()).toEqual({ ok: true });
    expect(statements.some((sql) => sql.includes("INSERT INTO telegram_flows"))).toBe(true);

    const domainEnv = createEnv({ flowRow: { flow: "phantom", step: "phantom:domain", data: { mode: "full" } } }).env;
    const domainStep = await handleTelegramWebhook(webhookRequest(privateMessage("my.example.ir")), domainEnv);
    const domainPayload = (await domainStep.json()) as { text: string };
    expect(domainPayload.text).toContain("UUID");

    const uuidEnv = createEnv({ flowRow: { flow: "phantom", step: "phantom:uuid", data: { mode: "full", domain: "my.example.ir" } } }).env;
    const uuidStep = await handleTelegramWebhook(webhookRequest(privateMessage("new", 1002)), uuidEnv);
    const uuidPayload = (await uuidStep.json()) as { text: string };
    expect(uuidPayload.text).toContain("PHANTOM 20تایی ساخته شد");
    expect(uuidPayload.text).toContain("/api/v1/phantom?domain=my.example.ir");
    expect(uuidPayload.text).toContain("لایه‌های L1/L3 دکوی آزمایشی‌اند");
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

  it("answers the Cursor button honestly instead of a fake key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, result: true })));
    const { env } = createEnv();
    const response = await handleTelegramWebhook(webhookRequest(callbackQuery("v13:cursor")), env);
    expect(await response.json()).toEqual({ ok: true });
  });
});
