import { audit, rateLimit } from "./db";
import { HttpError, json, readJson } from "./http";
import { addSecondsIso, constantTimeEqual, nowIso, parsePositiveInt, randomToken, sha256 } from "./security";
import type {
  Env,
  TelegramCallbackQuery,
  TelegramFrom,
  TelegramInlineKeyboard,
  TelegramUpdate,
} from "./types";

interface TelegramApiResponse {
  ok: boolean;
  description?: string;
}

const TELEGRAM_RATE_LIMIT = 12;
const TELEGRAM_RATE_WINDOW_SECONDS = 60;

/** Commands owned by the V13 / Omni-private section of the bot. */
export const V13_COMMANDS = ["start", "panel", "status", "help"] as const;
export type V13Command = (typeof V13_COMMANDS)[number];

/** Deep-link arguments (`/start <arg>`) that open the V13 private environment directly. */
export const V13_DEEP_LINK_ARGS: ReadonlySet<string> = new Set(["v13", "panel", "app", "omni"]);

/** Plain-text menu labels accepted as equivalents of the inline buttons. */
export const OMNI_MENU_TEXT_SATELLITE = "🛰️ محیط اختصاصی V13";
export const OMNI_MENU_TEXT_STATUS = "📊 وضعیت استقرارها";
export const OMNI_MENU_TEXT_HELP = "❓ راهنما";
export const OMNI_MENU_TEXT_HOME = "🏠 منوی اصلی";
export const OMNI_MENU_TEXTS: ReadonlySet<string> = new Set([
  OMNI_MENU_TEXT_SATELLITE,
  OMNI_MENU_TEXT_STATUS,
  OMNI_MENU_TEXT_HELP,
  OMNI_MENU_TEXT_HOME,
]);

const STATUS_FA: Record<string, string> = {
  queued: "در صف",
  preparing: "در حال آماده‌سازی",
  awaiting_agent: "در انتظار نصب روی VPS",
  agent_ready: "نصب شد؛ در حال نهایی‌سازی",
  finalizing: "در حال نهایی‌سازی",
  ready: "فعال ✅",
  revoking: "در حال ابطال",
  failed: "ناموفق ❌",
  revoked: "باطل‌شده",
};

export interface ParsedBotCommand {
  command: string;
  args: string[];
}

/** Parse `/command@bot arg1 arg2`. Returns null for non-commands or mentions of another bot. */
export function parseBotCommand(text: string | undefined, botUsername: string): ParsedBotCommand | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [head = "", ...args] = trimmed.split(/\s+/u);
  const at = head.indexOf("@");
  const command = (at === -1 ? head : head.slice(0, at)).slice(1).toLowerCase();
  const mention = at === -1 ? "" : head.slice(at + 1);
  if (!command) return null;
  if (mention && mention.toLowerCase() !== botUsername.toLowerCase()) return null;
  return { command, args };
}

/**
 * True when an update belongs to the V13 / Omni-private section.
 * An external Omni worker can use this to decide which updates to forward here.
 */
export function isV13TelegramUpdate(update: TelegramUpdate, botUsername: string): boolean {
  const data = update.callback_query?.data ?? "";
  if (data.startsWith("v13:") || data.startsWith("omni:")) return true;
  const text = update.message?.text ?? "";
  const parsed = parseBotCommand(text, botUsername);
  if (parsed && (V13_COMMANDS as readonly string[]).includes(parsed.command)) return true;
  if (OMNI_MENU_TEXTS.has(text.trim())) return true;
  return false;
}

/** Main Omni menu: one dedicated button enters the V13 private environment. */
export function omniMainMenuKeyboard(): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: "🛰️ ورود به محیط اختصاصی V13", callback_data: "v13:login" }],
      [
        { text: "📊 وضعیت استقرارها", callback_data: "v13:status" },
        { text: "❓ راهنما", callback_data: "v13:help" },
      ],
    ],
  };
}

export function omniBackMenuKeyboard(): TelegramInlineKeyboard {
  return {
    inline_keyboard: [[{ text: "🏠 منوی اصلی Omni", callback_data: "omni:home" }]],
  };
}

