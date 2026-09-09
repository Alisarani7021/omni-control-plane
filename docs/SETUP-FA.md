# نصب V13 از صفر مطلق — راهنمای مرحله‌به‌مرحله

این راهنما فرض می‌کند تجربهٔ قبلی ندارید. فرمان‌ها را به‌ترتیب اجرا کنید. هرجا کلمهٔ `example.com`، نام ربات یا ID می‌بینید باید مقدار خودتان را قرار دهید.

> **نکتهٔ حیاتی:** V13 نسخهٔ زندهٔ قدیمی را خودکار تغییر نمی‌دهد. ابتدا credentialهای افشاشده را باطل کنید؛ سپس V13 را جداگانه deploy و آزمایش کنید؛ در پایان route نسخهٔ قدیمی را ببندید.

---

## فاز صفر — همین الآن رخنهٔ نسخهٔ قبلی را مهار کنید

### ۰.۱) Token ربات تلگرام قدیمی را باطل کنید

1. در Telegram حساب رسمی **@BotFather** را باز کنید.
2. پیام `/revoke` را بفرستید.
3. ربات قدیمی را از فهرست انتخاب کنید.
4. BotFather اعلام می‌کند token قبلی باطل شده است.
5. پیام `/token` را بفرستید، همان ربات را انتخاب و token جدید را فقط در password manager ذخیره کنید.
6. token را در این گفتگو، Git، screenshot یا فایل سورس نفرستید.

اگر قصد دارید یک ربات کاملاً جدید بسازید، باز هم token ربات قدیمی را revoke کنید.

### ۰.۲) Cloudflare credentialهای قدیمی را باطل کنید

1. به `https://dash.cloudflare.com/profile/api-tokens` بروید.
2. تمام API Tokenهایی را که در ربات/چت/Worker قبلی وارد شده‌اند پیدا کنید.
3. آن‌ها را **Roll** یا **Delete** کنید.
4. اگر Global API Key جایی کپی شده، آن را نیز rotate کنید و MFA حساب را بررسی کنید.
5. در Cloudflare Audit Logs دنبال deploy، DNS change یا token activity ناشناس بگردید.

### ۰.۳) Worker قدیمی را از دسترس خارج کنید

در Cloudflare Dashboard:

1. به **Workers & Pages** بروید.
2. Worker قدیمی را انتخاب کنید.
3. در **Settings → Domains & Routes**، route/custom domain عمومی را موقتاً حذف کنید یا Worker را غیرفعال کنید.
4. اگر خاموشی فوری ممکن نیست، حداقل مسیرهای `/setwebhook`، `/sub`، `/profile` و API مدیریتی آن را از route عمومی خارج کنید.

نسخهٔ قدیمی را با V13 overwrite نکنید؛ نام مستقل مثل `v13-control-plane` استفاده کنید تا rollback و مقایسه ممکن باشد.

---

## فاز یک — چیزهایی که باید شخصاً تهیه کنید

این موارد به حساب، پرداخت یا تصمیم شخصی شما نیاز دارند و ربات نمی‌تواند به‌جای شما انجام دهد:

1. **حساب Cloudflare** با MFA فعال.
2. **یک دامنهٔ active در Cloudflare**؛ مثلاً `example.com`.
3. **یک VPS** با Ubuntu 24.04 LTS یا Debian 12، IPv4 عمومی، دسترسی root/sudo و systemd.
4. **حساب Telegram** و ربات BotFather.
5. یک رایانه برای deploy با Node.js `22.12` یا جدیدتر، Git و terminal.

V13 خرید VPS یا پرداخت را انجام نمی‌دهد. بعد از اینکه IP را دارید، ساخت DNS، Worker داده، نصب sing-box، تولید credential، validation و health reporting خودکار است.

### ۱.۱) نام‌ها را قبل از شروع انتخاب کنید

نمونهٔ این راهنما:

| کاربرد | نمونه | مقدار شما |
|---|---|---|
| دامنهٔ اصلی | `example.com` | یادداشت کنید |
| کنترل‌پلین | `control.example.com` | یادداشت کنید |
| نام Worker کنترل | `v13-control-plane` | بهتر است همین بماند |
| ربات | `MyV13Bot` | یادداشت کنید |
| username ربات | `my_v13_bot` | باید به `bot` ختم شود |
| node هر کاربر | `node.example.com` | بعداً در پنل |
| subscription Worker | `sub.example.com` | بعداً در پنل |

`control`، `node` و `sub` باید متفاوت باشند.

