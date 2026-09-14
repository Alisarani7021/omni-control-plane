# از صفر تا پنل زنده

سه مسیر. اگر روی گوشی هستید، **مسیر ۱** مال شماست — بدون نصب هیچ‌چیز.

| مسیر | لازم دارد | زمان |
|---|---|---|
| **۱. گیت‌هاب + دکمه‌ی Deploy** | اکانت GitHub + اکانت Cloudflare | ~۱۰ دقیقه، همه‌اش با ضربه |
| **۲. کامپیوتر (CLI)** | Node.js ۲۰+ | ~۱۰ دقیقه |
| **۳. توکن بدهید، دستیار دیپلوی کند** | یک توکن Cloudflare | ~۵ دقیقه |

هر سه به یک پنل زنده می‌رسند. تفاوت فقط در این است که چه کسی دستورها را می‌زند.

---

# مسیر ۱ — از گوشی، با گیت‌هاب

## چرا این مسیر کار می‌کند

پروژه طوری ساخته شده که **هیچ مقدار دستی در `wrangler.toml` لازم نداشته باشد**:

- `database_id` عمداً گذاشته نشده → Wrangler ≥ ۴.۴۵ موقع دیپلوی خودش D1 را می‌سازد
  (رسمی: «اگر از داشبورد، مثلاً از طریق GitHub، دیپلوی کنید، منابع ساخته می‌شوند»)
- اسکیما موقع بالا آمدن Worker از همان `schema/*.sql` اعمال می‌شود (`src/db/migrate.js`)،
  چون `wrangler d1 migrations apply --remote` با دیتابیس auto-provisioned کار نمی‌کند
- کلید امضای نشست‌ها خودش تولید و در D1 ذخیره می‌شود → `wrangler secret put` لازم نیست
- رمز مدیر را اولین بار در مرورگر می‌سازید (`/api/setup`)

پس دکمه‌ی Deploy تنها چیزی است که لازم دارید.

## قدم ۱ — اکانت GitHub

اگر دارید، رد شوید. اگر نه: `https://github.com/signup` — ایمیل، رمز، یک نام کاربری.
با ایمیل تأیید کنید.

## قدم ۲ — ساخت ریپو

1. `github.com` → بالا سمت راست، آیکون **+** → **New repository**
2. Repository name: `kaveh`
3. **Public** را انتخاب کنید (دکمه‌ی Deploy به ریپوی عمومی نیاز دارد)
4. تیک «Add a README» را **نزنید** — ریپو باید خالی باشد
5. **Create repository**

## قدم ۳ — رساندن کد به ریپو

۵۰ فایل را نمی‌شود با گوشی یکی‌یکی آپلود کرد. دو راه دارید:

### راه الف (پیشنهادی): یک توکن به دستیار بدهید، خودش push کند

1. `github.com` → عکس پروفایل بالا راست → **Settings**
2. پایین‌ترین گزینه: **Developer settings**
3. **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
4. Token name: `kaveh-push` · Expiration: **7 days**
5. Repository access → **Only select repositories** → `kaveh`
6. Permissions → Repository permissions → **Contents** → **Read and write**
   (فقط همین یکی. نه Admin، نه چیز دیگر)
7. **Generate token** → کپی کنید (با `github_pat_` شروع می‌شود و فقط یک‌بار نمایش داده می‌شود)
8. در همین چت بفرستید و بگویید «push کن»

دستیار کد را push می‌کند، دکمه‌ی Deploy مخصوص ریپوی شما را می‌سازد و لینکش را
می‌دهد. **بعد از اتمام، همان توکن را در همان صفحه Delete کنید.**

### راه ب: خودتان با کامپیوتر

```bash
git clone https://github.com/<your-user>/kaveh
cd kaveh && unzip ~/Downloads/kaveh-panel.zip -d . && git add -A
git commit -m "kaveh panel" && git branch -M main && git push -u origin main
```

## قدم ۴ — زدن دکمه‌ی Deploy

لینک دکمه را (که بعد از push ساخته می‌شود) روی گوشی باز کنید:

```
https://deploy.workers.cloudflare.com/?url=https://github.com/<your-user>/kaveh
```

1. **Sign in with Cloudflare** → وارد اکانت Cloudflare شوید (اگر ندارید:
   `dash.cloudflare.com/sign-up` — رایگان، بدون کارت بانکی)
2. **Allow** → اجازه می‌دهید Cloudflare ریپو را بخواند
3. اسم Worker را تأیید کنید (`kaveh`) → **Deploy**
4. صبر کنید تا «Deployed» سبز شود — آدرس
   `https://kaveh.<subdomain>.workers.dev` را می‌دهد

## قدم ۵ — ساختن رمز مدیر (مهم: سریع انجامش دهید)

1. آدرس + `/panel` را باز کنید
2. صفحه‌ی راه‌اندازی می‌آید → نام کاربری `admin` و یک رمز قوی بگذارید
3. تمام

> ⚠️ **چرا سریع؟** تا وقتی رمز ساخته نشده، هر کس آدرس را داشته باشد می‌تواند
> خودش رمز بگذارد و مالک پنل شود. به محض ساخت رمز، `installed=true` می‌شود و
> `/api/setup` برای همیشه بسته می‌شود.

## قدم ۶ — ساخت اولین کاربر

تب **کاربران** → **ساخت کاربر** → نام + حجم + مدت → از کشوی کاربر **QR** یا
**لینک اشتراک** را کپی کنید → روی گوشی در v2rayNG / Streisand / sing-box /
Shadowrocket import کنید.

## به‌روزرسانی در آینده

هر بار که کد عوض شد: در ریپو **Actions** → آخرین run → یا دوباره همان دکمه‌ی
Deploy. اگر می‌خواهید هر push خودش دیپلوی شود، داشبورد Cloudflare →
Workers & Pages → kaveh → **Settings** → **Build** → ریپو را وصل کنید
(Workers Builds). دیتابیس و کاربران سر جایشان می‌مانند.

---

# مسیر ۲ — روی کامپیوتر

```bash
# ۱. Node.js نسخه‌ی ۲۰+ از nodejs.org نصب کنید (دکمه‌ی LTS)
node -v

# ۲. کد را باز کنید و وارد پوشه شوید
cd kaveh && npm ci

# ۳. همه‌چیز با یک دستور
bash scripts/activate.sh
```

`activate.sh` به ترتیب: پیش‌نیازها → تست‌ها → ورود به Cloudflare (مرورگر باز
می‌شود) → ساخت D1 → مهاجرت‌ها → دیپلوی → رمز → تأیید `/api/whoami` و `/panel`.
idempotent است، اجرای مجدد بی‌خطر.

حالت‌های دیگر:

```bash
bash scripts/activate.sh --dry-run          # فقط نقشه، بدون تغییر
CF_API_TOKEN=… bash scripts/activate.sh --yes   # بدون پرسش
```

> **ویندوز:** `activate.sh` به bash نیاز دارد → Git for Windows را نصب کنید و از
> Git Bash بزنید، یا مستقیم `npx wrangler deploy` را در PowerShell اجرا کنید
> (بقیه‌اش خودکار است).

جزئیات کامل و جدول عیب‌یابی: [`DEPLOY.md`](DEPLOY.md)

---

# مسیر ۳ — دستیار دیپلوی می‌کند

1. `https://dash.cloudflare.com/profile/api-tokens`
2. **Create Token** → پایین صفحه **Create Custom Token** → Get started
3. فقط این دو اجازه:

   | Permission | Level |
   |---|---|
   | Account · **Workers Scripts** | Edit |
   | Account · **D1** | Edit |

4. **Continue to summary** → **Create Token** → کپی کنید
5. در چت بفرستید و بگویید «دیپلوی کن»

دستیار دیپلوی می‌کند، آدرس زنده را با تأیید تحویل می‌دهد و یک رمز قوی برای پنل
می‌سازد. **بعدش توکن را Delete کنید** — رمز پنل به توکن ربطی ندارد.

---

# اگر جایی گیر کردید