export function omniWelcomeText(): string {
  return [
    "به دروازهٔ Omni × V13 خوش آمدید 👋",
    "",
    "🛰️ «محیط اختصاصی V13» کنترل‌پلین امن زیرساخت شماست: اتصال موقت Cloudflare، ساخت نود واقعی (VLESS + Hysteria2) و اشتراک خصوصی.",
    "",
    "برای ورود، دکمهٔ زیر را بزنید — یک لینک یک‌بارمصرف برای شما ساخته می‌شود و با همان دکمه وارد محیط می‌شوید.",
    "",
    "⚠️ هیچ API Token یا رمز سروری را در چت ارسال نکنید.",
  ].join("\n");
}

export function omniLoginText(ttlMinutes: number): string {
  return [
    "🔐 لینک یک‌بارمصرف محیط اختصاصی آماده است.",
    "",
    `این لینک ${ttlMinutes} دقیقه اعتبار دارد و بعد از اولین استفاده باطل می‌شود.`,
    "دکمهٔ زیر را بزنید تا وارد محیط شوید 👇",
  ].join("\n");
}

export function omniHelpText(): string {
  return [
    "❓ راهنمای محیط اختصاصی V13",
    "",
    "/start — منوی اصلی Omni",
    "/panel — دریافت لینک ورود به محیط اختصاصی",
    "/status — وضعیت استقرارها (بدون نمایش secret)",
    "/help — همین راهنما",
    "",
    "ورود همیشه با لینک یک‌بارمصرف و کوتاه‌عمر انجام می‌شود.",
    "Cloudflare API Token را فقط داخل فرم HTTPS پنل وارد کنید، هرگز در چت.",
  ].join("\n");
}

export function omniUnknownCommandText(): string {
  return "این دستور برای من آشنا نیست. از دکمه‌های منوی اصلی استفاده کنید 👇";
}

export function omniFreeTextReply(): string {
  return [
    "پیام متنی شما ذخیره نمی‌شود.",
    "اگر API Token یا رمزی ارسال کرده‌اید، همین حالا آن را در سرویس مبدأ بچرخانید یا حذف کنید.",
    "برای ادامه از دکمه‌های منو استفاده کنید 👇",
  ].join("\n");
}

export interface DeploymentStatusRow {
  worker_name: string;
  status: string;
  node_hostname: string;
  updated_at: string;
}

export function formatDeploymentStatus(rows: DeploymentStatusRow[]): string {
  if (rows.length === 0) {
    return [
      "📊 هنوز استقراری ندارید.",
      "",
      "از «ورود به محیط اختصاصی V13» وارد شوید و اولین نود واقعی را بسازید.",
    ].join("\n");
  }
  const lines = rows.map((row) => {
    const statusFa = STATUS_FA[row.status] ?? row.status;
    return `• ${row.worker_name} — ${statusFa}\n  ${row.node_hostname}`;
  });
  return ["📊 وضعیت استقرارهای شما:", "", ...lines, "", "جزئیات امن و اشتراک‌ها فقط داخل پنل نمایش داده می‌شوند."].join("\n");
}

async function ensureTenant(env: Env, from: TelegramFrom): Promise<{ id: string }> {
  const now = nowIso();
  const tenantId = crypto.randomUUID();
  const displayName = [from.first_name, from.last_name].filter(Boolean).join(" ").slice(0, 120);
  await env.DB.prepare(
    `INSERT INTO tenants (id, telegram_user_id, telegram_username, display_name, locale, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET
       telegram_username = excluded.telegram_username,
       display_name = excluded.display_name,
       locale = excluded.locale,
       updated_at = excluded.updated_at`,
  ).bind(tenantId, String(from.id), from.username ?? null, displayName, from.language_code ?? null, now, now).run();
  const tenant = await env.DB.prepare("SELECT id FROM tenants WHERE telegram_user_id = ?")
    .bind(String(from.id)).first<{ id: string }>();
  if (!tenant) throw new Error("Tenant upsert failed");
  return tenant;
}

