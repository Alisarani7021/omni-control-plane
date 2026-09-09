# مدل امنیتی و کنترل‌های V13

## کنترل‌های اعمال‌شده

- حذف کامل secretهای hardcoded و fallback.
- نبود password login و نبود Cookie پرچمی قابل جعل.
- نشست تصادفی ۲۵۶ بیتی؛ فقط hash در D1.
- login link یک‌بارمصرف، کوتاه‌عمر و وابسته به tenant.
- OAuth Authorization Code با client secret و PKCE/S256.
- state یک‌بارمصرف وابسته به همان session.
- envelope encryption واقعی: یک DEK تصادفی ۲۵۶ بیتی برای هر مقدار، AES-256-GCM برای داده، wrap شدن DEK با KEK موجود در Worker Secret و AAD وابسته به رکورد.
- Telegram webhook secret header + deduplication update ID.
- نبود endpoint عمومی برای setWebhook.
- محدودیت origin روی تمام mutationهای browser برای CSRF.
- CSP nonce، HSTS، no-store، frame denial، no-referrer و MIME sniffing protection.
- validation صریح account/zone/hostname/public IPv4.
- source داده‌پلین داخل build؛ بدون fetch سورس GitHub هنگام deploy.
- archive sing-box نسخهٔ دقیق 1.14.0 و SHA-256 دقیق برای amd64/arm64.
- `sing-box check` پیش از replace/restart و fixture validation در CI.
- subscription تصادفی و per-deployment؛ خطای token اشتباه عمداً 404 است.
- revoke با جایگزینی hash و data bundle حالت pending.
- Reality private key فقط روی VPS.
- health agent token مستقل، تصادفی و فقط hash‌شده در D1.
- audit بدون ثبت token، password یا response حساس.
- rate limit سادهٔ D1 روی login، bot، bootstrap و health.

## Secretها و محل درست آن‌ها

| Secret | محل | هرگز در |
|---|---|---|
| Telegram bot token | Worker Secret | سورس، `wrangler.jsonc`، چت |
| Telegram webhook secret | Worker Secret و تنظیم webhook تلگرام | URL webhook، log |
| Cloudflare OAuth client secret | Worker Secret | JavaScript مرورگر |
| Token encryption key | Worker Secret | backup بدون رمز، Git |
| OAuth access/refresh token کاربر | D1 فقط به‌شکل AES-GCM envelope | Telegram، data plane |
| Bootstrap token | hash در D1؛ مقدار خام فقط یک پاسخ | log، screenshot |
| Agent token | hash در D1؛ خام فقط `/etc/v13-agent.env` روی VPS | data plane |
| Subscription token | hash در deployment و مقدار خام داخل bundle رمز‌شده | Telegram |
| Reality private key | `/etc/sing-box/config.json` روی VPS | Control Plane |

## فرض‌های امنیتی

- HTTPS و TLS کلادفلر سالم و حساب اصلی با MFA/FIDO2 محافظت شده است.
- کاربر فقط روی VPS تحت مالکیت/مجوز خود اسکریپت را اجرا می‌کند.
- سیستم‌عامل VPS پشتیبانی‌شده و به‌روز است.
- کسی که به root VPS دسترسی دارد می‌تواند credentialهای همان node را بخواند.
- کسی که هم D1 و هم `TOKEN_ENCRYPTION_KEY` را تصاحب کند می‌تواند envelopeها را باز کند؛ بنابراین این دو باید در مرزهای عملیاتی جدا محافظت شوند.

## مواردی که عمداً تضمین نمی‌شوند

- عبور از قطع کامل اینترنت یا نبود route تا زیرساخت خارجی.
- ناشناس‌بودن مطلق یا مقاومت قطعی در برابر هر DPI.
- سلامت VPS آلوده یا provider متخاصم.
- حفاظت از subscription پس از کپی‌کردن آن توسط کاربر نهایی؛ در این حالت باید revoke و استقرار تازه انجام شود.

## rotation کلید رمزگذاری

`TOKEN_ENCRYPTION_KEY` را کورکورانه عوض نکنید؛ ciphertext موجود دیگر باز نمی‌شود. rotation صحیح نیازمند migration دوکلیدی است:

1. `TOKEN_ENCRYPTION_KEY_NEXT` را اضافه کنید.
2. همهٔ rowها را با کلید قبلی باز و با کلید بعدی دوباره رمز کنید.
3. شمارش و decrypt نمونه را بررسی کنید.
4. کلید بعدی را primary کنید.
5. پس از backup و بازهٔ rollback، کلید قبلی را حذف کنید.

این migration در نسخهٔ فعلی خودکار نیست و باید قبل از rotation توسعه/آزمایش شود.

## توصیه‌های حساب

- Cloudflare و Telegram را با MFA قوی محافظت کنید.
- scopeهای OAuth را افزایش ندهید مگر feature واقعی به آن نیاز داشته باشد.
- هیچ مجوز Billing، API Tokens Write، Access Write یا account-wide unrelated به OAuth client ندهید.
- audit و Workflow failureها را روزانه مرور کنید.
- برای admin آینده Cloudflare Access + allowlist شناسهٔ تلگرام + endpoint جدا الزامی است.
