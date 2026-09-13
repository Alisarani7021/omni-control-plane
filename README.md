# V13 Control Plane

کنترل‌پلین serverless و چندمستاجری BYOC برای Cloudflare، Telegram، D1، Workflows و VPS متعلق به کاربر.

## کارکرد اصلی

- بخش‌های پنل مستقل OMNI به‌صورت native داخل ربات هستند: رادار IP تمیز `/cleanip`، نقشهٔ زندهٔ سانسور `/map`، هددراپ DNS «WhiteHole» `/whitehole`، استخر اهدای کلید AI `/donate`، سلامت نودها `/health` و شمارش‌های واقعی `/usage`. جزئیات و آنچه عمداً منتقل نشده در [بخش‌های پنل](docs/PANEL-SECTIONS-FA.md) است.
- ربات تلگرام منوی Omni دارد: بخش «🛰️ ورود به محیط اختصاصی V13» جدا می‌ماند (ورود در مرورگر یا داخل خود تلگرام) و مدیریت کامل هم داخل ربات است: ساخت قدم‌به‌قدم استقرار، جزئیات، تلاش مجدد، ابطال، بوت‌استرپ، اشتراک‌ها و اتصال Cloudflare. ورود API Token فقط در پنل امن انجام می‌شود، هرگز در چت.
- پنل یک دکمهٔ مستقیم Cloudflare دارد که نام Token و سه permission لازم را از قبل پر می‌کند؛ کاربر فقط account/zone مشخص را محدود و ایجاد را تأیید می‌کند.
- کاربر **Scoped Cloudflare API Token** حاصل را فقط در فرم HTTPS پنل وارد می‌کند.
- Token باید فقط سه مجوز داشته باشد: `Workers Scripts Edit` برای یک account، و `DNS Edit` و `Zone Read` برای یک zone مشخص.
- V13 فعال‌بودن Token را با API رسمی Cloudflare بررسی می‌کند، فقط یک zone مجاز را می‌پذیرد و account/zone کشف‌شده را به connection قفل می‌کند.
- Token با AES-256-GCM و AAD وابسته به connection در D1 رمز می‌شود.
- نسخهٔ ذخیره‌شده پس از `ready`، شکست، revoke/لغو، disconnect یا timeout پاک می‌شود؛ cron هر پنج دقیقه رکوردهای منقضی را scrub می‌کند.
- TTL پیش‌فرض نگهداری محلی دو ساعت است و با `API_TOKEN_TTL_SECONDS` قابل کاهش است. اگر خود Token زودتر منقضی شود، تاریخ زودتر اعمال می‌شود.
- Cloudflare API به‌شکل proxy عمومی ارائه نمی‌شود؛ فقط عملیات داخلی account/zone/DNS/Workers قابل اجراست.
- Workflow، DNS، data-plane Worker و نصب idempotent روی VPS را هماهنگ می‌کند.
- روی Debian/Ubuntu، sing-box نسخهٔ pin‌شدهٔ `1.14.0` فقط بعد از بررسی SHA-256 نصب می‌شود.
- فقط دو profile واقعی تولید می‌شوند: VLESS Reality روی TCP/443 و Hysteria2 روی UDP/443.

## هوش شبکهٔ ملی (V13.5)

