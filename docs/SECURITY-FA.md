# مدل امنیت V13

## ۱. اصل‌های طراحی

- احراز هویت کاربر با Telegram و login link یک‌بارمصرف و کوتاه‌عمر.
- session cookie امن، بررسی origin برای POSTها و CSP با nonce.
- tenant isolation در queryهای browser-facing.
- Scoped API Token فقط در فرم HTTPS؛ نه Telegram، URL، CLI، screenshot یا log.
- رمزگذاری AES-256-GCM با nonce تصادفی و AAD context-bound.
- hash کردن login/session/bootstrap/agent/subscription tokenها تا حد ممکن.
- audit بدون plaintext credential یا body حساس.
- Cloudflare client محدود؛ بدون generic API proxy.
- resource binding صریح برای account و zone.
- source و نسخه‌های اجرایی pin و قبل از اجرا verify می‌شوند.

## ۲. مدل حداقل دسترسی Cloudflare

Token پیشنهادی سه permission دارد:

| سطح | Permission | Resource |
|---|---|---|
| Account | Workers Scripts Edit | فقط account انتخابی |
| Zone | DNS Edit | فقط zone انتخابی |
| Zone | Zone Read | فقط همان zone |

`Workers Scripts Edit` در مدل Cloudflare account-scoped است و به یک zone محدود نمی‌شود؛ بنابراین Account Resources باید فقط account لازم باشد. هیچ دسترسی Billing، API Tokens، Memberships، Account Settings، SSL، WAF یا zoneهای دیگر لازم نیست.

V13 فقط Tokenهایی را می‌پذیرد که دقیقاً یک zone active با مجوز مؤثر `#dns_records:edit` داشته باشند. اگر Cloudflare در zone-list دامنه‌های صرفاً قابل‌مشاهده را نیز برگرداند، آن‌ها با permission metadata حذف می‌شوند. account/zone نهایی داخل connection ثبت و قبل از deployment تطبیق داده می‌شود. preflight خواندن DNS و Workers غیرمخرب است؛ write واقعی فقط هنگام provisioning انجام می‌شود. Token اشتباه یا Read-only در اولین عملیات write به‌صورت fail-closed متوقف می‌شود.

## ۳. کنترل چرخهٔ عمر

1. endpoint اتصال authenticated، same-origin، size-limited و rate-limited است.
2. `/user/tokens/verify` باید status برابر `active` برگرداند.
3. اگر `not_before` در آینده یا `expires_on` گذشته باشد، Token رد می‌شود.
4. تاریخ نگهداری زودترین مقدار بین TTL محلی و `expires_on` است.
5. Token قبل از INSERT با `TOKEN_ENCRYPTION_KEY` رمز می‌شود.
6. فقط هنگام API call لازم در حافظهٔ invocation رمزگشایی می‌شود.
7. پاک‌سازی در `ready`، failure، revoke/لغو، disconnect و expiration انجام می‌شود.
8. scheduled cleanup هر پنج دقیقه safety net است.
9. سقف سه connection موقت منقضی‌نشده برای هر tenant وجود دارد.

پاک‌سازی D1، Token اصلی را در Cloudflare حذف نمی‌کند. user پس از پایان می‌تواند آن را از `My Profile → API Tokens` حذف کند.

## ۴. محل نگه‌داری

| داده | محل | شکل |
|---|---|---|
| Telegram bot token | Worker Secret | plaintext فقط در runtime |
| Telegram webhook secret | Worker Secret | plaintext فقط در runtime |
| کلید مادر رمزگذاری | Worker Secret | base64url، ۳۲ بایت |
| Scoped API Token کاربر | D1 موقت | AES-256-GCM envelope |
| account/zone ID و نام | D1 | resource metadata غیرمحرمانه |
| login/session/bootstrap token | D1 | hash |
| subscription و agent secrets | D1 | hash یا encrypted bundle |
| VPS protocol secrets | VPS و encrypted bundle | حداقل موردنیاز |
| کلید اهدایی AI | D1 (D1 + جدول secrets جدا) | AES-256-GCM، فقط snippet در نمایش |
| گزارش‌های رادار IP و نقشهٔ سانسور | D1 | aggregate کوتاه‌مدت، بدون IP و بدون شناسهٔ کاربر |

