# راهنمای فعال‌سازی کاوه

از صفر تا پنل زنده روی دامنه‌ی خودتان. هر مرحله قابل تأیید است: بعد از هرکدام
دستوری آمده که باید خروجی مشخصی بدهد. کل مسیر حدود ۱۰ دقیقه طول می‌کشد.

پیش‌نیاز: یک حساب Cloudflare (پلن رایگان کافی است)، Node.js نسخه‌ی ۲۰ یا بالاتر،
و یک دامنه که nameserverهایش روی Cloudflare باشد.

---

## راه کوتاه: یک دستور

اگر می‌خواهید همه‌ی مراحل ۱ تا ۷ خودکار اجرا شود:

```bash
bash scripts/activate.sh            # یا: npm run activate
```

قدم‌به‌قدم پیش می‌رود، `database_id` را خودش در `wrangler.toml` می‌نویسد،
مهاجرت‌ها را اعمال می‌کند، دیپلوی می‌کند، رمز را می‌پرسد (یا خودش یک رمز قوی
تصادفی می‌سازد و **یک‌بار** چاپ می‌کند)، و در آخر `/api/whoami` و `/panel` را روی
دامنه‌ی دیپلوی‌شده تست می‌کند. idempotent است — اجرای مجدد بی‌خطر است.

```bash
bash scripts/activate.sh --dry-run          # فقط نقشه را نشان می‌دهد
CF_API_TOKEN=… KAVEH_SECRET=… bash scripts/activate.sh --yes   # بدون پرسش
```

بقیه‌ی این سند همان مراحل را دستی توضیح می‌دهد — برای وقتی که می‌خواهید بدانید
دقیقاً چه اتفاقی می‌افتد، یا یک مرحله خطا داد.

---

## ۰) نصب وابستگی‌ها

```bash
npm ci
```

باید بدون خطا تمام شود. اگر `npm ci` ناموفق بود (فایل `package-lock.json` نبود)
از `npm install` استفاده کنید.

---

## ۱) ورود به Wrangler

```bash
npx wrangler login
```

مرورگر باز می‌شود، اجازه می‌دهید و در ترمینال پیام
`Successfully logged in` ظاهر می‌شود.

**اگر در محیط بدون مرورگر هستید** (سرور، SSH): از
`npx wrangler login --browser=false` استفاده کنید یا متغیر
`CLOUDFLARE_API_TOKEN` را با یک توکن دارای دسترسی `Workers Scripts: Edit` و
`D1: Edit` ست کنید.

---

## ۲) ساخت پایگاه‌داده‌ی D1

```bash
npx wrangler d1 create kaveh
```

خروجی چیزی شبیه این می‌دهد:

```toml
[[d1_databases]]
binding = "DB"
database_name = "kaveh"
database_id = "1a2b3c4d-...."
```

`database_id` واقعی را در `wrangler.toml` جایگزین کنید:

```bash
# لینوکس/مک — خودکار:
sed -i "s/database_id = \".*\"/database_id = \"$(npx wrangler d1 list --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).find(x=>x.name==="kaveh").uuid))')\"/" wrangler.toml
```

یا دستی: فایل `wrangler.toml` را باز کنید و مقدار `database_id` را بگذارید.

تأیید: `grep database_id wrangler.toml` نباید دیگر مقدار نمونه
`00000000-0000-...` را نشان دهد.

---

## ۳) اجرای مهاجرت‌ها روی D1 واقعی

```bash
npx wrangler d1 migrations apply kaveh --remote
```

باید بپرسد «OK to proceed?» → `y`. خروجی:
`🌀 Mapping SQL input into an array of statements` و در نهایت
`✅ Migration applied`.

تأیید:

```bash
npx wrangler d1 execute kaveh --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
```

باید این جدول‌ها را ببینید: `settings`, `users`, `sessions`, `audit_log`,
`usage_daily`, `kv`, `alerts`, `outbox`.

