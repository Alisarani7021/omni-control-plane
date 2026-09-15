# ادغام پنل وب کاوه — راهنمای فارسی

این سند نحوهٔ ادغام **پنل وب کاوه** (سورس کامل در `omni-panel/`) با کنترل‌پلین V13 را توضیح می‌دهد. پنل کاوه یک Worker ماژولار VLESS/Trojan روی Cloudflare Workers است که به‌صورت **قالب BYOC** (هر تنانت روی اکانت خودش) دیپلوی می‌شود — بدون سرور میانی، بدون DRM، بدون قفل نام.

## ۱. معماری ادغام

```
omni-panel/                 ← سورس مرجع پنل کاوه (در همین ریپو، import شده 2026-09-14)
├── src/                    ← هستهٔ پنل (api, auth, config, core, db, net, proxy)
├── ui/                     ← پنل وب (assets, app.js, views.js, i18n)
├── server/dev.js           ← سرور توسعه با قرارداد JSON یکسان با Worker واقعی
├── schema/0001_init.sql    ← اسکیما D1
└── dist-headless/          ← باندل هدلس پین‌شده (omni-headless.js + SHA256)

src/omni-source.ts          ← باندل هدلس جاسازی‌شده در کنترل‌پلین (GENERATED)
src/omni-engine.ts          ← موتور provision نودهای هدلس روی اکانت تنانت
src/omni-flows.ts           ← فلوهای ربات برای مدیریت نودها
```

**نکتهٔ کلیدی:** پنل کاوه دو حالت دارد:
- **هدلس (headless)** — بدون UI، بدون `[assets]`، فقط API + تونل + D1/DO + کرون. این همان چیزی است که V13 روی اکانت تنانت می‌سازد. ربات تلگرام، UI تنانت است.
- **وب کامل** — با UI (`omni-panel/ui`) برای توسعه/تست محلی یا دیپلوی مستقل. در نودهای هدلس، هر مسیر غیر API `404` است و `/panel` وجود ندارد.

## ۲. پین و همگام‌سازی باندل

باندل هدلس یک **آرتیفکت پین‌شده با SHA-256** است — کنترل‌پلین هرگز در زمان اجرا از شبکه چیزی نمی‌گیرد:

```bash
# بررسی همگامی (بدون بازسازی)
node scripts/sync-omni-panel.mjs

# بازسازی باندل از سورس omni-panel/src و سپس پین
node scripts/sync-omni-panel.mjs --rebuild
```

اسکریپت:
1. `omni-panel/dist-headless/omni-headless.js` را می‌خواند
2. با `SHA256` مقایسه می‌کند (`ce5ea107b72e4b39835026af8d2739106ea503430a6e4588e85822e7402656b6`)
3. در `src/omni-source.ts` به‌صورت `String.raw` جاسازی می‌کند

این فایل `GENERATED` است — هرگز دستی ویرایش نکنید.

## ۳. موتور Provision (omni-engine)

`src/omni-engine.ts` نود را روی اکانت تنانت (از طریق `resource_account_id` همان connection) می‌سازد:

| مرحله | توضیح |
|-------|-------|
| `findOrCreateD1` | D1 را idempotent می‌سازد (نام تکراری = reuse) |
| `omniUploadMetadata` | متادیتای multipart upload با بایندینگ‌های `D1/LEDGER/GUARD/AGENT_KEY/SECRET` + متغیرهای `PANEL_NAME` و غیره |
| `uploadKavehWorker` | آپلود `omni.mjs` + metadata روی `workers/scripts/{workerName}` |
| `enableWorkersDev` | فعال‌سازی `workers.dev` و برگرداندن `https://{worker}.workers.dev` |
| `provisionOmniNode` | ارکستراسیون کامل بالا |
| `deleteOmniNode` | حذف Worker + D1 |

**نام Worker:** فقط `^[a-z0-9-]{2,63}$` و باید lowercase باشد. از `crypto.randomUUID().replaceAll("-", "").slice(0,6)` (هگز lowercase) استفاده می‌شود — نه `randomToken` که Base64Url با حروف بزرگ تولید می‌کند (خطای 10016). تست در `tests/omni-engine.test.ts` این قرارداد را قفل می‌کند.

**ساب‌دامین Workers:** در `src/panel-deploy.ts`، `ensureWorkersSubdomain` با `toLowerCase().replace(/[^a-z0-9-]/gu, "-")` ساب‌دامین را نرمال می‌کند.

## ۴. کانال عامل (Agent Channel)

ربات از طریق کانال عامل با نود حرف می‌زند (`POST /api/agent/*` روی `baseUrl`):

```ts
omniAgent(baseUrl, agentKey, "/api/agent/users", { method: "POST", body: ... })
```

هدر احراز:
- `X-Omni-Agent` — نام فعلی
- `X-Kaveh-Agent` — legacy (باندل پین‌شده هنوز `x-kaveh-agent` می‌خواند)