## ۴.۱ داده‌های جمعیتی، هددراپ DNS و کلیدهای اهدایی

- **رادار IP / نقشهٔ سانسور:** ورودی فقط خوداظهاری کلاینت است، با اعتبارسنجی سخت، clamp
  و سقف نرخ بر حسب هش روز‌نمک‌شدهٔ IP. V13 هیچ پینگ یا نتیجهٔ پروب جعلی تولید نمی‌کند و
  آی‌پی اندازه‌گیری‌نشده را `⚪ بدون داده` اعلام می‌کند. داده‌ها ۷ روز (رادار) و ۲۴ ساعت
  (نقشه) می‌مانند و با cron پاک می‌شوند؛ پس مسموم‌کردن پایدار نیست، اما ممکن است —
  این داده راهنمای انتخاب است، نه تضمین.
- **هددراپ WhiteHole:** payload داخل رکورد TXT عمومی منتشر می‌شود، بنابراین فقط IP، پورت،
  SNI و resolver داخلی در آن است. لینک اشتراک، توکن subscription و هر credential به‌هیچ‌وجه
  در DNS نوشته نمی‌شود. نوشتن رکورد فقط با Scoped API Token خود tenant و فقط در همان
  zone ثبت‌شده انجام می‌شود (۶ انتشار/ساعت).
- **اهدای کلید AI:** پذیرش کلید فقط پس از صفحهٔ رضایت است، سقف ۵ کلید فعال و ۳ ثبت در ساعت
  دارد، کلید هرگز در پیام‌های ربات تکرار نمی‌شود (فقط `sk-…1234`)، با همان
  `TOKEN_ENCRYPTION_KEY` رمز می‌شود، پس‌گرفتن مالک و رد ادمین ciphertext را بی‌درنگ حذف
  می‌کند و cron رکوردهای ۳۰‌روزه را hard-delete می‌کند. بازبینی فقط برای
  `ADMIN_TELEGRAM_IDS` و `readDonationKey` تنها مسیر رمزگشایی است. V13 کلید اهدایی را
  تست یا مصرف نمی‌کند، پس ادعای «فعال در استخر سراسری» هم نمایش داده نمی‌شود.

## ۵. عدم نشت

- Token فقط در body یک POST HTTPS قرار می‌گیرد و در URL نیست.
- input نوع password دارد و پس از موفقیت reset می‌شود.
- HTML و JSON دارای `Cache-Control: no-store` هستند.
- CSP اتصال JavaScript را به same-origin محدود می‌کند.
- خطاهای Cloudflare فقط code/status عمومی را گزارش می‌کنند؛ header و body log نمی‌شوند.
- API connection فقط ID، نوع، resource و expiry را نشان می‌دهد.
- audit شامل resource ID و expiry است، نه Token.
- Telegram و data plane هیچ Cloudflare credential دریافت نمی‌کنند.
- preflight استفاده از headerهای Global API Key را در source ممنوع می‌کند.

browser آلوده، extension مخرب یا دسترسی غیرمجاز به Worker همچنان خطر دارد؛ MFA Cloudflare، دستگاه سالم و Token کوتاه‌عمر لازم‌اند.

## ۶. محدودیت IP Token

Cloudflare API Token می‌تواند IP filter داشته باشد، اما Cloudflare Worker کنترل‌پلین egress IP اختصاصی و ثابتی برای این API callها ندارد. بنابراین در این معماری Client IP Filtering نباید فعال شود؛ در غیر این صورت provisioning به‌صورت متناوب fail می‌شود. محدودسازی permission، account، zone و TTL کنترل‌های اصلی‌اند.

## ۷. Incident response

در صورت احتمال افشای API Token:

1. وارد `My Profile → API Tokens` شوید.
2. Token مربوط به V13 را فوراً Revoke/Delete کنید.
3. connection ذخیره‌شده را در V13 disconnect کنید.
4. DNS records، Workers و custom domains account انتخابی را بررسی کنید.
5. deploymentهای غیرمنتظره را revoke کنید.
6. sessionهای مشکوک را حذف و audit را بررسی کنید.

هیچ secret واقعی را برای پشتیبانی در چت یا screenshot ارسال نکنید.