async function issueLoginLink(env: Env, tenantId: string): Promise<{ loginUrl: string; ttlMinutes: number }> {
  const rawLinkToken = randomToken(32);
  const tokenHash = await sha256(rawLinkToken);
  const ttl = parsePositiveInt(env.LOGIN_LINK_TTL_SECONDS, 900, 3600);
  await env.DB.prepare(
    "INSERT INTO login_links (token_hash, tenant_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
  ).bind(tokenHash, tenantId, addSecondsIso(ttl), nowIso()).run();
  const loginUrl = `${new URL(env.PUBLIC_BASE_URL).origin}/login?t=${encodeURIComponent(rawLinkToken)}`;
  return { loginUrl, ttlMinutes: Math.max(1, Math.floor(ttl / 60)) };
}

async function listRecentDeployments(env: Env, tenantId: string): Promise<DeploymentStatusRow[]> {
  const rows = await env.DB.prepare(
    "SELECT worker_name, status, node_hostname, updated_at FROM deployments WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT 10",
  ).bind(tenantId).all<DeploymentStatusRow>();
  return rows.results ?? [];
}

async function telegramApi(env: Env, method: string, payload: Record<string, unknown>): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json<TelegramApiResponse>().catch(() => ({ ok: false as const }));
  if (!response.ok || !result.ok) throw new Error(`Telegram API request failed: ${response.status} ${method}`);
}