---

## فاز دو — ساخت و ایمن‌سازی ربات در BotFather

### برای ربات جدید

1. @BotFather را باز کنید.
2. `/newbot` را بفرستید.
3. یک نام نمایشی وارد کنید؛ مثلاً `V13 Control Plane`.
4. یک username یکتا که به `bot` ختم شود وارد کنید؛ مثلاً `my_v13_bot`.
5. token دریافتی را در password manager بگذارید.

### تنظیم command

1. `/setcommands` را بفرستید.
2. ربات را انتخاب کنید.
3. دقیقاً این متن را بفرستید:

```text
start - ورود امن به پنل V13
```

### جلوگیری از استفادهٔ ناخواسته در گروه

1. `/setjoingroups` را بفرستید.
2. ربات را انتخاب کنید.
3. **Disable** را انتخاب کنید.

کد V13 نیز فقط پیام private را قبول می‌کند؛ این تنظیم لایهٔ دفاعی دوم است.

---

## فاز سه — آماده‌کردن رایانهٔ deploy

### ۳.۱) بررسی Node

```bash
node --version
npm --version
```

نسخهٔ Node باید حداقل `v22.12.0` باشد. اگر نصب نیست، از `https://nodejs.org/` نسخهٔ LTS را نصب کنید و terminal را دوباره باز کنید.

### ۳.۲) ورود به پوشهٔ پروژه

```bash
cd v13-control-plane
npm ci
npm audit --audit-level=moderate
```

`npm ci` دقیقاً نسخه‌های قفل‌شده در `package-lock.json` را نصب می‌کند. اگر audit آسیب‌پذیری جدید گزارش کرد، بدون بررسی کورکورانه `--force` نزنید؛ ابتدا advisory و سازگاری را بررسی کنید.

### ۳.۳) ورود Wrangler به Cloudflare

```bash
npx wrangler login
```

1. مرورگر باز می‌شود.
2. حساب Cloudflare را انتخاب کنید.
3. دسترسی Wrangler را تأیید کنید.
4. به terminal برگردید.

این login فقط برای deploy کنترل‌پلین خود شماست؛ کاربران نهایی از OAuth جداگانه استفاده می‌کنند.

---

## فاز چهار — ساخت D1

در terminal:

```bash
npx wrangler d1 create v13-control-plane
```

خروجی شامل `database_id` است. آن را کپی کنید.

فایل `wrangler.jsonc` را باز کنید و این مقدار را عوض کنید:

```json
"database_id": "REPLACE_WITH_D1_DATABASE_ID"
```

مثلاً:

```json
"database_id": "0123456789abcdef0123456789abcdef"
```

سپس migration را روی D1 واقعی اعمال کنید:

```bash
npx wrangler d1 migrations apply v13-control-plane --remote
```

Wrangler فهرست migration را نشان می‌دهد؛ تأیید کنید. باید `0001_init.sql` با وضعیت موفق دیده شود.

---

## فاز پنج — تنظیم مقادیر غیرمحرمانه

فایل `wrangler.jsonc` را باز کنید.

### ۵.۱) custom domain کنترل‌پلین

این قسمت:

```json
"routes": [
  { "pattern": "control.example.com", "custom_domain": true }
]
```

را به hostname واقعی خودتان تغییر دهید.

### ۵.۲) متغیرها

در `vars`:

- `PUBLIC_BASE_URL`: دقیقاً `https://control.your-domain.com`؛ بدون slash انتهایی.
- `BOT_USERNAME`: username بدون `@`.
- `ADMIN_TELEGRAM_IDS`: فعلاً می‌تواند خالی بماند؛ endpoint admin در این release وجود ندارد.
- `SING_BOX_VERSION`: روی `1.14.0` بماند.
- TTLها را در اولین نصب تغییر ندهید.
- `CF_OAUTH_CLIENT_ID` فعلاً placeholder بماند تا OAuth client ساخته شود.

**هیچ secretی را در این فایل نگذارید.**

---

## فاز شش — ساخت secretهای تصادفی و ثبت Worker Secret

### ۶.۱) تولید مقادیر تصادفی

```bash
node scripts/generate-secrets.mjs
```

دو مقدار می‌بینید:

- `TELEGRAM_WEBHOOK_SECRET`
- `TOKEN_ENCRYPTION_KEY`

آن‌ها را مستقیم در password manager ذخیره کنید. `TOKEN_ENCRYPTION_KEY` باید base64url دقیقاً ۳۲ بایت تصادفی باشد.

