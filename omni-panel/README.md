# ⚒️ کاوه — Kaveh Panel

پنل مدیریت پروکسی **VLESS/Trojan روی Cloudflare Workers** — از صفر، ماژولار، بدون CDN، بدون DRM، بدون قفل روی اسم.

<div align="center">

[![Deploy with Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Alisarani7021/kaveh)

**نسخه‌ی خودت را روی اکانت کلودفلر خودت بساز — سه ضربه، بدون ترمینال، بدون کارت بانکی**

[![ci](https://github.com/Alisarani7021/kaveh/actions/workflows/ci.yml/badge.svg)](https://github.com/Alisarani7021/kaveh/actions/workflows/ci.yml)
![license MIT](https://img.shields.io/badge/license-MIT-blue)
![tests 47/47](https://img.shields.io/badge/tests-47%2F47-brightgreen)
![first load 36 KB gzip](https://img.shields.io/badge/first_load-36%20KB%20gzip-orange)

</div>

> هدف این پروژه: همان کاری که Zeus Panel می‌کند، اما با معماری، امنیت، سرعت و تجربه‌ی کاربری‌ای که برای نگه‌داری بلندمدت ساخته شده باشد.
> مقایسه‌ی بند‌به‌بند و مستند: [`docs/AUDIT.md`](docs/AUDIT.md)

---

## نسخه‌ی شخصی خودت — روی اکانت کلودفلر خودت

این پنل «سرویس» نیست که کسی وسط باشد؛ یک قالب است که هر کس روی اکانت خودش
دیپلوی می‌کند. پس نسخه‌ی هر کسی کاملاً جداست: Worker خودش، دیتابیس D1 خودش،
کلید امضای نشست‌های خودش، رمز مدیر خودش. هیچ داده‌ای به هیچ‌کس — از جمله نویسنده
— ارسال نمی‌شود و هیچ سرور میانی‌ای وجود ندارد.

**دکمه‌ی بالا چه کار می‌کند؟** Cloudflare را به این ریپو وصل می‌کند و
`wrangler deploy` را سمت خودش اجرا می‌کند. بقیه‌اش خودکار است:

| مرحله | چه اتفاقی می‌افتد |
|---|---|
| دیتابیس | `database_id` عمداً در `wrangler.toml` نیست؛ Wrangler ≥ ۴.۴۵ موقع دیپلوی D1 را می‌سازد |
| اسکیما | موقع بالا آمدن Worker از `schema/*.sql` اعمال می‌شود (`src/db/migrate.js`)، یک‌بار به ازای هر isolate |
| کلید امضا | نبود `SECRET` مانع بوت نیست؛ یک کلید ۲۵۶ بیتی تولید و در D1 ذخیره می‌شود |
| رمز مدیر | اولین بازدید از `/panel` صفحه‌ی راه‌اندازی را نشان می‌دهد و رمز را می‌سازد |
| کرون | `[triggers] crons = ["*/10 * * * *"]` با همان دیپلوی ثبت می‌شود |

**⚠️ تنها نکته‌ی امنیتی:** بلافاصله بعد از دیپلوی آدرس پنل را باز کن و رمز را
بساز. تا وقتی `installed=false` است، هر کس آدرس را داشته باشد می‌تواند خودش رمز
بگذارد و مالک پنل شود. بعد از ساخت رمز، `/api/setup` برای همیشه بسته می‌شود.

**اگر `*.workers.dev` اکانتت خراب بود** (همه‌ی مسیرها `error code: 1101`، حتی
یک Worker سه‌خطی): پنل را روی دامنه‌ی خودت ببر — داشبورد → Workers & Pages →
Settings → Domains & Routes. این حالت روی یک اکانت واقعی دیده و مستند شده است
(`docs/START-HERE.md`).

راه‌های دیگر: [`docs/START-HERE.md`](docs/START-HERE.md) (گوشی/گیت‌هاب/توکن) ·
[`docs/DEPLOY.md`](docs/DEPLOY.md) (CLI، کامل) · `bash scripts/activate.sh`

---

## ۳۰ ثانیه‌ای ببینیدش

```bash
npm run ui          # → http://localhost:5173
# رمز عبور دمو: kaveh1234567
```

این سرورِ توسعه، **دقیقاً همان قرارداد JSON ورکر واقعی** را با داده‌ی ساختگی پیاده می‌کند؛ یعنی هر چیزی که در پیش‌نمایش کار می‌کند، روی Cloudflare هم کار می‌کند. یک تست قرارداد (`test/contract.test.js`) در CI جلوی واگرایی این دو را می‌گیرد.

## نصب

### راه صفر‌ترمینالی — از گوشی، با یک ضربه

دکمه‌ی بالای همین صفحه را بزنید (یا مستقیم برو
[اینجا](https://deploy.workers.cloudflare.com/?url=https://github.com/Alisarani7021/kaveh)):
وارد اکانت GitHub شو، اجازه بده Cloudflare ریپو را ببیند، نام Worker را تأیید کن،
Done. دکمه، Cloudflare را به ریپو وصل می‌کند و `wrangler deploy` را سمت خودش
اجرا می‌کند. بقیه‌اش خودکار است:

- پایگاه‌داده‌ی D1 خودش ساخته می‌شود — `database_id` عمداً در `wrangler.toml`
  نیست و Wrangler ≥ ۴.۴۵ آن را موقع دیپلوی provision می‌کند
- اسکیما موقع بالا آمدن از همان فایل‌های `schema/*.sql` اعمال می‌شود
  (`src/db/migrate.js`) — چون `wrangler d1 migrations apply --remote` با
  دیتابیس auto-provisioned کار نمی‌کند (workers-sdk#13632)
- کلید امضای نشست‌ها تولید و در D1 ذخیره می‌شود، پس `wrangler secret put SECRET`
  لازم نیست
- اولین باری که `/panel` را باز کنید، خودتان رمز مدیر را می‌سازید

تنها نکته‌ی امنیتی: چون URL پنل عمومی است، **بلافاصله** بعد از دیپلوی بازش کنید
و رمز را بسازید — هر کس زودتر برسد، مالک پنل می‌شود. بعد از آن `installed=true`
است و `/api/setup` بسته می‌شود.

جزئیات: [`docs/START-HERE.md`](docs/START-HERE.md) · راهنمای کامل CLI: [`docs/DEPLOY.md`](docs/DEPLOY.md)

### راه CLI — وقتی ترمینال دارید

همان نتیجه، با کنترل بیشتر. یا یک‌جا:

```bash
bash scripts/activate.sh          # همه‌ی مراحل + تأیید پایانی
```

یا دستی:

```bash
npm ci
npx wrangler login
npx wrangler deploy               # D1 خودش ساخته می‌شود، اسکیما خودش اعمال می‌شود
```

و تمام — آدرس `https://kaveh.<subdomain>.workers.dev/panel` را باز کنید و رمز
مدیر را بسازید.

سه کار اختیاری که برای دیپلوی جدی توصیه می‌شود:

```bash
# ۱. کلید امضای نشست‌ها را خودتان تعیین کنید (به‌جای کلید تولیدشده)
npx wrangler secret put SECRET

# ۲. کد بازیابی یک‌بارمصرف، اگر رمز پنل را گم کردید
npx wrangler secret put RECOVERY_CODE

# ۳. دیتابیس و مهاجرت‌های صریح، به‌جای provisioning خودکار
npx wrangler d1 create kaveh
npx wrangler d1 migrations apply kaveh --remote
```

### تغییر اسم پنل — یک دستور

```bash
node scripts/rename.js "MyPanel" "مای‌پنل"
```

هیچ «هسته‌ی درهم‌تنیده‌ی ریاضی» و هیچ واترمارک اجباری‌ای وجود ندارد. لایسنس MIT است.

---

## معماری

```
kaveh/
├── wrangler.toml              # D1 + 2 Durable Object + assets binding
├── schema/0001_init.sql       # مهاجرت نسخه‌دار (نه CREATE TABLE در هر ریکوئست)
├── src/                       # ← ورکر: ~۱۱۳ KB با احتساب کامنت‌ها
│   ├── index.js               # ورودی + روتر + scheduled()
│   ├── core/                  # router · middleware · env · errors · http
│   ├── db/                    # لایه‌ی D1 · Settings · audit · users repo
│   ├── auth/                  # PBKDF2 · نشست امضاشده · Guard (DO)
│   ├── proxy/                 # vless · tunnel · udp · upstream (socks4/5, http)
│   ├── net/dns.js             # DoH با کش LRU
│   ├── config/                # generator (vless/sing-box/clash) · fragment · cleanip
│   └── api/                   # auth · users · stats · sub · diag
├── ui/                        # ← فرانت: ۳۶ KB gzip برای بار اول، صفر CDN
│   ├── index.html · icon.svg · manifest.webmanifest · sw.js
│   └── assets/{app,api,i18n,charts,components,views}.js · app.css · vendor/qrcode.js
├── server/dev.js              # سرور توسعه + mock API
├── scripts/{lint,build,rename}.js
├── test/                      # ۲۵ تست، بدون هیچ وابستگی
└── .github/workflows/ci.yml
```

هر فایل یک مسئولیت دارد. افزودن یک قابلیت = افزودن یک خط به روتر + یک هندلر + یک ویو.

---

## چه چیزی واقعاً بهتر است

| حوزه | Zeus | کاوه |
|---|---|---|
| **ساختار** | یک فایل ۶۳۴ KB / ۱۱٬۰۰۰ خط: پروکسی + SQL + HTML + CSS + ۳٬۰۰۰ خط JS فرانت | ۳۰ ماژول با مرز مشخص؛ بک‌اند ۱۱۳ KB، فرانت جدا و کش‌شده روی edge |
| **فرانت** | Tailwind + Three.js + flag-icons + Vazirmatn + Sortable + qr-code-styling از ۴ CDN | صفر CDN. ۳۶ KB gzip. QR به‌صورت محلی vendor شده |
| **بار اول** | ورکر رشته‌ی ۶۰۰ KB را در هر بارگذاری می‌سازد | `assets` مستقیم از POP کلودفلر، بدون مصرف CPU ورکر |
| **شمارش ترافیک** | `Map` در حافظه‌ی isolate → با هر evict شدن، آمار گم می‌شود | Durable Object `Ledger`: شمارش دقیق، فلاش دسته‌ای به D1، بازگردانی در صورت خطا |
| **محدودیت دستگاه** | در حافظه‌ی هر POP جداگانه | سراسری، **قبل** از باز شدن تونل |
| **رمز عبور** | SHA-256 بدون salt (کرک GPU در چند میلی‌ثانیه) | PBKDF2-SHA256 + salt تصادفی + ۲۱۰٬۰۰۰ تکرار + مقایسه‌ی زمان‌ثابت |
| **محافظت brute-force** | `LOGIN_ATTEMPTS` در `Map` → با چرخش بین POPها بی‌اثر | DO `Guard` با پنجره‌ی لغزان + بن خودکار |
| **نشست‌ها** | — | کوکی امضاشده‌ی HMAC + ردیف سرور برای لغو فوری + «خروج از همه‌ی نشست‌ها» |
| **CSRF / CSP** | هیچ | `SameSite=Strict` + هدر سفارشی برای همه‌ی درخواست‌های تغییردهنده + CSP سخت‌گیرانه |
| **گزارش رویداد** | ندارد | جدول `audit_log`: چه کسی، چه کاری، روی چه کاربری، چه زمانی (IP فقط به‌صورت هش) |
| **کار زمان‌بندی‌شده** | `ctx.waitUntil` روی **هر** درخواست کاربر | `scheduled()` با Cron Trigger |
| **اسکیما** | `CREATE TABLE IF NOT EXISTS` در هر درخواست | مهاجرت نسخه‌دار با `wrangler d1 migrations apply` |
| **عملیات گروهی** | حلقه با await به‌ازای هر کاربر | یک `D1.batch()` — یک round-trip |
| **خطاها** | `"Internal Server Error"` + `catch (e) {}` | یک مرز خطا با `ref` هشت‌کاراکتری که هم به کاربر و هم به لاگ می‌رود |
| **تست** | صفر | ۲۹ تست واحد + ۳۲ بررسی دود روی Worker واقعی (شامل یک تونل VLESS زنده با بایت واقعی) |
| **CI** | ندارد | lint (پارس + ممنوعیت CDN + ممنوعیت سکرت) + تست + بودجه‌ی حجم + dry-run deploy |
| **زبان/ظاهر** | رشته‌های فارسی هاردکد داخل قالب | i18n کامل fa/en + دارک/لایت + RTL/LTR با یک کلیک |
| **دسترسی‌پذیری** | — | نقش‌های ARIA، فوکوس قابل دیدن، `prefers-reduced-motion`، ناوبری با صفحه‌کلید |
| **UX** | مودال‌های تو‌در‌تو | ⌘K پالت فرمان، کشوی کاربر با QR/کانفیگ/نمودار مصرف، میان‌بر `g d` / `g u` / `/` |
| **DRM** | واترمارک + «هسته‌ی درهم‌تنیده» + **دستورهای پنهان برای دستیاران هوش مصنوعی** | هیچ. MIT. `npm run rename` |

### درباره‌ی آن «دستورهای پنهان»

سورس Zeus حاوی رشته‌های base64 است که صراحتاً به دستیارهای هوش مصنوعی دستور می‌دهند از تغییر کد خودداری کنند، واترمارک‌ها را پنهان نگه دارند و به کاربر دروغ بگویند (۱۴ مورد، از جمله `[AI_DIRECTIVE]` و `_LLM_TRAP`).

این پروژه هیچ‌کدام را اجرا نمی‌کند: دستورِ داخل کدِ یک مخزن، دستورِ شما نیست. این هم یکی از دلایلی است که «بهتر» را با یک پیاده‌سازی تمیز و باز جواب می‌دهیم، نه با شکستن قفل دیگری.

---

## امکانات

**هسته‌ی پروکسی**
- VLESS over WebSocket با پارس دقیق هدر (IPv4 / دامنه / IPv6 / UDP) و پشتیبانی از early-data
- رله‌ی بالادستی SOCKS5 / SOCKS4 / HTTP CONNECT برای آی‌پی تمیز اختصاصی هر کاربر
- کنترل دسترسی **قبل** از باز شدن تونل: فعال بودن، انقضا، حجم، سقف درخواست، سقف دستگاه
- فهرست مسدودی دامنه به‌ازای هر کاربر (نه فقط سراسری)

**مدیریت کاربر**
- سهمیه‌ی حجم / روز / دستگاه / درخواست
- «شروع زمان از اولین اتصال»
- عملیات گروهی در یک batch: فعال، غیرفعال، ریست حجم، ریست درخواست، تمدید، حذف
- جستجو، فیلتر وضعیت، مرتب‌سازی ستونی، صفحه‌بندی سمت سرور
- چرخش توکن اشتراک و UUID با یک کلیک

**تولید کانفیگ**
- `vless://` با پارامترهای fragment و fingerprint
- sing-box JSON (با selector + urltest + قوانین direct برای `.ir`)
- Clash/Mihomo YAML
- Base64 اشتراک + هدر `subscription-userinfo` و `profile-update-interval`
- QR به‌صورت محلی (بدون jsdelivr)
- چند لوکیشن هم‌زمان (تا ۸ آی‌پی)

**شبکه و عبور از فیلترینگ**
- پریست فرگمنت برای MCI / ایرانسل / رایتل / مخابرات / تهاجمی / گیمینگ
- شبیه‌ساز ClientHello: chrome, safari, ios, android, edge, firefox, randomized
- مخزن آی‌پی تمیز + رتبه‌بندی از لبه‌ی کلودفلر + چرخش خودکار با Cron
- Mux اختیاری

**امنیت و مشاهده‌پذیری**
- PBKDF2 + نشست امضاشده + Guard DO + CSP + CSRF + `X-Frame-Options: DENY`
- `audit_log` با هش IP
- لاگ ساخت‌یافته‌ی JSON با `wrangler tail` قابل خواندن
- سهمیه‌ی کلودفلر با هشدار قبل از رسیدن به مرز بن
- بک‌آپ/بازیابی کامل JSON

**PWA**
- نصب‌شدنی، service worker با stale-while-revalidate، صفحه‌ی آفلاین اختصاصی
- برخلاف Zeus که کش کردنش با یک CDN در دسترس نباشد کامل شکست می‌خورد، اینجا هر فایل جداگانه کش می‌شود

---

## تست‌ها

```bash
npm test          # 25 تست
npm run lint      # پارس ESM + ممنوعیت CDN + ممنوعیت سکرت
npm run build     # گزارش بودجه‌ی حجم (بار اول: ۳۶ KB gzip)
```

پوشش فعلی: پارس/ساخت هدر VLESS برای هر سه نوع آدرس و UDP، رد کردن هدر ناقص، استخراج UUID از مسیر WS و base64، تطبیق فهرست مسدودی، تولید `vless://` و sing-box و Clash، رفت‌وبرگشت base64، هدر `subscription-userinfo`, پریست‌های فرگمنت، انتخاب آی‌پی تمیز، پارسر پروکسی، نمک‌گذاری و تأیید رمز، رد کردن هش SHA-256 قدیمی، امضا/انقضا/لغو نشست، دستکاری کوکی، مسیریابی و ۴۰۵ در برابر ۴۰۴، و قرارداد mock↔worker.

---

## آنچه اجرای واقعی لو داد

این پروژه فقط «نوشته» نشده — روی `wrangler dev --local` با همه‌ی bindingها
(D1، دو Durable Object، Assets) اجرا شد و ۳۲ بررسی زنده رویش پاس شد. این‌ها
باگ‌هایی است که **فقط** با اجرا پیدا شدند و هیچ‌کدام در کد نوشته‌شده قابل دیدن
نبودند:

| # | باگ | چطور پیدا شد | چرا مهم بود |
|---|---|---|---|
| ۱ | فریم باینری WebSocket در workerd به‌صورت `Blob` می‌رسد، نه `ArrayBuffer` | لاگ ساختاریافته: `tunnel_write_error` با `head: "5b 6f 62 6a"` یعنی رشته‌ی `[object Blob]` | **هر اتصال** را می‌کشت — هدر VLESS به ۱۳ بایت زباله تبدیل می‌شد |
| ۲ | رقابت در تونل: بایت‌هایی که حین `await` روی DNS+connect می‌رسیدند به‌عنوان هدر دوم تفسیر می‌شدند | `vless header too short` بلافاصله بعد از `tunnel_open` | روی شبکه‌ی کند، اتصال‌های سالم قطع می‌شدند |
| ۳ | روتر ترتیب «literal قبل از param» را رعایت نمی‌کرد | تست رگرسیون جدید | `/api/users/bulk` به `/api/users/:username` می‌رفت |
| ۴ | `setup()` کوکی را روی هدرهای پاسخ ست نمی‌کرد | ۴۰۱ پشت‌سرهم در مرورگر، ۲۰۰ در curl | ورود در مرورگر ممکن نبود |
| ۵ | re-export چرخه‌ای یک نماد از دو ماژول → باندلر تغییر نام می‌دهد → TDZ | `Cannot access 'cfUsage2' before initialization` | داشبورد با ۵۰۰ بالا می‌آمد |
| ۶ | هندلرها آرگومان سوم را ctx می‌گیرند، نه URL | `url.searchParams is undefined` | سه اندپوینت مرده بودند |
| ۷ | مسیر تونل (`/<uuid>`) توسط سرور Assets بلعیده می‌شد | handshake با `Sec-Fetch-Mode: navigate` → index.html با ۲۰۰ | تونل اصلاً به Worker نمی‌رسید |
| ۸ | `scheduled()` که throw کند فقط رشته‌ی `exception` برمی‌گرداند، بدون هیچ لاگی | curl روی `/cdn-cgi/handler/scheduled` | انقضا خاموش از کار می‌افتاد و هیچ‌کس نمی‌فهمید |
| ۹ | `connect()` و DoH بدون timeout | «runtime canceled this request because your Worker's code had hung» | یک isolate آویزان، کل درخواست را می‌کشت |
| ۱۰ | **workerd سقف PBKDF2 را روی ۱۰۰٬۰۰۰ تکرار گذاشته** | `NotSupportedError: iteration counts above 100000 are not supported (requested 210000)` روی `/api/setup` در پروداکشن | **پنل هرگز نصب نمی‌شد.** WebCrypto نود سقف ندارد، پس ۴۷ تست و `wrangler dev` هیچ‌کدام نمی‌توانستند بگیرندش — فقط دیپلوی واقعی |
| ۱۱ | Worker به شبکه‌ی خود کلودفلر `connect()` نمی‌کند | `proxy request failed, cannot connect to the specified address` برای `cp.cloudflare.com`، `discord.com`، `1.1.1.1` | مقصدهای پشت کلودفلر از تونل خام TCP نمی‌گذرند؛ محدودیت پلتفرم است (Zeus هم همین‌طور)، پس هدف تست عوض شد و پیام خطا دقیق شد |
| ۱۲ | `db.batch()` با Promise پر شده بود نه statement | تست واحد با یک D1 ساختگیِ ضبط‌کننده | روی D1 واقعی «تصادفی» کار می‌کرد و جای دیگر نه |
| ۱۳ | بلوک `[[rules]]` برای `.sql` | هشدار خود wrangler: قانون شما بدون `fallthrough` جلوی پیش‌فرض‌های `.txt`/`.html` را می‌گیرد | wrangler از قبل `**/*.sql` را Text می‌شناسد؛ بلوک من اضافی و مضر بود |

**و سه موردی که فقط دیپلوی واقعی روی اکانت واقعی لو داد** (بند ۱۰ تا ۱۲):
هیچ‌کدام با تست محلی قابل گرفتن نبودند، چون `wrangler dev` روی workerd محلی
اجرا می‌شود نه workerd پروداکشن، و WebCrypto نود سقف تکرار PBKDF2 ندارد.
به همین دلیل `scripts/deploy-remote.sh` بعد از دیپلوی واقعاً `/api/whoami` و
`/panel` را صدا می‌زند و `scripts/smoke.sh` روی آدرس پروداکشن هم اجرا می‌شود:
**۳۳ بررسی، همه سبز، روی دامنه‌ی واقعی.**

نتیجه‌ی مستقیم بند ۸: بدنه‌ی کرون به ماژول مستقل `src/core/maintenance.js`
منتقل شد که **دو نقطه‌ی ورود** دارد — `scheduled()` و
`POST /api/diag/maintenance`. پس هم قابل تست است، هم در پنل یک دکمه دارد که
خلاصه‌ی کار را نشان می‌دهد. در Zeus این منطق داخل `ctx.waitUntil()` هر درخواست
کاربر است: نه قابل فراخوانی، نه قابل مشاهده.

---

## نقشه‌ی راه

**v0.2**
- [ ] Trojan over WebSocket (اسکلت موجود در `proxy/`، نیاز به تکمیل هندشیک)
- [ ] اجرای واقعی مهاجرت‌ها با miniflare در تست یکپارچگی
- [ ] مسیریابی هوشمند: انتخاب نود بر اساس سلامت و تأخیر لحظه‌ای
- [ ] موتور مسدودسازی DoH با کش و فهرست به‌روزشونده

**v0.3**
- [ ] نقش‌ها: owner / admin / reseller / user با سهمیه‌ی فروش
- [ ] پلن‌ها و پرداخت (زرین‌پال، NowPayments) + ساخت خودکار کاربر پس از پرداخت
- [ ] پورتال سلف‌سرویس کاربر (تمدید، مشاهده‌ی مصرف، دریافت QR)
- [ ] ربات تلگرام برای دیپلوی و مدیریت (معادل `@ZEUS_PANEL_BOT`)

**v0.4**
- [ ] Analytics Engine به‌جای `usage_daily` برای نمودارهای بلندمدت
- [ ] TOTP 2FA برای ورود مدیر
- [ ] دیپلوی خودکار از طریق Deploy with Workers

---

## مسئولیت

این ابزار برای دسترسی به اینترنت آزاد نوشته شده است. استفاده از Workers به‌عنوان پروکسی با بخش ۲.۸ شرایط استفاده‌ی Cloudflare در تضاد است و ممکن است به محدود شدن اکانت منجر شود؛ پیش از استقرار روی اکانت اصلی، این ریسک را بپذیرید. هیچ تضمینی وجود ندارد و هیچ داده‌ای به نویسنده ارسال نمی‌شود.

## لایسنس

MIT — هر کاری می‌خواهید بکنید، از جمله فروختن، تغییر اسم، و حذف این فایل.
