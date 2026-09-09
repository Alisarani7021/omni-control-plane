# راهنمای عملیات، عیب‌یابی و حذف V13

## بررسی روزانه

1. در پنل V13 وضعیت deployment باید `ready` باشد.
2. `last_seen_at` باید حداکثر چند دقیقه قبل باشد.
3. در Cloudflare Dashboard بخش Workers & Pages، Worker داده و custom domain را ببینید.
4. در VPS:

```bash
sudo systemctl status sing-box --no-pager
sudo systemctl status v13-health-report.timer --no-pager
sudo journalctl -u sing-box -n 100 --no-pager
sudo /usr/local/bin/sing-box check -c /etc/sing-box/config.json
```

## بررسی شبکهٔ VPS

```bash
sudo ss -lntup | grep -E ':(80|443)\b'
dig +short node.example.com A
curl -I https://node.example.com/  # پاسخ Hysteria2 نیست؛ فقط بررسی DNS/TCP احتمالی است
```

برای Hysteria2 حتماً UDP/443 باید هم در firewall سیستم‌عامل و هم firewall پنل provider باز باشد. Cloudflare proxy باید برای node خاموش/خاکستری باشد؛ Workflow رکورد را با `proxied=false` می‌سازد.

## وضعیت‌های Workflow

- `queued`: instance تازه ساخته شده است.
- `preparing`: zone، DNS و Worker داده در حال آماده‌شدن‌اند.
- `awaiting_agent`: کار Cloudflare تمام و نوبت اجرای اسکریپت VPS است.
- `agent_ready`: callback VPS رسید و finalize در صف است.
- `finalizing`: subscription خصوصی در حال انتشار است.
- `ready`: هر دو پروتکل نصب و پروفایل‌ها منتشر شده‌اند.
- `failed`: عملیات شکست خورده؛ credential در status detail ثبت نمی‌شود.
- `revoked`: subscription باطل شده است.

برای log کنترل‌پلین:

```bash
npx wrangler tail v13-control-plane --format pretty
```

هرگز خروجی حاوی URL اشتراک یا secret را در issue عمومی نگذارید.

## Bootstrap token گم یا منقضی شده

در پنل deployment را باز کنید و «صدور Bootstrap جدید» را بزنید. token قبلی فوراً جایگزین می‌شود. فایل را دریافت، با `less` بررسی، اجرا و بعد حذف کنید.

## Finalize شکست خورده

1. ابتدا VPS را بررسی کنید:

```bash
sudo systemctl is-active sing-box
sudo /usr/local/bin/sing-box version
sudo /usr/local/bin/sing-box check -c /etc/sing-box/config.json
```

2. از معتبر بودن OAuth و scopeها مطمئن شوید.
3. در پنل «تلاش مجدد Workflow» را بزنید؛ سامانه بر اساس وجود callback عامل، prepare یا finalize را انتخاب می‌کند.
4. اگر OAuth revoke شده، دوباره Cloudflare را متصل کنید؛ برای اتصال قدیمی باید feature انتخاب connection جدید اضافه شود یا deployment تازه بسازید.

## گواهی ACME صادر نمی‌شود

- `node.example.com` باید به IP VPS resolve شود.
- رکورد باید DNS-only باشد.
- TCP/80 باید تا VPS باز باشد.
- سرویس دیگری نباید port 80 challenge را اشغال کرده باشد.
- ایمیل ACME معتبر باشد.
- log:

```bash
sudo journalctl -u sing-box -n 200 --no-pager
```

## Reality متصل نمی‌شود

- TCP/443 باز باشد.
- ساعت VPS درست باشد:

```bash
timedatectl status
```

- مقصد handshake از VPS روی TLS/443 در دسترس باشد.
- از profile تولیدشدهٔ همان deployment استفاده کنید؛ public/private key deploymentهای مختلف قابل ترکیب نیستند.

## Hysteria2 متصل نمی‌شود

- UDP/443 در security group provider و UFW باز باشد.
- certificate برای node hostname صادر شده باشد.
- ISP/client باید UDP را عبور دهد؛ بعضی شبکه‌ها UDP را محدود می‌کنند. در آن شرایط Reality ممکن است کار کند، اما تضمین وجود ندارد.

## ابطال subscription

در پنل «ابطال اشتراک» را بزنید. Workflow hash توکن داده‌پلین را جایگزین و config را pending می‌کند. لینک قبلی پس از پایان Workflow باید 404/503 بگیرد. این عمل سرویس sing-box روی VPS را حذف نمی‌کند.

## حذف کامل از VPS

ابتدا subscription را در پنل revoke کنید، سپس روی VPS:

```bash
sudo systemctl disable --now v13-health-report.timer sing-box.service
sudo rm -f /etc/systemd/system/v13-health-report.timer
sudo rm -f /etc/systemd/system/v13-health-report.service
sudo rm -f /etc/systemd/system/sing-box.service
sudo systemctl daemon-reload
sudo rm -f /usr/local/libexec/v13-health-report.py
sudo rm -f /usr/local/bin/sing-box
sudo shred -u /etc/v13-agent.env 2>/dev/null || sudo rm -f /etc/v13-agent.env
sudo shred -u /etc/sing-box/config.json 2>/dev/null || sudo rm -f /etc/sing-box/config.json
sudo rm -rf /var/lib/sing-box /var/lib/v13-agent /etc/sing-box
sudo userdel sing-box 2>/dev/null || true
```

قانون‌های firewall را فقط وقتی حذف کنید که سرویس دیگری از آن port استفاده نمی‌کند.

## Backup D1

قبل از migration یا release:

```bash
npx wrangler d1 export v13-control-plane --remote --output v13-d1-backup.sql
```

فایل export ممکن است ciphertext و metadata شخصی داشته باشد. آن را رمزگذاری، دسترسی را محدود و retention تعریف کنید.

## Incident response

1. Worker قدیمی و routeهای ناامن را غیرفعال کنید.
2. Telegram token را در BotFather revoke و token جدید بگیرید.
3. OAuth client secret را rotate کنید.
4. connectionهای مشکوک و deploymentها را revoke کنید.
5. sessionها را حذف کنید:

```bash
npx wrangler d1 execute v13-control-plane --remote --command "DELETE FROM sessions; DELETE FROM login_links; DELETE FROM oauth_states;"
```

6. audit، Cloudflare account logs و VPS auth logs را نگه‌داری و بررسی کنید.
7. بدون migration، `TOKEN_ENCRYPTION_KEY` را تغییر ندهید؛ ابتدا فرآیند دوکلیدی سند امنیت را اجرا کنید.