> نکته: `wrangler dev --local` از یک D1 محلی استفاده می‌کند و مهاجرت‌ها را خودش
> اعمال می‌کند؛ برای پروداکشن حتماً پرچم `--remote` لازم است.

---

## ۴) گذاشتن رمز اصلی (مهم‌ترین مرحله)

```bash
npx wrangler secret put SECRET
```

یک رمز قوی وارد کنید (حداقل ۱۶ کاراکتر؛ ترکیب حروف، عدد و نماد). این رمز
تنها راه ورود به پنل است و **در D1 ذخیره نمی‌شود** — فقط هش PBKDF2 آن.

اختیاری ولی توصیه‌شده:

```bash
npx wrangler secret put RECOVERY_CODE   # کد بازیابی یک‌بارمصرف، اگر رمز را گم کردید
```

تأیید: `npx wrangler secret list` باید `SECRET` را نشان دهد.

> بدون `SECRET`، Worker عمداً با خطای ۵۰۳ بالا می‌آید و در لاگ می‌نویسد
> `boot_incomplete`. این یک باگ نیست: یعنی پنل با تنظیمات پیش‌فرض قفل باز
> بالا نیامده است.

---

## ۵) استقرار

```bash
npm run deploy
```

خروجی پایانی باید شامل این‌ها باشد:

```
Published kaveh (x.xx sec)
  https://kaveh.<your-subdomain>.workers.dev
Current Version ID: ...
```

اگر دامنه‌ی اختصاصی می‌خواهید:

```bash
npx wrangler deploy   # همان npm run deploy
# سپس در داشبورد: Workers & Pages → kaveh → Settings → Domains & Routes → Add
```

یا مستقیم با Wrangler:

```bash
npx wrangler domains add panel.example.com   # اگر دامنه روی همان اکانت باشد
```

---

## ۶) تأیید زنده بودن

```bash
BASE=https://kaveh.<your-subdomain>.workers.dev   # آدرس خودتان

curl -s $BASE/api/whoami
# → {"ok":true,"installed":true,"configured":true,...}

curl -s -o /dev/null -w "%{http_code}\n" $BASE/panel
# → 200
```

سپس در مرورگر `$BASE/panel` را باز کنید، رمز مرحله‌ی ۴ را بزنید.

---

## ۷) تأیید کرون (Cron Trigger)

در `wrangler.toml` این خط هست:

```toml
[triggers]
crons = ["*/10 * * * *"]
```

یعنی هر ۱۰ دقیقه یک‌بار نگهداشت اجرا می‌شود: انقضای کاربران، چرخش آی‌پی تمیز،
پاک‌سازی نشست‌های مرده، فلاش شمارنده‌ی ترافیک.

**دو راه برای تأیید:**

1. داشبورد → Workers & Pages → kaveh → Settings → Triggers: باید
   `*/10 * * * *` را ببینید.
2. پنل → تب «عیب‌یابی» → کارت «اجرای نگهداشت» → دکمه‌ی اجرا. همان کدی را
   صدا می‌زند که کرون صدا می‌زند و خلاصه‌ی کار را نشان می‌دهد:

   ```json
   {"expired_handled":0,"policy":"disable","ips_rotated":0,"sessions_purged":0,"ms":18}
   ```

   این کارت برای همین اضافه شد: در Zeus نگهداشت داخل `ctx.waitUntil()` هر
   درخواست کاربر اجرا می‌شود، پس نه قابل فراخوانی است و نه قابل مشاهده — اگر
   خاموش شود، فقط وقتی می‌فهمید که مشتری شکایت کند.

3. یا لاگ زنده:

   ```bash
   npx wrangler tail --format pretty
   ```

   باید هر ۱۰ دقیقه خط `maintenance.done` را ببینید.

> در `wrangler dev --local` اندپوینت `/cdn-cgi/handler/scheduled` با این ترکیب
> (Assets + Durable Objects + wrangler 4.86) بدون فراخوانی هندلر خطای
> `exception` می‌دهد. به همین دلیل بدنه‌ی کرون به ماژول مستقل
> `src/core/maintenance.js` منتقل شد و از طریق `POST /api/diag/maintenance`
> تست می‌شود — همان کد، دو نقطه‌ی ورود. اسکریپت دود محلی هم همین را می‌سنجد.

