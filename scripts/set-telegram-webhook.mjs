/**
 * Register the Telegram webhook and the bot command list for the control plane.
 *
 * Required:
 *   TELEGRAM_BOT_TOKEN  — from @BotFather
 *   PUBLIC_BASE_URL     — e.g. https://control.example.com
 *
 * Optional:
 *   TELEGRAM_WEBHOOK_SECRET — when set, the webhook is (re)registered with this
 *     secret value. When it is absent the currently registered webhook is left
 *     exactly as it is and only the command list is refreshed: the Worker
 *     compares every incoming `X-Telegram-Bot-Api-Secret-Token` against its own
 *     secret, so registering a webhook with a value that does not match the
 *     Worker secret would take the live bot offline. The current registration
 *     is always reported so the state stays visible instead of guessed.
 */
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const webhookSecret = (process.env.TELEGRAM_WEBHOOK_SECRET ?? "").trim();
const publicBaseUrl = process.env.PUBLIC_BASE_URL;

if (!botToken || !publicBaseUrl) {
  console.error("Set TELEGRAM_BOT_TOKEN and PUBLIC_BASE_URL in the current shell.");
  process.exit(1);
}
if (webhookSecret && !/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) {
  console.error("TELEGRAM_WEBHOOK_SECRET must be 1-256 URL-safe characters (A-Z a-z 0-9 _ -).");
  process.exit(1);
}
const origin = new URL(publicBaseUrl);
if (origin.protocol !== "https:") throw new Error("PUBLIC_BASE_URL must use HTTPS");

async function telegramApi(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  return { response, result };
}

if (webhookSecret) {
  const webhook = await telegramApi("setWebhook", {
    url: `${origin.origin}/telegram/webhook`,
    secret_token: webhookSecret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
  if (!webhook.response.ok || !webhook.result.ok) {
    console.error(`Telegram rejected webhook setup (HTTP ${webhook.response.status}).`);
    process.exit(1);
  }
  console.log("Webhook registered (message + callback_query) from TELEGRAM_WEBHOOK_SECRET.");
} else {
  console.log("TELEGRAM_WEBHOOK_SECRET is not set: the registered webhook is left untouched so it keeps matching the Worker secret.");
}

const info = await telegramApi("getWebhookInfo", {});
const current = info.result?.result ?? {};
console.log(
  `Current webhook: url=${current.url || "(none)"} pending=${current.pending_update_count ?? 0}`
  + ` last_error=${current.last_error_message ? String(current.last_error_message).slice(0, 120) : "none"}`,
);
if (!current.url) {
  console.error("No webhook is registered, so the bot cannot receive updates. Set TELEGRAM_WEBHOOK_SECRET to register it.");
  process.exit(1);
}

const commands = await telegramApi("setMyCommands", {
  commands: [
    { command: "start", description: "منوی اصلی Omni" },
    { command: "panel", description: "ورود به محیط اختصاصی V13" },
    { command: "status", description: "وضعیت استقرارها" },
    { command: "cleanip", description: "رادار IP تمیز" },
    { command: "map", description: "نقشه زنده سانسور (نت ملی)" },
    { command: "whitehole", description: "هددراپ اضطراری DNS" },
    { command: "donate", description: "اهدای کلید هوش مصنوعی" },
    { command: "health", description: "سلامت نودها" },
    { command: "usage", description: "مصرف و دارایی‌ها" },
    { command: "pack", description: "بستهٔ کانفیگ PHANTOM ۲۰تایی" },
    { command: "dnstt", description: "تونل DNS با dnstt" },
    { command: "cancel", description: "لغو فرایند نیمه‌کاره" },
    { command: "help", description: "راهنما" },
  ],
});
if (!commands.response.ok || !commands.result.ok) {
  console.error(`Telegram rejected setMyCommands (HTTP ${commands.response.status}).`);
  process.exit(1);
}
console.log("Bot commands registered successfully. No secret value was printed.");