### ۶.۲) ثبت secretها با prompt امن Wrangler

برای هر فرمان، Wrangler مقدار را مخفیانه می‌پرسد:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY
```

در اولی token جدید BotFather، در دومی secret تولیدشده و در سومی encryption key را paste کنید.

هنوز `CF_OAUTH_CLIENT_SECRET` ندارید؛ در فاز OAuth اضافه می‌شود.

---

## فاز هفت — تست کامل قبل از اولین deploy

```bash
npm run preflight
npm run lint
npm run typecheck
npm test
npm run verify:sing-box
npm run build
```

انتظار:

- preflight: الگوهای قدیمی/hardcoded پیدا نشود.
- lint/typecheck/test: بدون error.
- verify: هر سه fixture سرور، VLESS client و Hysteria2 client با sing-box 1.14.0 معتبر باشند.
- build: dry-run موفق باشد.

`verify:sing-box` archive رسمی را دانلود می‌کند اما قبل از اجرا SHA-256 ثابت را بررسی می‌کند.

---

## فاز هشت — اولین deploy برای فعال‌شدن دامنهٔ کنترل

```bash
npx wrangler deploy
```

بعد از پایان:

```bash
curl -i https://control.your-domain.com/healthz
```

باید status `200` و JSON شبیه زیر ببینید:

```json
{"ok":true,"service":"v13-control-plane","version":13}
```

همچنین صفحهٔ اصلی را در مرورگر باز کنید. Custom Domain Worker باید DNS و TLS را از Cloudflare بگیرد؛ صدور certificate ممکن است چند دقیقه طول بکشد.

در این مرحله دکمهٔ OAuth عمداً هنوز کار نمی‌کند، چون client ساخته نشده است.

---

## فاز نه — ساخت Cloudflare OAuth Client با حداقل scope

مستند رسمی: `https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/`

1. وارد Cloudflare Dashboard شوید.
2. account میزبان OAuth client را انتخاب کنید.
3. به **Manage Account → OAuth clients** بروید.
4. **Create client** را بزنید.
5. مقادیر زیر را تنظیم کنید:

| فیلد | مقدار |
|---|---|
| Client name | `V13 Control Plane` |
| Response type | `code` |
| Grant type | `authorization_code` |
| Token endpoint authentication | `client_secret_basic` |
| Redirect URL | `https://control.your-domain.com/oauth/cloudflare/callback` |
| Client URL | `https://control.your-domain.com/` |
| Privacy URL | `https://control.your-domain.com/privacy` |
| Terms URL | `https://control.your-domain.com/terms` |

Redirect URL باید **کاراکتر‌به‌کاراکتر** با `PUBLIC_BASE_URL + /oauth/cloudflare/callback` برابر باشد.

### ۹.۱) scopeهای لازم

در صفحهٔ انتخاب scope فقط permissionهای متناظر با این عملیات را انتخاب کنید:

1. **Account Settings Read** — فهرست accountهای کاربر.
2. **Zone Read** — بررسی zone و تعلق آن به account.
3. **DNS Write** — ساخت/به‌روزرسانی A record مستقیم VPS.
4. **Workers Scripts Write** — آپلود Worker داده، secret binding و اتصال custom domain.

اگر Dashboard برای custom domain مجوز جداگانهٔ **Workers Routes Write** درخواست کرد، فقط همان را نیز اضافه کنید. مجوزهای Billing، API Tokens Write، Access Write، Member Write، R2، KV یا permission نامرتبط را ندهید.

تمام scopeهای لازم را Required نگه دارید؛ feature بدون یکی از آن‌ها ناقص می‌شود.

### ۹.۲) عمومی‌کردن برای چندکاربر

OAuth client ابتدا private است و فقط اعضای account سازنده می‌توانند آن را authorize کنند. برای اینکه «هر کاربر» بتواند استفاده کند:

1. لوگو، Client URL و scopeها را کامل کنید.
2. در تنظیم OAuth client گزینهٔ **Change Visibility / Public** را انتخاب کنید.
3. Cloudflare یک TXT verification با پیشوند `cloudflare_oauth_client_publisher=` می‌دهد.
4. به **DNS → Records → Add record** بروید.
5. نوع `TXT`، نام و مقدار دقیق داده‌شده را وارد کنید.
6. ذخیره و منتظر verification بمانید.
7. سپس visibility را Public کنید.