function webhookSend(chatId: number, text: string, replyMarkup?: TelegramInlineKeyboard): Response {
  return json({
    method: "sendMessage",
    chat_id: chatId,
    text,
    protect_content: true,
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

/**
 * Forward updates that do NOT belong to V13 to an external Omni worker.
 * Returns true when a fallback is configured and accepted the update.
 */
async function forwardToOmni(env: Env, update: TelegramUpdate): Promise<boolean> {
  const target = (env.OMNI_FALLBACK_URL ?? "").trim();
  if (!target) return false;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.OMNI_FALLBACK_SECRET) headers.Authorization = `Bearer ${env.OMNI_FALLBACK_SECRET}`;
  try {
    const response = await fetch(target, { method: "POST", headers, body: JSON.stringify(update) });
    return response.ok;
  } catch {
    return false;
  }
}

async function sendLoginLinkMessage(
  env: Env,
  chatId: number,
  tenantId: string,
  telegramUserId: string,
): Promise<Response> {
  const { loginUrl, ttlMinutes } = await issueLoginLink(env, tenantId);
  await audit(env, {
    tenantId,
    actorType: "telegram",
    actorId: telegramUserId,
    action: "login_link.create",
    outcome: "success",
  });
  return webhookSend(chatId, omniLoginText(ttlMinutes), {
    inline_keyboard: [
      [{ text: "🛰️ ورود به محیط اختصاصی", url: loginUrl }],
      [{ text: OMNI_MENU_TEXT_STATUS, callback_data: "v13:status" }],
    ],
  });
}

async function sendStatusMessage(env: Env, chatId: number, tenantId: string): Promise<Response> {
  const rows = await listRecentDeployments(env, tenantId);
  const keyboard: TelegramInlineKeyboard = rows.length === 0
    ? omniMainMenuKeyboard()
    : {
      inline_keyboard: [
        [{ text: "🛰️ ورود به محیط اختصاصی V13", callback_data: "v13:login" }],
        [{ text: "🏠 منوی اصلی Omni", callback_data: "omni:home" }],
      ],
    };
  return webhookSend(chatId, formatDeploymentStatus(rows), keyboard);
}

async function handleMessageUpdate(update: TelegramUpdate, env: Env): Promise<Response> {
  const message = update.message;
  const user = message?.from;
  if (!message || !user || user.is_bot || message.chat.type !== "private" || String(message.chat.id) !== String(user.id)) {
    return json({ ok: true });
  }
  const allowed = await rateLimit(env, `telegram:${user.id}`, TELEGRAM_RATE_LIMIT, TELEGRAM_RATE_WINDOW_SECONDS);
  if (!allowed) {
    return webhookSend(message.chat.id, "درخواست‌ها خیلی سریع ارسال شدند. لطفاً یک دقیقه بعد دوباره تلاش کنید.");
  }
  const tenant = await ensureTenant(env, user);
  const text = (message.text ?? "").trim();
  const parsed = parseBotCommand(text, env.BOT_USERNAME);

  if (parsed) {
    switch (parsed.command) {
      case "start": {
        const arg = (parsed.args[0] ?? "").toLowerCase();
        if (arg && !V13_DEEP_LINK_ARGS.has(arg)) {
          if (await forwardToOmni(env, update)) return json({ ok: true });
          return webhookSend(message.chat.id, omniWelcomeText(), omniMainMenuKeyboard());
        }
        if (V13_DEEP_LINK_ARGS.has(arg)) {
          return sendLoginLinkMessage(env, message.chat.id, tenant.id, String(user.id));
        }
        return webhookSend(message.chat.id, omniWelcomeText(), omniMainMenuKeyboard());
      }
      case "panel":
        return sendLoginLinkMessage(env, message.chat.id, tenant.id, String(user.id));
      case "status":
        return sendStatusMessage(env, message.chat.id, tenant.id);
      case "help":
        return webhookSend(message.chat.id, omniHelpText(), omniBackMenuKeyboard());
      default: {
        if (await forwardToOmni(env, update)) return json({ ok: true });
        return webhookSend(message.chat.id, omniUnknownCommandText(), omniMainMenuKeyboard());
      }
    }
  }

  if (text === OMNI_MENU_TEXT_SATELLITE) {
    return sendLoginLinkMessage(env, message.chat.id, tenant.id, String(user.id));
  }
  if (text === OMNI_MENU_TEXT_STATUS) {
    return sendStatusMessage(env, message.chat.id, tenant.id);
  }
  if (text === OMNI_MENU_TEXT_HELP) {
    return webhookSend(message.chat.id, omniHelpText(), omniBackMenuKeyboard());
  }
  if (text === OMNI_MENU_TEXT_HOME) {
    return webhookSend(message.chat.id, omniWelcomeText(), omniMainMenuKeyboard());
  }

  if (await forwardToOmni(env, update)) return json({ ok: true });
  return webhookSend(message.chat.id, omniFreeTextReply(), omniMainMenuKeyboard());
}

async function answerCallback(
  env: Env,
  callbackQueryId: string,
  text: string,
  showAlert = false,
): Promise<void> {
  await telegramApi(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert,
  });
}

async function editMenuMessage(
  env: Env,
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup: TelegramInlineKeyboard,
): Promise<void> {
  try {
    await telegramApi(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
      reply_markup: replyMarkup,
    });
  } catch {
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text,
      protect_content: true,
      disable_web_page_preview: true,
      reply_markup: replyMarkup,
    });
  }
}

