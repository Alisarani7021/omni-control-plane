# معماری V13 — از کنترل‌پلین تا VPS

## ۱) اجزای اصلی

1. **Telegram Bot**: فقط رابط شروع و اعلان وضعیت است. شناسهٔ کاربر را می‌گیرد و لینک یک‌بارمصرف پنل می‌سازد.
2. **Control Plane Worker**: نشست‌ها، OAuth، API، پنل، callback عامل و orchestration را اجرا می‌کند.
3. **D1**: دادهٔ چندمستاجری، وضعیت استقرار، nonceها، هش توکن‌ها، audit و health را نگه می‌دارد.
4. **Cloudflare OAuth**: دسترسی محدود و قابل ابطال به حساب هر کاربر می‌دهد؛ API Token در چت وجود ندارد.
5. **Cloudflare Workflows**: عملیات prepare/finalize/revoke را ماندگار، retryپذیر و idempotent اجرا می‌کند.
6. **Data-plane Worker کاربر**: فقط health عمومی و subscription دارای توکن تصادفی را سرو می‌کند.
7. **VPS Agent**: اسکریپت one-shot ممیزی‌پذیر که sing-box را با hash pin نصب می‌کند؛ سپس timer فقط health می‌فرستد.

## ۲) جریان ورود

```text
Telegram update
  -> بررسی X-Telegram-Bot-Api-Secret-Token
  -> deduplicate با update_id در D1
  -> ساخت/به‌روزرسانی tenant
  -> ساخت token تصادفی یک‌بارمصرف و ذخیره فقط SHA-256 آن
  -> لینک /login?t=...
Browser
  -> مصرف اتمی لینک
  -> ساخت session تصادفی
  -> ذخیره فقط SHA-256 session در D1
  -> Cookie: HttpOnly + Secure + SameSite=Lax
```

Cookie ثابت یا مقدار قابل حدس وجود ندارد؛ در نتیجه `v13_session=1` هیچ هویتی ایجاد نمی‌کند.

## ۳) جریان OAuth

```text
Session معتبر
  -> state تصادفی + PKCE verifier
  -> verifier با AES-256-GCM و AAD مخصوص همان state
  -> Cloudflare authorization endpoint
  -> callback با state + همان session
  -> مصرف یک‌بارۀ state
  -> exchange کد در backend با client_secret_basic + PKCE
  -> envelope encryption کردن access/refresh token پیش از D1
```

برای هر مقدار یک DEK تصادفی ساخته می‌شود؛ داده با DEK و AES-256-GCM رمز و خود DEK با KEK موجود در Worker Secret wrap می‌شود. هر envelope AAD متفاوت دارد؛ ciphertext متعلق به tenant/connection دیگر قابل جابه‌جایی نیست.

## ۴) جریان provisioning

### Prepare Workflow

1. deployment با وضعیت `queued` ایجاد می‌شود.
2. zone از API کلادفلر بررسی می‌شود که active و متعلق به account انتخابی باشد.
3. رکورد A برای `node.example.com` به IP عمومی VPS، با `proxied=false`، upsert می‌شود.
4. Worker داده با config حالت pending آپلود می‌شود.
5. Custom Domain اشتراک به Worker متصل می‌شود.
6. وضعیت به `awaiting_agent` می‌رود.

### Bootstrap عامل

1. کاربر فقط فایل اسکریپت یک‌بارمصرف را دانلود و **قبل از اجرا بررسی** می‌کند.
2. اسکریپت archive رسمی sing-box `1.14.0` را دریافت و SHA-256 pinشده را کنترل می‌کند.
3. UUID، Reality keypair، short ID، رمز Hysteria2 و agent token روی خود VPS تولید می‌شوند.
4. server config ساخته و با `sing-box check` بررسی می‌شود.
5. فقط بعد از check موفق، systemd service جایگزین/فعال می‌شود.
6. private key مربوط به Reality هرگز VPS را ترک نمی‌کند.
7. callback فقط public key و credentialهای client لازم را با HTTPS می‌فرستد.
8. bootstrap token مصرف و باطل می‌شود.

### Finalize Workflow

1. bundle رمز‌شده از D1 باز می‌شود.
2. دو پروفایل واقعی client ساخته می‌شوند.
3. Data-plane Worker با `secret_text` به‌روزرسانی می‌شود.
4. subscription token فقط به‌صورت hash داخل data plane قرار می‌گیرد.
5. وضعیت `ready` و اعلان بدون credential به تلگرام فرستاده می‌شود.

## ۵) پروتکل‌ها

- **VLESS Reality**: TCP/443، flow برابر `xtls-rprx-vision`، کلید خصوصی فقط سرور.
- **Hysteria2**: UDP/443، گواهی ACME برای node hostname، certificate provider جدید sing-box 1.14.

هیچ URI برای TUIC، SS2022، ECH، WireGuard قدیمی، gRPC یا XHTTP ساخته نمی‌شود؛ چون backend آن‌ها در MVP نصب نشده است.

## ۶) مرزهای اعتماد

| مرز | دادهٔ مجاز | دادهٔ ممنوع |
|---|---|---|
| Telegram | شناسه، نام، اعلان وضعیت، لینک ورود کوتاه‌عمر | CF token، رمز root، subscription URL |
| Browser ↔ Control Plane | session امن، OAuth، درخواست استقرار | secret در URL به‌جز login token یک‌بارمصرف |
| Control Plane ↔ Cloudflare | access token OAuth رمزگشایی‌شده فقط در حافظهٔ invocation | Global API Key |
| VPS ↔ Control Plane | bootstrap/agent bearer روی HTTPS | Reality private key |
| Data-plane Worker | hash اشتراک + config در secret binding | CF OAuth token، VPS root credential |

## ۷) مدل چندکاربری

تمام queryهای کاربر با `tenant_id` محدود می‌شوند. connection، deployment و subscription متعلق به tenant هستند. مسیر Agent با bearer مستقل احراز می‌شود و به session کاربر اتکا ندارد. مسیر admin عمومی وجود ندارد؛ اگر در آینده اضافه شود باید پشت Cloudflare Access و allowlist جدا قرار گیرد.
