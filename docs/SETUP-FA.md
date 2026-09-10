# نصب V13 از صفر — راهنمای موبایل و Codespaces

این راهنما مسیر فعال **Scoped Cloudflare API Token** را توضیح می‌دهد. OAuth Client و Global API Key لازم نیست.

> API Token فقط داخل فرم HTTPS پنل وارد می‌شود؛ هرگز آن را در Terminal، Telegram، چت یا screenshot قرار ندهید.

## پیش‌نیازها

- حساب Cloudflare با یک domain فعال
- Telegram bot ساخته‌شده با BotFather
- GitHub Codespace با Node.js 22.12 یا جدیدتر
- VPS Debian/Ubuntu با IPv4 عمومی و دسترسی root در Termius
- یک hostname برای کنترل‌پلین، مانند `control.example.com`

## ۱. بررسی سورس

```bash
cd /workspaces/v13-control-plane
npm ci
node --version
npm run preflight
npm run lint
npm run typecheck
npm test
```

انتظار: Node 22.12+، صفر warning/error و همهٔ testها سبز.

## ۲. تنظیم `wrangler.jsonc`

مقدارهای واقعی زیر را نگه دارید یا تنظیم کنید:

- `routes[0].pattern`
- `vars.PUBLIC_BASE_URL`
- `vars.BOT_USERNAME`
- `d1_databases[0].database_id`
- `ADMIN_TELEGRAM_IDS`

TTL و cron لازم:

```json
"triggers": {
  "crons": ["*/5 * * * *"]
},
"vars": {
  "API_TOKEN_TTL_SECONDS": "7200"
}
```

هیچ API Token واقعی در `wrangler.jsonc` قرار ندهید.

## ۳. D1

برای نصب تازه:

```bash
npx wrangler d1 create v13-control-plane
npx wrangler d1 migrations apply v13-control-plane --remote
```

برای production موجود ابتدا backup و بعد migration:

```bash
mkdir -p backups
npx wrangler d1 export v13-control-plane --remote --output backups/pre-api-token.sql
npx wrangler d1 migrations apply v13-control-plane --remote
```

باید `0001_init.sql` و `0002_temporary_api_token.sql` applied باشند. backup را عمومی یا commit نکنید.

## ۴. Worker Secretها

Bot token را در prompt مخفی وارد کنید:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
```

کلید رمزگذاری بدون چاپ روی صفحه:

```bash
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))" | npx wrangler secret put TOKEN_ENCRYPTION_KEY
```

Telegram webhook secret:

```bash
export TELEGRAM_WEBHOOK_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))")"
printf %s "$TELEGRAM_WEBHOOK_SECRET" | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

## ۵. build و deploy

```bash
npm run build
npm run deploy
```

## ۶. ثبت webhook تلگرام

```bash
read -rsp "Bot token: " TELEGRAM_BOT_TOKEN; echo
export TELEGRAM_BOT_TOKEN
export PUBLIC_BASE_URL="https://control.example.com"
node scripts/set-telegram-webhook.mjs
unset TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET PUBLIC_BASE_URL
```

فقط hostname نمونه را تغییر دهید. خروجی موفق secret را چاپ نمی‌کند.

## ۷. ساخت Scoped API Token توسط هر کاربر

این بخش فقط داخل Cloudflare Dashboard انجام می‌شود:

1. `My Profile → API Tokens`
2. `Create Token`
3. پایین صفحه `Create Custom Token`
4. نام Token: `V13 temporary provisioning`
5. Permission اول: `Account → Workers Scripts → Edit`
6. Permission دوم: `Zone → DNS → Edit`
7. Permission سوم: `Zone → Zone → Read`
8. `Account Resources → Include → Specific account` و فقط حساب موردنظر
9. `Zone Resources → Include → Specific zone` و فقط یک domain موردنظر
10. `Client IP Address Filtering` را خالی بگذارید؛ Worker IP خروجی ثابت ندارد.
11. در صورت تمایل TTL خود Cloudflare را کوتاه، مثلاً ۲۴ ساعت، تنظیم کنید.
12. `Continue to summary → Create Token`
13. Token فقط یک بار نمایش داده می‌شود؛ آن را مستقیم در password input پنل HTTPS Paste کنید.
14. Token را در Telegram، Terminal یا screenshot قرار ندهید.

V13 Tokenهایی را که بیش از یک zone active نشان دهند رد می‌کند تا resource boundary محدود بماند.

## ۸. اولین استقرار

1. در Telegram به ربات `/start` بدهید.
2. لینک ورود کوتاه‌عمر را باز کنید.
3. Scoped API Token را در فرم HTTPS وارد و «بررسی دسترسی» را بزنید.
4. account و zone قفل‌شده را از فهرست انتخاب کنید.
5. مشخصات VPS و hostnameها را وارد و provisioning را شروع کنید.
6. چهار فرمان bootstrap را در Termius به‌ترتیب download، inspect، execute و erase اجرا کنید.
7. پنل باید `ready` و subscriptionهای خصوصی را نشان دهد.
8. connection موقت پس از پایان ناپدید می‌شود.
9. برای ابطال واقعی، Token را در Cloudflare API Tokens حذف کنید.

## ۹. بررسی پاک‌سازی بدون مشاهدهٔ ciphertext

```bash
npx wrangler d1 execute v13-control-plane --remote --command "SELECT auth_type, COUNT(*) AS active FROM oauth_connections WHERE revoked_at IS NULL GROUP BY auth_type;"
```

connection موقت بدون deployment فعال باید صفر باشد. ستون `access_token_enc` را query یا screenshot نکنید.

## ۱۰. VPS و شبکه

- TCP/443 برای VLESS Reality لازم است.
- UDP/443 برای Hysteria2 لازم است.
- DNS مربوط به node به‌شکل DNS-only توسط Workflow ساخته می‌شود.
- UFW فقط وقتی فعال شود که پورت SSH فعلی مشخص است.
- کنترل‌پلین root password را دریافت یا ذخیره نمی‌کند.
- در قطع کامل مسیر تا Cloudflare و VPS خارجی، اتصال تضمین‌شده نیست.