async function handleCallbackUpdate(update: TelegramUpdate, env: Env): Promise<Response> {
  const query: TelegramCallbackQuery | undefined = update.callback_query;
  const user = query?.from;
  const chatId = query?.message?.chat.id;
  const chatType = query?.message?.chat.type;
  if (!query || !user || user.is_bot || !chatId || chatType !== "private" || String(chatId) !== String(user.id)) {
    return json({ ok: true });
  }
  const allowed = await rateLimit(env, `telegram:${user.id}`, TELEGRAM_RATE_LIMIT, TELEGRAM_RATE_WINDOW_SECONDS);
  if (!allowed) {
    try {
      await answerCallback(env, query.id, "درخواست‌ها خیلی سریع است؛ یک دقیقه بعد تلاش کنید.", true);
    } catch {
      // Best effort: never fail the webhook on a rate-limit notice.
    }
    return json({ ok: true });
  }

  const data = query.data ?? "";
  if (!data.startsWith("v13:") && !data.startsWith("omni:")) {
    if (await forwardToOmni(env, update)) return json({ ok: true });
    try {
      await answerCallback(env, query.id, "این دکمه متعلق به بخش دیگری است.", true);
    } catch {
      // Best effort only.
    }
    return json({ ok: true });
  }

  try {
    const tenant = await ensureTenant(env, user);
    const messageId = query.message?.message_id;
    switch (data) {
      case "v13:login": {
        const { loginUrl, ttlMinutes } = await issueLoginLink(env, tenant.id);
        await audit(env, {
          tenantId: tenant.id,
          actorType: "telegram",
          actorId: String(user.id),
          action: "login_link.create",
          outcome: "success",
        });
        await answerCallback(env, query.id, "لینک ورود ساخته شد ✅");
        await telegramApi(env, "sendMessage", {
          chat_id: chatId,
          text: omniLoginText(ttlMinutes),
          protect_content: true,
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [
              [{ text: "🛰️ ورود به محیط اختصاصی", url: loginUrl }],
              [{ text: "🏠 منوی اصلی Omni", callback_data: "omni:home" }],
            ],
          },
        });
        return json({ ok: true });
      }
      case "v13:status": {
        if (messageId === undefined) return json({ ok: true });
        await answerCallback(env, query.id, "در حال دریافت وضعیت…");
        const rows = await listRecentDeployments(env, tenant.id);
        await editMenuMessage(env, chatId, messageId, formatDeploymentStatus(rows), {
          inline_keyboard: [
            [{ text: "🛰️ ورود به محیط اختصاصی V13", callback_data: "v13:login" }],
            [{ text: "🏠 منوی اصلی Omni", callback_data: "omni:home" }],
          ],
        });
        return json({ ok: true });
      }
      case "v13:help": {
        if (messageId === undefined) return json({ ok: true });
        await answerCallback(env, query.id, "راهنما");
        await editMenuMessage(env, chatId, messageId, omniHelpText(), omniBackMenuKeyboard());
        return json({ ok: true });
      }
      case "omni:home": {
        if (messageId === undefined) return json({ ok: true });
        await answerCallback(env, query.id, "منوی اصلی Omni");
        await editMenuMessage(env, chatId, messageId, omniWelcomeText(), omniMainMenuKeyboard());
        return json({ ok: true });
      }
      default: {
        if (await forwardToOmni(env, update)) return json({ ok: true });
        await answerCallback(env, query.id, "این دکمه دیگر معتبر نیست.", true);
        return json({ ok: true });
      }
    }
  } catch (error) {
    console.error("telegram_callback_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : String(error),
    });
    try {
      await answerCallback(env, query.id, "خطای موقت؛ دوباره تلاش کنید.", true);
    } catch {
      // Best effort only.
    }
    return json({ ok: true });
  }
}

export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  const providedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!env.TELEGRAM_WEBHOOK_SECRET || !(await constantTimeEqual(providedSecret, env.TELEGRAM_WEBHOOK_SECRET))) {
    await audit(env, { actorType: "telegram", action: "webhook.authenticate", outcome: "denied", request });
    throw new HttpError(401, "invalid_webhook_secret", "Unauthorized");
  }
  const update = await readJson<TelegramUpdate>(request, 64_000);
  if (!Number.isSafeInteger(update.update_id)) throw new HttpError(400, "invalid_update", "Invalid Telegram update");
  const inserted = await env.DB.prepare("INSERT OR IGNORE INTO telegram_updates (update_id, received_at) VALUES (?, ?)")
    .bind(update.update_id, nowIso()).run();
  if ((inserted.meta.changes ?? 0) === 0) return json({ ok: true });

  if (update.callback_query) return handleCallbackUpdate(update, env);
  if (update.message) return handleMessageUpdate(update, env);
  if (await forwardToOmni(env, update)) return json({ ok: true });
  return json({ ok: true });
}

export async function sendTelegramMessage(env: Env, telegramUserId: string, text: string): Promise<void> {
  await telegramApi(env, "sendMessage", {
    chat_id: telegramUserId,
    text,
    protect_content: true,
    disable_web_page_preview: true,
  });
}
