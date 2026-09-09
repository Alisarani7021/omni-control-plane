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
const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url: `${origin.origin}/telegram/webhook`,
    secret_token: webhookSecret,
    allowed_updates: ["message"],
    drop_pending_updates: true,
  }),
});
const result = await response.json();
if (!response.ok || !result.ok) {
  console.error(`Telegram rejected webhook setup (HTTP ${response.status}).`);
  process.exit(1);
}
console.log("Telegram webhook registered successfully. No secret value was printed.");
