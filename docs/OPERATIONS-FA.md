# راهنمای عملیات V13

## ۱. بررسی روزانه

```bash
curl --fail --silent https://control.example.com/healthz
npx wrangler deployments list
```

Worker errors، D1 errors و Workflow failures را در Cloudflare بررسی کنید. log نباید API Token، subscription یا agent token داشته باشد.

## ۲. وضعیت connectionهای موقت

فقط metadata را بخوانید؛ ciphertext را query نکنید:

```bash
npx wrangler d1 execute v13-control-plane --remote --command "SELECT auth_type, resource_zone_name, expires_at FROM oauth_connections WHERE revoked_at IS NULL;"
```

وجود connection فعال فقط هنگام deployment فعال طبیعی است. TTL پیش‌فرض دو ساعت و cron پاک‌سازی هر پنج دقیقه است.

## ۳. failure و retry

1. وضعیت و `status_detail` را در پنل ببینید.
2. resourceهای Token را بررسی کنید: یک account و دقیقاً یک zone.
3. Permissionها باید `Workers Scripts Edit`، `DNS Edit` و `Zone Read` باشند.
4. DNS، IPv4، TCP/443، UDP/443 و سرویس VPS را بررسی کنید.
5. چون failure نسخهٔ ذخیره‌شده را پاک می‌کند، API Token معتبر را دوباره فقط در فرم HTTPS وارد کنید.
6. connection تازه را انتخاب و retry کنید.

## ۴. انقضا در میانهٔ کار

اگر bootstrap بیشتر از TTL طول کشید، Token را دوباره در پنل HTTPS ثبت و retry را با connection تازه اجرا کنید. اگر خود Token در Cloudflare منقضی شده، Token محدود تازه بسازید.

## ۵. لغو و حذف

- دکمهٔ پاک‌سازی فقط ciphertext V13 را scrub می‌کند و هنگام deployment فعال اجازه نمی‌دهد.
- revoke deployment اشتراک را غیرفعال و سپس connection بدون کار فعال را پاک می‌کند.
- حذف واقعی Token فقط از `My Profile → API Tokens → Revoke/Delete` انجام می‌شود.

## ۶. Incident response

1. API Token مربوط به V13 را فوراً در Cloudflare Revoke/Delete کنید.
2. connection ذخیره‌شده را در V13 disconnect کنید.
3. DNS، Workers و custom domains همان account/zone را بررسی کنید.
4. deploymentهای غیرمنتظره را revoke کنید.
5. sessionهای مشکوک را پاک کنید:

```bash
npx wrangler d1 execute v13-control-plane --remote --command "DELETE FROM sessions; DELETE FROM login_links;"
```

6. audit را بدون استخراج ciphertext بررسی کنید.

## ۷. پاک‌سازی اجباری API Tokenهای ذخیره‌شده

```bash
npx wrangler d1 execute v13-control-plane --remote --command "UPDATE oauth_connections SET access_token_enc='incident-erased', refresh_token_enc=NULL, expires_at=NULL, revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE auth_type='api_token' AND revoked_at IS NULL;"
```

این دستور Token اصلی Cloudflare را حذف نمی‌کند.

## ۸. backup، release و rollback

```bash
mkdir -p backups
npx wrangler d1 export v13-control-plane --remote --output "backups/d1-$(date -u +%Y%m%dT%H%M%SZ).sql"
npm ci
npm audit --audit-level=moderate
npm run preflight
npm run lint
npm run typecheck
npm test
npm run verify:sing-box
npm run build
npx wrangler d1 migrations apply v13-control-plane --remote
npm run deploy
```

Rollback Worker:

```bash
npx wrangler deployments list
npx wrangler rollback
```

Rollback Worker، schema D1 را تغییر نمی‌دهد. migration `0002` additive است.

## ۹. VPS

```bash
systemctl status sing-box --no-pager
journalctl -u sing-box -n 100 --no-pager
sing-box check -c /etc/sing-box/config.json
ss -lntup | grep -E ':443\b'
```

config یا credential VPS را در چت Paste نکنید. ابتدا deployment را revoke و سپس پاک‌سازی VPS را مطابق release انجام دهید.

## ۱۰. وضعیت شبکه

`ready` یعنی provisioning و validation موفق بوده، نه تضمین دسترسی از هر ISP. VLESS Reality و Hysteria2 باید از شبکه‌های هدف جداگانه آزمایش شوند. قطع کامل مسیر خارجی راه‌حل تضمین‌شده ندارد.
