import { audit, rateLimit } from "./db";
import { HttpError, json, readJson } from "./http";
import { addSecondsIso, constantTimeEqual, nowIso, parsePositiveInt, randomToken, sha256 } from "./security";
import type { Env, TelegramUpdate } from "./types";

interface TelegramApiResponse {
  ok: boolean;
  description?: string;
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

  const message = update.message;
  const user = message?.from;
  if (!message || !user || user.is_bot || message.chat.type !== "private" || String(message.chat.id) !== String(user.id)) {
    return json({ ok: true });
  }
  const allowed = await rateLimit(env, `telegram:${user.id}`, 12, 60);
  if (!allowed) return telegramWebhookReply(message.chat.id, "درخواست‌ها خیلی سریع ارسال شدند. لطفاً یک دقیقه بعد دوباره تلاش کنید.");

  const now = nowIso();
  const tenantId = crypto.randomUUID();
  const displayName = [user.first_name, user.last_name].filter(Boolean).join(" ").slice(0, 120);
  await env.DB.prepare(
    `INSERT INTO tenants (id, telegram_user_id, telegram_username, display_name, locale, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET
       telegram_username = excluded.telegram_username,
       display_name = excluded.display_name,
       locale = excluded.locale,
       updated_at = excluded.updated_at`,
  ).bind(tenantId, String(user.id), user.username ?? null, displayName, user.language_code ?? null, now, now).run();
  const tenant = await env.DB.prepare("SELECT id FROM tenants WHERE telegram_user_id = ?")
    .bind(String(user.id)).first<{ id: string }>();
  if (!tenant) throw new Error("Tenant upsert failed");

  const rawLinkToken = randomToken(32);
  const tokenHash = await sha256(rawLinkToken);
  const ttl = parsePositiveInt(env.LOGIN_LINK_TTL_SECONDS, 900, 3600);
  await env.DB.prepare(
    "INSERT INTO login_links (token_hash, tenant_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
  ).bind(tokenHash, tenant.id, addSecondsIso(ttl), now).run();
  const loginUrl = `${new URL(env.PUBLIC_BASE_URL).origin}/login?t=${encodeURIComponent(rawLinkToken)}`;
  await audit(env, {
    tenantId: tenant.id,
    actorType: "telegram",
    actorId: String(user.id),
    action: "login_link.create",
    outcome: "success",
  });

  const command = (message.text ?? "").trim().split(/\s+/u)[0]?.toLowerCase();
  const intro = command === "/start"
    ? "به V13 خوش آمدید. تلگرام فقط رابط کاربری است؛ هیچ API Token یا رمز سروری را در چت ارسال نکنید."
    : "لینک یک‌بارمصرف پنل شما آماده است.";
  return telegramWebhookReply(
    message.chat.id,
    `${intro}\n\nاین لینک ${Math.floor(ttl / 60)} دقیقه اعتبار دارد و بعد از اولین استفاده باطل می‌شود.`,
    loginUrl,
  );
}

function telegramWebhookReply(chatId: number, text: string, url?: string): Response {
  const payload: Record<string, unknown> = {
    method: "sendMessage",
    chat_id: chatId,
    text,
    protect_content: true,
    disable_web_page_preview: true,
  };
  if (url) payload.reply_markup = { inline_keyboard: [[{ text: "باز کردن پنل امن", url }]] };
  return json(payload);
}

export async function sendTelegramMessage(env: Env, telegramUserId: string, text: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: telegramUserId,
      text,
      protect_content: true,
      disable_web_page_preview: true,
    }),
  });
  const result = await response.json<TelegramApiResponse>();
  if (!response.ok || !result.ok) throw new Error(`Telegram API request failed: ${response.status}`);
}