- طبقه‌بندی وضعیت شبکه با دو چشم مستقل (پروب لبه + گزارش ایجنت): باز / کندشده / فقط-ملی / خاموشی؛ بدون داده هرگز حدس نمی‌زند.
- خودآزمایی مسمومیت DNS روی رزولورهای مستند (سیستم، 1.1.1.1، شکن، 403.online، رادار) با کارت «N از M پاسخ جعلی بود» و خوراک نقشهٔ سانسور.
- DoH روی دامنهٔ Worker خود کاربر (`/dns-query?k=…`): رزولور split قطعی (.ir و ملی → داخلی، بقیه → Cloudflare)، فقط A/AAAA/TXT، سقف ساعتی، یک پاسخ cache.
- snapshot روزانهٔ رنج‌های ملی از APNIC stats (ردیف‌های IR) با diff و کارت «+N رنج · -M رنج · امروز» و rule-set عمومی `geoip-ir.json`.
- تونل DNS روی VPS کاربر: تفویض NS `t.<zone>` با همان Token موجود، نصب dnstt-server و slipstream-server (commit pin‌شده) با کلیدسازی فقط روی VPS، اندازه‌گیری خودکار MTU با پنج پروب، کارت `slipnet://` + راهنمای اپ + اثبات زنده‌بودن با TXT rtt، و ایمنی ضد-amplifier.
- پروفیل‌های «مستقیم داخل کشور»: قواعد route ثابت (.ir + geoip-ir + CDN داخلی + پین DoH → direct)، مسابقهٔ تونل-در-برابر-مستقیم per دامنه، و واریانت‌های نام‌دار sniff/fakedns + خروجی Clash.
- نود «خواب‌نت»: گزارش دوره‌ای خاموش، بیداری فقط در پنجرهٔ روزانه با jitter ±۹ دقیقه، خواندن یک beacon خواندنی TXT، دکمهٔ ⛔ بیدار/خواب فوری و سه قید اخلاقی روی همان کارت.
- گارد تاریخ update تلگرام (رد replay قدیمی‌تر از ۱۰ دقیقه). جزئیات کامل در [هوش شبکهٔ ملی](docs/NET-INTEL-FA.md).
- «🌐 مرکز DNS» بخش کاملاً مستقل: اسکن رنج برای یافتن DNSهای سالم با پرسش واقعی TCP/53 و بروزرسانی خودکار هر ۳۰ دقیقه، تست مسمومیت با انتخاب اپراتور/شهر و فرمان آمادهٔ کپی، و سازنده‌های Master DNS (DoH + رکورد SVCB)، White DNS (لیست سفید TXT روی zone خود کاربر) و Slipstream — همگی با اتصال Cloudflare خود کاربر؛ رنج‌های خودکار سامانه همیشه در پس‌زمینه اسکن می‌شوند و رنجی که کاربر می‌دهد همان‌جا بلافاصله و کامل اسکن دقیق می‌شود. «🚀 دیپلوی پنل جدید» مستقیم کاتالوگ پنل‌ها (BPB/ناهان/Zeus/…) را باز می‌کند و اتصال Cloudflare فقط لحظهٔ لازم، داخل خود مسیر پنل پرسیده می‌شود.

## اصل حداقل دسترسی

DNS فقط به zone انتخاب‌شده محدود است. مجوز Workers Scripts در Cloudflare account-scoped است، اما به همان account انتخاب‌شده محدود می‌شود. Token به Billing، API Tokens، Memberships، account settings یا zoneهای دیگر دسترسی ندارد.

پاک‌کردن ciphertext از V13، Token اصلی را در Cloudflare حذف نمی‌کند. کاربر می‌تواند پس از پایان کار آن را از مسیر زیر حذف کند:

`My Profile → API Tokens`

Token هرگز نباید در Telegram، چت، issue، screenshot، source code یا command line قرار گیرد.

خرید VPS خودکار نیست: کاربر VPS دارای IPv4 عمومی و دسترسی root را تهیه می‌کند؛ پس از آن DNS، نصب، تنظیم، اعتبارسنجی، publication و health reporting خودکارند.

## راهنماها

- [نصب از صفر](docs/SETUP-FA.md)
- [ادغام با ربات Omni](docs/OMNI-INTEGRATION-FA.md)
- [بخش‌های پنل OMNI در ربات](docs/PANEL-SECTIONS-FA.md)
- [معماری](docs/ARCHITECTURE-FA.md)
- [امنیت](docs/SECURITY-FA.md)
- [عملیات و بازیابی](docs/OPERATIONS-FA.md)
- [هوش شبکهٔ ملی V13.5](docs/NET-INTEL-FA.md)

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