طبق مستند Cloudflare، عمومی‌کردن برگشت‌پذیر نیست؛ قبل از تأیید نام، دامنه، privacy و terms را دوباره بررسی کنید.

### ۹.۳) ثبت Client ID و Secret

Cloudflare secret را فقط یک بار نشان می‌دهد:

1. Client ID را در password manager ذخیره کنید.
2. Client Secret را در password manager ذخیره کنید.
3. در `wrangler.jsonc` مقدار `CF_OAUTH_CLIENT_ID` را با Client ID جایگزین کنید. Client ID محرمانه نیست.
4. secret را با prompt ثبت کنید:

```bash
npx wrangler secret put CF_OAUTH_CLIENT_SECRET
```

5. دوباره deploy کنید:

```bash
npm run check
npx wrangler deploy
```

---

## فاز ده — ثبت امن Telegram Webhook

V13 هیچ `/setwebhook` عمومی ندارد. webhook را یک بار از رایانهٔ خودتان با script محلی ثبت کنید.

برای جلوگیری از ثبت secret در history:

```bash
read -rsp 'Telegram bot token: ' TELEGRAM_BOT_TOKEN; echo
read -rsp 'Telegram webhook secret: ' TELEGRAM_WEBHOOK_SECRET; echo
export TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET
export PUBLIC_BASE_URL='https://control.your-domain.com'
node scripts/set-telegram-webhook.mjs
unset TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET PUBLIC_BASE_URL
```

انتظار: `Telegram webhook registered successfully.`

این script:

- URL را فقط روی `/telegram/webhook` می‌گذارد.
- `secret_token` را به Telegram می‌دهد تا header امنیتی ارسال شود.
- فقط update نوع `message` را می‌خواهد.
- updateهای pending قدیمی را حذف می‌کند.
- هیچ secretی چاپ نمی‌کند.

برای بررسی وضعیت webhook بدون چاپ token در history می‌توانید Bot API را با همان روش `read -s` و endpoint `getWebhookInfo` صدا بزنید؛ پاسخ نباید token را شامل شود.

---

## فاز یازده — آماده‌سازی VPS

### ۱۱.۱) شرط‌های VPS

- Ubuntu 24.04 یا Debian 12.
- CPU `x86_64/amd64` یا `aarch64/arm64`.
- IPv4 عمومی واقعی؛ IP خصوصی/CGNAT پذیرفته نمی‌شود.
- systemd، curl، python3، openssl و sha256sum.
- دسترسی sudo/root.
- نبود سرویس متعارض روی TCP/443، UDP/443 و برای ACME روی TCP/80.

در VPS بررسی کنید:

```bash
uname -m
cat /etc/os-release
sudo ss -lntup | grep -E ':(80|443)\b' || true
```

اگر Nginx/Caddy/Apache روی 80 یا 443 دارید، بدون برنامه آن را حذف نکنید؛ VPS جدا برای V13 امن‌تر است.

### ۱۱.۲) firewall پنل ارائه‌دهنده

در dashboard شرکت VPS inboundهای زیر را باز کنید:

- پورت SSH فعلی روی TCP، ترجیحاً فقط از IP مدیریتی شما.
- TCP/80 از اینترنت برای ACME challenge.
- TCP/443 از اینترنت برای VLESS Reality.
- UDP/443 از اینترنت برای Hysteria2.

اگر provider و سیستم‌عامل هر دو firewall دارند، هر دو باید اجازه دهند.

### ۱۱.۳) به‌روزرسانی پایهٔ سیستم