| نشانه | علت | راه‌حل |
|---|---|---|
| همه‌ی مسیرها `error code: 1101` روی `*.workers.dev`، ولی روی دامنه‌ی اختصاصی سالم | زیردامنه‌ی workers.dev اکانت خراب است (روی یک اکانت واقعی دیده شد: حتی یک Worker سه‌خطی `return new Response("ok")` هم 1101 می‌داد، و `wrangler tail` هیچ رکوردی نمی‌گرفت چون درخواست هرگز به Worker نمی‌رسید) | روی دامنه‌ی اختصاصی ببر: `PUT /accounts/<id>/workers/domains` با `hostname` و `service`، یا داشبورد → Workers & Pages → Settings → Domains & Routes |
| `500` روی `/api/setup` و `NotSupportedError: iteration counts above 100000` | سقف PBKDF2 در workerd | حل شده: `src/auth/session.js` از `2x100000` زنجیره‌ای استفاده می‌کند. اگر عدد را عوض کردید، هر فراخوانی باید ≤ ۱۰۰٬۰۰۰ بماند |
| تونل `1011` با `cannot connect to the specified address` | مقصد پشت کلودفلر است (مثل `discord.com` یا `1.1.1.1`) و Worker اجازه‌ی اتصال به شبکه‌ی خود کلودفلر را ندارد | محدودیت پلتفرم. برای آن مقصدها، برای کاربر یک پروکسی بالادستی (SOCKS5 روی سرور خودتان) در تب کاربران تنظیم کنید |
| تونل `1011` با `upstream connect timeout after 8000ms` | مقصد خاموش یا مسیر بسته | هدف دیگری را تست کنید؛ `CONNECT_TIMEOUT_MS` قابل تنظیم است |
| ورود ۴۰۳ می‌دهد و رمز درست است | Guard بعد از سه پنجره‌ی متوالی تلاش ناموفق، IP را ۱۵ دقیقه ban می‌کند | `POST /api/diag/unban` با یک نشست فعال، یا ۱۵ دقیقه صبر، یا پاک کردن storage آبجکت Guard در داشبورد |
| دکمه‌ی Deploy خطای `repository not found` | ریپو Private است | Public کنید، یا از مسیر ۲/۳ بروید |
| `503` روی آدرس پنل | (فقط در نسخه‌های قدیمی) `SECRET` نبود | از این نسخه به بعد خودکار حل است؛ `wrangler deploy` دوباره |
| صفحه‌ی سفید روی `/panel` | service worker قدیمی | DevTools → Application → Service Workers → Unregister |
| ورود کار نمی‌کند بعد از دیپلوی مجدد | کلید امضا عوض شده | طبیعی نیست؛ در داشبورد D1 → سطر `signing_key` را پاک کنید تا دوباره ساخته شود (همه‌ی نشست‌ها بسته می‌شوند) |
| `D1_ERROR: no such table` | migration موقع بوت اجرا نشده | یک‌بار `/panel` را reload کنید؛ اگر ماند، لاگ‌ها را ببینید: `wrangler tail` |
| کرون کار نمی‌کند | تریگر ثبت نشده | داشبورد → Workers & Pages → kaveh → Settings → Triggers باید `*/10 * * * *` باشد |
| می‌خواهید دامنه‌ی خودتان | — | داشبورد → Workers & Pages → kaveh → Settings → Domains & Routes → Add |

---

# بعد از فعال‌سازی، سه کار که ارزشش را دارد

1. **آی‌پی تمیز** — تب تنظیمات → آی‌پی‌ها، بعد تب عیب‌یابی → «رتبه‌بندی آی‌پی تمیز»
   تا از لبه‌ی کلودفلر تست شوند و فقط سالم‌ها در اشتراک‌ها بروند.
2. **`SECRET` خودتان** — برای دیپلوی جدی، کلید امضا را با
   `wrangler secret put SECRET` ثابت کنید تا با ریستور دیتابیس از دست نرود.
3. **کد بازیابی** — `wrangler secret put RECOVERY_CODE`؛ اگر رمز پنل را گم کردید
   یک‌بار مصرف نجاتتان می‌دهد.