---

## ۸) تست کامل قبل از تحویل به کاربر

هر وقت چیزی عوض کردید، قبل از `deploy`:

```bash
npm test                          # ۲۹ تست واحد
node scripts/lint.js              # تحلیل ایستا: معماری + امنیت + بودجه‌ی بایت
npx wrangler dev --local &        # Worker محلی با همه‌ی bindingها
bash scripts/smoke.sh             # ۳۲ بررسی زنده روی Worker واقعی
```

اسکریپت دود (`smoke.sh`) این‌ها را واقعاً اجرا می‌کند، نه mock:

| دسته | چه چیزی سنجیده می‌شود |
|---|---|
| بوت | `/api/whoami`، وضعیت نصب |
| احراز هویت | ورود، کوکی `HttpOnly; SameSite=Strict`، ۴۰۱ بدون جلسه |
| کاربران | ساخت/خواندن/حذف در D1، تکراری → ۴۰۹، صدور ۴ فرمت کانفیگ |
| اشتراک | `/s/<token>` در سه فرمت (v2ray/sing-box/clash)، توکن نامعتبر → ۴۰۴، صفحه‌ی وضعیت |
| دسته‌جمعی | `POST /api/users/bulk` در یک batch |
| تنظیمات | ذخیره، و **اینکه هش رمز ادمین هرگز به مرورگر نمی‌رود** |
| ممیزی | ثبت رویداد، و اینکه IP خام ذخیره نمی‌شود (فقط هش) |
| CSRF | درخواست تغییردهنده بدون هدر → ۴۰۳ |
| محدودسازی | ۱۲ ورود ناموفق از یک IP → ۴۲۹ (Durable Object `Guard`) |
| نگهداشت | `POST /api/diag/maintenance` → خلاصه‌ی JSON |
| **تونل** | یک اتصال VLESS واقعی: WebSocket → کنترل پذیرش → تجزیه‌ی هدر → `connect()` → پمپ بایت → گزارش مصرف. بایت واقعی از `cp.cloudflare.com:80` برمی‌گردد |

خروجی موفق: `── 32 passed, 0 failed`.

```bash
BASE=http://127.0.0.1:8787 PASSWORD='kaveh-demo-1234' bash scripts/smoke.sh
```

تست تونل به‌تنهایی:

```bash
node --experimental-websocket scripts/ws-probe.js http://127.0.0.1:8787 <uuid> cp.cloudflare.com 80
```

---

## ۹) حلقه‌ی توسعه‌ی محلی

```bash
# ترمینال ۱ — Worker واقعی (D1 محلی، DO محلی، Assets از ui/)
npx wrangler dev --local --ip 0.0.0.0 --port 8787

# ترمینال ۲ — فایل .dev.vars برای secretهای محلی
cat > .dev.vars <<'EOF'
SECRET=kaveh-demo-1234
RECOVERY_CODE=recover-me
EOF
```

`wrangler dev` با تغییر فایل‌ها خودش reload می‌کند. توجه کنید که **بدون
`.dev.vars` Worker با ۵۰۳ بالا می‌آید** (همان گارد بوت مرحله‌ی ۴).

اگر خواستید D1 محلی را از صفر بسازید:

```bash
rm -rf .wrangler/state
npx wrangler dev --local   # مهاجرت‌ها را دوباره اعمال می‌کند
```

---

## ۱۰) عیب‌یابی سریع

