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

## ۲.۱ استقرار خودکار از GitHub Actions (اختیاری ولی توصیه‌شده)

دو workflow وجود دارد:

- `.github/workflows/deploy.yml` — با هر push روی `main`: مهاجرت‌های D1 → `wrangler deploy` → تازه‌سازی دستورهای ربات.
- `.github/workflows/deploy-session.yml` — همان کار برای شاخه‌های `arena/**` (پایپ‌لاین جلسه: اول کل تست‌ها، بعد استقرار).

مسیر تنظیم سیکرت‌ها (فقط یک‌بار):

`https://github.com/<owner>/<repo>/settings/secrets/actions` → تب **Secrets** (نه Variables، نه Codespaces، نه Dependabot) → **New repository secret**

| نام دقیق | مقدار | لازم؟ |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | توکن اسکوپ‌شده: Account → Workers Scripts Edit و D1 Edit؛ Zone → Workers Routes Edit و Zone Read | بله |
| `CLOUDFLARE_ACCOUNT_ID` | از نوار کنار داشبورد Cloudflare | اختیاری (`wrangler.jsonc` هم `account_id` دارد) |
| `TELEGRAM_BOT_TOKEN` | از @BotFather | برای تازه‌سازی دستورها/وبهوک |
| `TELEGRAM_WEBHOOK_SECRET` | فقط اگر با سیکرت ورکر **دقیقاً** یکی است | اختیاری |

نکته‌های مهم:

- اگر سیکرت را در تب Variables یا Codespaces بگذارید، Actions آن را نمی‌بیند و job با هشدار «Deploy skipped» رد می‌شود (شکست نمی‌خورد). همان هشدار نام‌هایی را که جست‌وجو شده چاپ می‌کند (`CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`, `CLOUDFLARE_API_KEY`, `CLOUDFLARE_TOKEN`, `CF_TOKEN`, `CLOUDFLARE_API_TOKEN_V13`, `vars.CLOUDFLARE_API_TOKEN`).
- `TELEGRAM_WEBHOOK_SECRET` اگر ست نباشد، اسکریپت ثبت وبهوک را **دست نمی‌زند** (تا سیکرت ورکر و تلگرام ناهمخوان نشوند) و فقط دستورهای ربات را به‌روز می‌کند؛ وضعیت وبهوک را از `getWebhookInfo` چاپ می‌کند.
- پس از استقرار، `https://<PUBLIC_BASE_URL>/healthz` باید `release` مربوط به همان نسخه را نشان دهد؛ این اثر انگشت دیپلوی است و همراه `package.json` بالا می‌رود.
- هیچ مقدار secret در log چاپ نمی‌شود؛ workflow فقط وجود/عدم‌وجود نام‌ها را گزارش می‌کند.

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

باید هر چهار migration (`0001_init.sql` تا `0004_panel_sections.sql`) applied باشند؛ `0004` جدول‌های بخش‌های منتقل‌شدهٔ پنل (رادار IP، نقشهٔ سانسور، هددراپ، اهدای AI و `telegram_flows`) را می‌سازد. backup را عمومی یا commit نکنید.

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

1. در پنل V13 دکمهٔ «ساخت Token آماده در Cloudflare» را بزنید.
2. Cloudflare نام Token و سه permission لازم را از template رسمی از قبل پر می‌کند.
3. در `Account Resources` فقط حساب موردنظر را انتخاب کنید.
4. در `Zone Resources` فقط یک domain مشخص را انتخاب کنید.
5. `Client IP Address Filtering` را خالی بگذارید؛ Worker IP خروجی ثابت ندارد.
6. در صورت تمایل TTL خود Cloudflare را کوتاه، مثلاً ۲۴ ساعت، تنظیم کنید.
7. `Continue to summary → Create Token` را بزنید.
8. Token فقط یک بار نمایش داده می‌شود؛ آن را کپی و مستقیم در password input پنل V13 Paste کنید.
9. Token را در Telegram، Terminal یا screenshot قرار ندهید.

Template این سه permission را خودکار پر می‌کند:

- `Account → Workers Scripts → Edit`
- `Zone → DNS → Edit`
- `Zone → Zone → Read`

V13 Tokenهایی را که بیش از یک zone active نشان دهند رد می‌کند تا resource boundary محدود بماند.

## ۸. اولین استقرار

1. در Telegram به ربات `/start` بدهید (یا لینک مستقیم `https://t.me/<bot>?start=v13` را باز کنید).
2. دکمهٔ «🛰️ ورود به محیط اختصاصی V13» را بزنید و لینک یک‌بارمصرف را باز کنید.
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