هر دو هدر همیشه ارسال می‌شوند. اگر فقط یکی ارسال شود، باندل‌های نصب‌شده در اکانت کاربران با `403 «کلید عامل نامعتبر است»` جواب می‌دهند و `vip` seed، `admin/password` و `users` همه fail می‌شوند. تست `tests/omni-agent-contract.test.ts` نام هدر را از داخل خود باندل استخراج و قفل می‌کند.

## ۵. فلوهای ربات (omni-flows)

`src/omni-flows.ts`:

- `createOmniNode` — ساخت نود + seed کاربر `vip` (۵ تلاش با ۴ ثانیه فاصله)
- `omniNewUser` / `omniListUsers` / `omniGetUser` / `omniDeleteUser`
- `omniRotateSub` / `omniRecoveryPassword` / `deleteOmniNode`

کلید عامل با `AES-256-GCM` و AAD `omni:{nodeId}` رمز می‌شود (مثل توکن‌های اتصال). جدول: `kaveh_nodes` (نام برای سازگاری migration حفظ شده).

دکمهٔ منو: `⚒️ پنل OMNI` → callback `v13:kaveh` (legacy stable).

## ۶. وب پنل vs ربات

| قابلیت | هدلس (V13 نود) | پنل وب کامل (omni-panel standalone) |
|--------|----------------|--------------------------------------|
| `/panel` | 404 — وجود ندارد | دارد (صفحهٔ ورود + مدیریت) |
| مدیریت کاربر | فقط ربات (`/api/agent/users` via `omniAgent`) | مستقیم در UI |
| اشتراک | `baseUrl/s/{sub_token}` via ربات | همان، در UI |
| لاگین | توکن یک‌بارمصرف ربات → `/app` V13 | رمز مدیر نود (AGENT_KEY) |

## ۷. توسعهٔ محلی پنل وب کاوه

```bash
cd omni-panel
npm ci
npm run dev          # → http://localhost:5173  (با دادهٔ فِیک، قرارداد JSON یکسان)
npm test             # 47 تست
npm run build        # باندل headless
node scripts/build-headless.mjs
```

سرور `server/dev.js` دقیقاً همان قرارداد JSON ورکر واقعی را پیاده می‌کند؛ تست `test/contract.test.js` واگرایی را در CI می‌گیرد.

## ۸. دیپلوی مستقل (بدون V13)

پنل کاوه را می‌توان مستقیم هم دیپلوی کرد (BYOC):

- دکمهٔ `Deploy with Workers` در `omni-panel/README.md`
- یا `bash scripts/activate.sh` / `wrangler deploy` (D1 auto-provision، اسکیما در `src/db/migrate.js`)

این مسیر از V13 جداست و برای تست پنل وب به‌صورت ایزوله مفید است.

## ۹. امنیت و مرزها

- هر provision داخل `resource_account_id` همان connection می‌ماند — هرگز از ورودی کاربر حساب خوانده نمی‌شود.
- سکرت‌های نود (`AGENT_KEY`, `SECRET`) فقط به‌صورت `secret_text` در آپلود ست می‌شوند، هرگز در چت نمی‌آیند.
- ربات فقط لینک اشتراک را با `protect_content` نشان می‌دهد.
- `TOKEN_ENCRYPTION_KEY` فقط via `wrangler secret put` ست می‌شود.

## ۱۰. عیب‌یابی

| علامت | علت | راه‌حل |
|-------|------|--------|
| `10016 Invalid Worker name` | suffix با حروف بزرگ (Base64Url) | `crypto.randomUUID()` + `toLowerCase()` |
| `403 کلید عامل نامعتبر است` | هدر legacy فرستاده نشده | هر دو `X-Omni-Agent` + `X-Kaveh-Agent` |
| `workers.dev 1101` | اکانت خراب | روی دامنهٔ شخصی Route کنید (`docs/START-HERE.md`) |
| `installed=false` | رمز مدیر ساخته نشده | فوراً `/panel` باز و رمز بسازید |

## ۱۱. چک‌لیست ادغام

- [ ] `omni-panel/dist-headless/SHA256` با `src/omni-source.ts` هم‌خوان است (`node scripts/sync-omni-panel.mjs`)
- [ ] `npm run lint` / `typecheck` / `test` / `build` پاس
- [ ] مایگریشن `0005_kaveh_nodes.sql` اعمال شده (`wrangler d1 migrations apply --remote`)
- [ ] وب‌هوک تلگرام با `callback_query` ثبت شده (`node scripts/set-telegram-webhook.mjs`)
- [ ] تست قرارداد عامل پاس

منابع: `docs/OMNI-PANEL-FA.md` · `docs/OMNI-INTEGRATION-FA.md` · `omni-panel/docs/AGENT-FA.md` · `omni-panel/docs/DEPLOY.md`
