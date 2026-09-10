# V13 Control Plane

کنترل‌پلین serverless و چندمستاجری BYOC برای Cloudflare، Telegram، D1، Workflows و VPS متعلق به کاربر.

## کارکرد اصلی

- Telegram فقط برای هویت و لینک ورود یک‌بارمصرف است؛ credential در چت دریافت نمی‌شود.
- کاربر یک **Scoped Cloudflare API Token** را فقط در فرم HTTPS پنل وارد می‌کند.
- Token باید فقط سه مجوز داشته باشد: `Workers Scripts Edit` برای یک account، و `DNS Edit` و `Zone Read` برای یک zone مشخص.
- V13 فعال‌بودن Token را با API رسمی Cloudflare بررسی می‌کند، فقط یک zone مجاز را می‌پذیرد و account/zone کشف‌شده را به connection قفل می‌کند.
- Token با AES-256-GCM و AAD وابسته به connection در D1 رمز می‌شود.
- نسخهٔ ذخیره‌شده پس از `ready`، شکست، revoke/لغو، disconnect یا timeout پاک می‌شود؛ cron هر پنج دقیقه رکوردهای منقضی را scrub می‌کند.
- TTL پیش‌فرض نگهداری محلی دو ساعت است و با `API_TOKEN_TTL_SECONDS` قابل کاهش است. اگر خود Token زودتر منقضی شود، تاریخ زودتر اعمال می‌شود.
- Cloudflare API به‌شکل proxy عمومی ارائه نمی‌شود؛ فقط عملیات داخلی account/zone/DNS/Workers قابل اجراست.
- Workflow، DNS، data-plane Worker و نصب idempotent روی VPS را هماهنگ می‌کند.
- روی Debian/Ubuntu، sing-box نسخهٔ pin‌شدهٔ `1.14.0` فقط بعد از بررسی SHA-256 نصب می‌شود.
- فقط دو profile واقعی تولید می‌شوند: VLESS Reality روی TCP/443 و Hysteria2 روی UDP/443.

## اصل حداقل دسترسی

DNS فقط به zone انتخاب‌شده محدود است. مجوز Workers Scripts در Cloudflare account-scoped است، اما به همان account انتخاب‌شده محدود می‌شود. Token به Billing، API Tokens، Memberships، account settings یا zoneهای دیگر دسترسی ندارد.

پاک‌کردن ciphertext از V13، Token اصلی را در Cloudflare حذف نمی‌کند. کاربر می‌تواند پس از پایان کار آن را از مسیر زیر حذف کند:

`My Profile → API Tokens`

Token هرگز نباید در Telegram، چت، issue، screenshot، source code یا command line قرار گیرد.

خرید VPS خودکار نیست: کاربر VPS دارای IPv4 عمومی و دسترسی root را تهیه می‌کند؛ پس از آن DNS، نصب، تنظیم، اعتبارسنجی، publication و health reporting خودکارند.

## راهنماها

- [نصب از صفر](docs/SETUP-FA.md)
- [معماری](docs/ARCHITECTURE-FA.md)
- [امنیت](docs/SECURITY-FA.md)
- [عملیات و بازیابی](docs/OPERATIONS-FA.md)

## بررسی قبل از انتشار

Node.js نسخهٔ 22.12 یا جدیدتر لازم است.

```bash
npm ci
npm audit --audit-level=moderate
npm run preflight
npm run lint
npm run typecheck
npm test
npm run verify:sing-box
npm run build
```

## Secretهای runtime

فقط با prompt مخفی `wrangler secret put` تنظیم شوند:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `TOKEN_ENCRYPTION_KEY` — base64url دقیقاً ۳۲ بایت تصادفی

API Token کاربران **Worker Secret نیست** و فقط از فرم امن هر نشست وارد می‌شود.

## استفادهٔ مجاز

فقط حساب، دامنه و سروری را مدیریت کنید که مالک آن هستید یا مجوز صریح دارید. در نبود کامل مسیر شبکه به زیرساخت خارجی، هیچ نرم‌افزاری اتصال را تضمین نمی‌کند.
