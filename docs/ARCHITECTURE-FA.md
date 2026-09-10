# معماری V13

## ۱. اجزا

1. **Telegram Bot روی Cloudflare Worker**: شناسایی user، ساخت tenant و صدور لینک ورود یک‌بارمصرف.
2. **Control Plane Worker**: نشست امن، پنل HTTPS، API محدود، webhook عامل و orchestration.
3. **Cloudflare D1**: tenant، session، connection رمز‌شده، deployment، audit و health.
4. **Cloudflare Workflows**: اجرای retryپذیر prepare/finalize/revoke.
5. **Data-plane Worker متعلق به کاربر**: انتشار subscription خصوصی؛ credential کنترل‌پلین را دریافت نمی‌کند.
6. **VPS متعلق به کاربر**: sing-box واقعی برای VLESS Reality و Hysteria2 و health reporter.

کنترل‌پلین و ربات serverless روی Cloudflare می‌مانند. VPS فقط data plane است.

## ۲. اتصال Cloudflare با حداقل دسترسی

مسیر اصلی محصول **Scoped API Token** است و به OAuth Client، publisher verification یا Global API Key وابسته نیست.

Token لازم است فقط این مجوزها را داشته باشد:

- `Account → Workers Scripts → Edit` روی یک account مشخص
- `Zone → DNS → Edit` روی یک zone مشخص
- `Zone → Zone → Read` روی همان zone

جریان اتصال:

1. user با لینک یک‌بارمصرف Telegram وارد پنل HTTPS می‌شود.
2. Token را در input نوع password وارد می‌کند.
3. Browser با same-origin POST به `POST /api/v1/cloudflare/api-token` می‌فرستد.
4. Worker session، origin، اندازهٔ body و rate limit را بررسی می‌کند.
5. Token با `/user/tokens/verify` اعتبارسنجی می‌شود.
6. V13 zoneهای active قابل‌مشاهده را می‌خواند و دقیقاً یک zone را می‌پذیرد.
7. دسترسی خواندن DNS و Workers به‌شکل غیرمخرب preflight می‌شود.
8. account و zone کشف‌شده در connection ذخیره می‌شوند و تمام deploymentها به این boundary محدود می‌مانند.
9. Token با AES-256-GCM و AAD مخصوص connection رمز و در D1 ذخیره می‌شود.
10. `expires_at` برابر زودترین زمان بین TTL محلی و انقضای خود Token است.
11. پس از پایان، شکست، revoke/لغو یا disconnect، ciphertext scrub می‌شود. Scheduled Worker هر پنج دقیقه timeoutها را پاک می‌کند.

Authentication فقط با این header در client محدود سرور انجام می‌شود:

`Authorization: Bearer <token>`

هیچ endpoint عمومی برای path یا method دلخواه Cloudflare وجود ندارد. عملیات allowlist‌شده فقط verify token، zone discovery، DNS، Workers scripts و Workers custom domain هستند.

## ۳. جریان استقرار

### Prepare

1. tenant و connection در queryهای browser محدود می‌شوند.
2. account/zone ورودی باید با resource boundary ذخیره‌شدهٔ Token برابر باشد.
3. zone مجدداً از Cloudflare خوانده و active بودن آن بررسی می‌شود.
4. hostnameها باید زیر همان zone باشند.
5. deployment و secret bundle رمز‌شده ایجاد می‌شوند.
6. Workflow رکورد A مربوط به VPS را به حالت DNS-only می‌سازد.
7. data-plane Worker در حالت pending آپلود و custom domain متصل می‌شود.
8. وضعیت به `awaiting_agent` می‌رسد.

### Bootstrap VPS

1. پنل token یک‌بارمصرف و چهار فرمان download/inspect/execute/erase نمایش می‌دهد.
2. token در D1 فقط به‌شکل hash و دارای TTL نگه‌داری می‌شود.
3. bootstrap فقط Debian/Ubuntu و معماری پشتیبانی‌شده را می‌پذیرد.
4. باینری sing-box نسخهٔ pin‌شده بعد از SHA-256 نصب می‌شود.
5. config با `sing-box check` اعتبارسنجی و سرویس فعال می‌شود.
6. عامل نتیجه و secretهای تولیدشده را به endpoint احراز‌شده برمی‌گرداند.

### Finalize

1. گزارش عامل از نظر deployment، token و schema بررسی می‌شود.
2. config نهایی فقط با profileهای واقعاً نصب‌شده ساخته می‌شود.
3. data-plane با bindingهای secret به‌روزرسانی می‌شود.
4. deployment به `ready` می‌رود.
5. اگر connection کار فعال دیگری ندارد، نسخهٔ ذخیره‌شدهٔ API Token فوراً پاک می‌شود.

### Revoke / لغو

1. credential اشتراک rotate می‌شود.
2. data plane به bundle غیرفعال تغییر می‌کند.
3. bootstrap token حذف و deployment به `revoked` می‌رود.
4. connection موقت در صورت نبود کار فعال دیگر scrub می‌شود.

## ۴. مدل داده و tenant isolation

- routeهای browser بعد از authentication از `tenantId` نشست استفاده می‌کنند.
- connection یا deployment متعلق به tenant دیگر با ID قابل دسترسی نیست.
- connection نوع `api_token` به `resource_account_id` و `resource_zone_id` مشخص قفل می‌شود.
- API account/zone برای Token از boundary ذخیره‌شده پاسخ می‌دهد و resource دلخواه را قبول نمی‌کند.
- Workflow فقط deployment ذخیره‌شده را بارگذاری می‌کند.
- نام قدیمی جدول/ستون‌های `oauth_connections` و `oauth_connection_id` برای migration سازگار باقی مانده است؛ `auth_type='api_token'` روش فعال را مشخص می‌کند.

## ۵. مرزهای secret

| مسیر | دادهٔ مجاز | دادهٔ ممنوع |
|---|---|---|
| Telegram | لینک ورود کوتاه‌عمر، وضعیت کلی | API Token، subscription، VPS password |
| Browser ↔ Control Plane | session cookie و فرم HTTPS Token | secret در URL یا third-party origin |
| D1 | ciphertext Token و bundle، hash tokenها، resource ID | plaintext API Token |
| Control Plane ↔ Cloudflare | Bearer Token فقط برای endpointهای ثابت | proxy عمومی، log credential |
| Data-plane Worker | hash اشتراک و config لازم | API Token، root credential |
| VPS | config سرویس و agent token محدود | Telegram bot token، Cloudflare credential |

## ۶. محدودیت شبکه

V13 دو transport متفاوت فراهم می‌کند، اما اگر هیچ مسیر قابل‌دسترسی تا Cloudflare یا VPS خارجی وجود نداشته باشد، اتصال قابل تضمین نیست. resilience باید از شبکه‌های هدف به‌صورت واقعی آزمایش شود.
