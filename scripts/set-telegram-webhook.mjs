const botToken = process.env.TELEGRAM_BOT_TOKEN;
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
const publicBaseUrl = process.env.PUBLIC_BASE_URL;

if (!botToken || !webhookSecret || !publicBaseUrl) {
  console.error("Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and PUBLIC_BASE_URL in the current shell.");
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret)) {
  console.error("TELEGRAM_WEBHOOK_SECRET must be 32-256 URL-safe characters.");
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

const commands = await telegramApi("setMyCommands", {
  commands: [
    { command: "start", description: "منوی اصلی Omni" },
    { command: "panel", description: "ورود به محیط اختصاصی V13" },
    { command: "status", description: "وضعیت استقرارها" },
    { command: "cancel", description: "لغو فرایند نیمه‌کاره" },
    { command: "help", description: "راهنما" },
  ],
});
if (!commands.response.ok || !commands.result.ok) {
  console.error(`Webhook registered, but Telegram rejected setMyCommands (HTTP ${commands.response.status}).`);
  process.exit(1);
}
console.log("Telegram webhook (message + callback_query) and bot commands registered successfully. No secret value was printed.");