| نشانه | علت | راه‌حل |
|---|---|---|
| همه‌ی مسیرها `error code: 1101` روی `*.workers.dev`، ولی روی دامنه‌ی اختصاصی سالم | زیردامنه‌ی workers.dev اکانت خراب است (روی یک اکانت واقعی دیده شد: حتی یک Worker سه‌خطی `return new Response("ok")` هم 1101 می‌داد، و `wrangler tail` هیچ رکوردی نمی‌گرفت چون درخواست هرگز به Worker نمی‌رسید) | روی دامنه‌ی اختصاصی ببر: `PUT /accounts/<id>/workers/domains` با `hostname` و `service`، یا داشبورد → Workers & Pages → Settings → Domains & Routes |
| `500` روی `/api/setup` و `NotSupportedError: iteration counts above 100000` | سقف PBKDF2 در workerd | حل شده: `src/auth/session.js` از `2x100000` زنجیره‌ای استفاده می‌کند. اگر عدد را عوض کردید، هر فراخوانی باید ≤ ۱۰۰٬۰۰۰ بماند |
| تونل `1011` با `cannot connect to the specified address` | مقصد پشت کلودفلر است (مثل `discord.com` یا `1.1.1.1`) و Worker اجازه‌ی اتصال به شبکه‌ی خود کلودفلر را ندارد | محدودیت پلتفرم. برای آن مقصدها، برای کاربر یک پروکسی بالادستی (SOCKS5 روی سرور خودتان) در تب کاربران تنظیم کنید |
| تونل `1011` با `upstream connect timeout after 8000ms` | مقصد خاموش یا مسیر بسته | هدف دیگری را تست کنید؛ `CONNECT_TIMEOUT_MS` قابل تنظیم است |
| ورود ۴۰۳ می‌دهد و رمز درست است | Guard بعد از سه پنجره‌ی متوالی تلاش ناموفق، IP را ۱۵ دقیقه ban می‌کند | `POST /api/diag/unban` با یک نشست فعال، یا ۱۵ دقیقه صبر، یا پاک کردن storage آبجکت Guard در داشبورد |
| `503` + لاگ `boot_incomplete` | `SECRET` گذاشته نشده | مرحله‌ی ۴ |
| `D1_ERROR: no such table: users` | مهاجرت روی D1 واقعی اعمال نشده | مرحله‌ی ۳ با `--remote` |
| `/panel` صفحه‌ی سفید | کش service worker قدیمی | در DevTools → Application → Unregister، یا `sw.js` نسخه را بالا ببرید |
| تونل `101` می‌گیرد ولی بایت نمی‌آید | لاگ `tunnel_write_error` را بخوانید؛ اگر `vless header too short` با `head: "5b 6f 62 6a"` دیدید یعنی فریم باینری به‌صورت Blob رسیده | تابع `toBytes()` در `src/proxy/vless.js` این را حل می‌کند؛ اگر خودتان هندلر پیام نوشتید، از آن استفاده کنید |
| تونل `403` | uuid ناشناخته / کاربر غیرفعال / منقضی / حجم تمام | `GET /api/users/:username` را چک کنید |
| تونل `429` | سقف دستگاه همزمان (`max_devices`) پر شده | Ledger DO را در تب نشست‌ها ببینید |
| کرون اجرا نمی‌شود | تریگر ثبت نشده | مرحله‌ی ۷، بند ۱ |
| `Cannot access 'cfUsage2' before initialization` | re-export چرخه‌ای یک نماد از دو ماژول | نماد را مستقیم import کنید، نه re-export |

---

## چک‌لیست نهایی

- [ ] `database_id` واقعی در `wrangler.toml`
- [ ] `npx wrangler d1 migrations apply kaveh --remote` اجرا شد
- [ ] `SECRET` گذاشته شد (و `RECOVERY_CODE` جای امن ذخیره شد)
- [ ] `npm test` → ۲۹/۲۹
- [ ] `bash scripts/smoke.sh` → ۳۲/۳۲ (شامل تونل واقعی)
- [ ] `npm run deploy` بدون خطا
- [ ] `$BASE/api/whoami` → `"installed":true`
- [ ] `$BASE/panel` → ۲۰۰ و ورود موفق
- [ ] تب عیب‌یابی → «اجرای نگهداشت» → خلاصه‌ی JSON
- [ ] `npx wrangler tail` → خط `maintenance.done`