برای Ubuntu/Debian:

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y curl ca-certificates python3 openssl
sudo timedatectl set-ntp true
```

پیش از upgrade مهم، snapshot بگیرید.

---

## فاز دوازده — اولین استفادهٔ واقعی

1. در Telegram ربات را باز کنید.
2. `/start` را بفرستید.
3. لینک یک‌بارمصرف را بزنید. لینک معمولاً ۱۰ دقیقه اعتبار و فقط یک بار مصرف دارد.
4. در پنل **اتصال با OAuth** را بزنید.
5. در Cloudflare account/zone موردنظر و فقط scopeهای نشان‌داده‌شده را تأیید کنید.
6. به پنل برگردید.
7. فرم استقرار را پر کنید:
   - اتصال OAuth.
   - account و zone.
   - Worker name مثل `v13-paris-01`.
   - Worker hostname مثل `sub.example.com`.
   - Node hostname مثل `node.example.com`.
   - IPv4 عمومی VPS.
   - ایمیل واقعی ACME.
   - Reality target مثل `www.microsoft.com` که از VPS قابل دسترس است.
   - UFW را فقط اگر می‌خواهید V13 آن را فعال کند انتخاب کنید.
8. **شروع provisioning** را بزنید.

Control Plane اکنون خودش zone را verify، DNS را upsert، Worker داده را upload و custom domain را attach می‌کند.

### ۱۲.۱) اجرای چهار فرمان VPS

پنل چهار فرمان می‌دهد:

1. دریافت script با Authorization bearer.
2. بررسی script با `less`.
3. اجرای script با sudo.
4. حذف امن فایل.

همان‌ها را دقیقاً و به‌ترتیب روی VPS اجرا کنید. **مرحلهٔ بررسی را حذف نکنید.** token bootstrap فقط همان deployment را bootstrap می‌کند، کوتاه‌عمر و یک‌بارمصرف است.

اسکریپت به‌طور خودکار:

- sing-box 1.14.0 را از release رسمی دریافت می‌کند.
- SHA-256 ثابت معماری را verify می‌کند.
- کلیدها و رمزها را محلی می‌سازد.
- config را با schema جدید certificate provider می‌نویسد.
- `sing-box check` را اجرا می‌کند.
- systemd hardening را فعال می‌کند.
- callback امن را می‌فرستد.
- health timer پنج‌دقیقه‌ای را نصب می‌کند.

هیچ password SSH/root به ربات یا Worker داده نمی‌شود.

### ۱۲.۲) انتظار برای وضعیت ready

بعد از اجرای موفق، پنل را refresh کنید. ترتیب معمول:

```text
awaiting_agent -> agent_ready -> finalizing -> ready
```

وقتی `ready` شد، سه URL امن می‌بینید:

- URI list شامل VLESS Reality و Hysteria2.
- sing-box VLESS profile.
- sing-box Hysteria2 profile.

این URLها credential هستند؛ در کانال عمومی منتشر نکنید. تلگرام عمداً آن‌ها را ارسال نمی‌کند.

---

## فاز سیزده — آزمون نهایی

### کنترل‌پلین

```bash
curl -i https://control.your-domain.com/healthz
```

### داده‌پلین

```bash
curl -i https://sub.example.com/healthz
curl -i https://sub.example.com/sub/WRONG_TOKEN
```

health باید 200 باشد و token اشتباه باید 404 بدهد.

### VPS

```bash
sudo systemctl is-active sing-box
sudo systemctl is-enabled sing-box
sudo /usr/local/bin/sing-box version
sudo /usr/local/bin/sing-box check -c /etc/sing-box/config.json
sudo journalctl -u sing-box -n 100 --no-pager
```

نسخه باید دقیقاً `1.14.0` باشد.

### Client

یکی از profileهای sing-box را import کنید. ابتدا هرکدام را جداگانه آزمایش کنید تا معلوم باشد مشکل مربوط به TCP یا UDP است.

---

## فاز چهارده — بازنشسته‌کردن نسخهٔ قدیمی

فقط بعد از موفقیت تست V13:

1. route/custom domain نسخهٔ قدیمی را حذف کنید.
2. Worker قدیمی را با label آرشیوی نگه دارید یا export کنید؛ اما عمومی نماند.
3. KV/Secretهای قدیمی را بعد از backup و retention لازم حذف کنید.
4. تمام tokenهای قدیمی را دوباره مرور و revoke کنید.
5. DNS recordهای Phantom/WhiteHole/dnstt یا رکوردهای آزمایشی بلااستفاده را حذف کنید.

---

## دربارهٔ «نت ملی» و قطع بین‌الملل

V13 می‌تواند دو transport واقعی با رفتار متفاوت فراهم کند و health را اندازه بگیرد، اما اگر از شبکهٔ کاربر تا VPS خارجی هیچ مسیر IP/DNS/UDP/TCP وجود نداشته باشد، TXT record، dnstt یا نام‌گذاری خاص به‌تنهایی مسیر ایجاد نمی‌کند. بنابراین:

- عملکرد باید روی ISPها و زمان‌های مختلف اندازه‌گیری شود.
- VPS یا relay داخل زیرساخت قابل‌دسترسی قانونی ممکن است در بعضی سناریوها لازم باشد.
- هیچ متن UI یا تبلیغ V13 نباید «تضمین اتصال در قطع کامل» بدهد.

برای عملیات، rotation، عیب‌یابی و حذف، فایل `OPERATIONS-FA.md` را بخوانید.
