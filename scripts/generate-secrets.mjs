import { randomBytes } from "node:crypto";

const base64url = (bytes) => bytes.toString("base64url");
console.log("TELEGRAM_WEBHOOK_SECRET=" + base64url(randomBytes(32)));
console.log("TOKEN_ENCRYPTION_KEY=" + base64url(randomBytes(32)));
console.log("\nاین خروجی را در فایل سورس ذخیره نکنید. هر مقدار را با wrangler secret put ثبت کنید.");
