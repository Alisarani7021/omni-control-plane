#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════
#  فعال‌سازی کاوه — یک دستور، از صفر تا پنل زنده
#
#    bash scripts/activate.sh
#
#  کاری که می‌کند (به ترتیب، و idempotent — اجرای مجدد بی‌خطر است):
#    ۱. بررسی پیش‌نیازها (Node ≥ 20، دسترسی به wrangler)
#    ۲. احراز هویت (wrangler login یا CLOUDFLARE_API_TOKEN)
#    ۳. ساخت/پیدا کردن پایگاه‌داده‌ی D1 و نوشتن database_id در wrangler.toml
#    ۴. اعمال مهاجرت‌ها روی D1 واقعی (--remote)
#    ۵. استقرار اول (Worker بدون SECRET عمداً ۵۰۳ می‌دهد — این گارد بوت است)
#    ۶. گذاشتن SECRET (و RECOVERY_CODE اختیاری) — خودش نسخه‌ی جدید می‌سازد
#    ۷. تأیید زنده: /api/whoami و /panel روی دامنه‌ی دیپلوی‌شده
#
#  حالت‌های غیرتعاملی:
#    CF_API_TOKEN=… KAVEH_SECRET=… bash scripts/activate.sh --yes
#
#  گزینه‌ها:
#    --yes            بدون پرسش (مقادیر لازم را از محیط یا به‌صورت تصادفی می‌گیرد)
#    --dry-run        فقط نقشه را چاپ می‌کند، هیچ چیزی تغییر نمی‌دهد
#    --skip-tests     تست‌ها را اجرا نکند (پیش‌فرض: اجرا می‌کند)
#    --db <name>      نام پایگاه‌داده (پیش‌فرض: kaveh)
# ══════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

# ── رنگ و پیام ────────────────────────────────────────────────────────────
if [ -t 1 ]; then G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; B=$'\e[1m'; D=$'\e[2m'; N=$'\e[0m'
else G=""; R=""; Y=""; B=""; D=""; N=""; fi
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
bad()  { printf '  %s✗%s %s\n' "$R" "$N" "$1"; }
say()  { printf '%s\n' "${D}  $1${N}"; }
step() { printf '\n%s▸ %s%s\n' "$B" "$1" "$N"; }
die()  { printf '\n%s✗ %s%s\n\n' "$R" "$1" "$N" >&2; exit 1; }

# ── آرگومان‌ها ────────────────────────────────────────────────────────────
YES=0; DRY=0; TESTS=1; DB_NAME="${KAVEH_DB_NAME:-kaveh}"
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y)     YES=1; shift ;;
    --dry-run|-n) DRY=1; shift ;;
    --skip-tests) TESTS=0; shift ;;
    --db)         DB_NAME="$2"; shift 2 ;;
    -h|--help)    sed -n '2,28p' "$0"; exit 0 ;;
    *)            die "گزینه‌ی ناشناخته: $1" ;;
  esac
done

run() {  # run <توضیح> <دستور…> — در حالت dry-run فقط چاپ می‌کند
  local label="$1"; shift
  if [ "$DRY" = 1 ]; then say "dry-run: $label"; say "  \$ $*"; return 0; fi
  printf '  %s$%s %s\n' "$D" "$N" "$*" >&2
  "$@"
}

printf '%s\n' "$B ══ فعال‌سازی کاوه ══$N"
[ "$DRY" = 1 ] && printf '%s\n' "${Y} حالت dry-run — هیچ تغییری اعمال نمی‌شود${N}"

# ── ۱. پیش‌نیازها ─────────────────────────────────────────────────────────
step "۱. پیش‌نیازها"
command -v node >/dev/null 2>&1 || die "Node.js نصب نیست. نسخه‌ی ۲۰ یا بالاتر لازم است: https://nodejs.org"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || die "Node $NODE_MAJOR خیلی قدیمی است؛ ≥ 20 لازم است (wrangler 4.x همین را می‌خواهد)"
ok "Node $(node -v)"

[ -f wrangler.toml ] || die "wrangler.toml پیدا نشد — این اسکریپت را از ریشه‌ی پروژه اجرا کنید"
[ -f src/index.js ]  || die "src/index.js پیدا نشد"
ok "پروژه کامل است"

# wrangler: اول نسخه‌ی قفل‌شده‌ی محلی، بعد npx
if [ -x node_modules/.bin/wrangler ]; then WR="node_modules/.bin/wrangler"
else WR="npx --yes wrangler@4.86.0"; fi
if [ ! -d node_modules ]; then
  say "وابستگی‌ها نصب نیستند — npm ci"
  if [ "$DRY" = 1 ]; then say "dry-run: would run npm ci"; else npm ci >/dev/null; fi
fi
ok "wrangler: $WR"

# ── تست‌ها (قبل از هر تغییری — اگر کد خراب است، دیپلوی نکن) ────────────────
if [ "$TESTS" = 1 ] && [ "$DRY" = 0 ]; then
  if node --test test/ >/tmp/kaveh-test.log 2>&1; then
    ok "تست‌های واحد: $(grep -E '^# pass' /tmp/kaveh-test.log | tr -d '# pass ' ) پاس"
  else
    tail -20 /tmp/kaveh-test.log; die "تست‌ها پاس نشدند — اول این را حل کنید"
  fi
fi

# ── ۲. احراز هویت ─────────────────────────────────────────────────────────
step "۲. احراز هویت Cloudflare"
if [ -n "${CF_API_TOKEN:-}${CLOUDFLARE_API_TOKEN:-}" ]; then
  export CLOUDFLARE_API_TOKEN="${CF_API_TOKEN:-$CLOUDFLARE_API_TOKEN}"
  ok "توکن API از محیط خوانده شد"
elif [ "$DRY" = 1 ]; then
  say "dry-run: would check wrangler whoami / login"
else
  WHO=$($WR whoami 2>&1 || true)
  if printf '%s' "$WHO" | grep -qi "not authenticated"; then
    if [ "$YES" = 1 ]; then
      die "بدون احراز هویت نمی‌شود. یا 'wrangler login' بزنید، یا CF_API_TOKEN را ست کنید."
    fi
    say "مرورگر باز می‌شود — در صفحه‌ی Cloudflare اجازه بدهید."
    $WR login
  fi
  ok "وارد شده‌اید"
fi

# ── ۳. پایگاه‌داده‌ی D1 ───────────────────────────────────────────────────
step "۳. پایگاه‌داده‌ی D1"
CURRENT_ID=$(node -e '
  const fs=require("fs");const s=fs.readFileSync("wrangler.toml","utf8");
  const m=s.match(/database_id\s*=\s*"([^"]*)"/);process.stdout.write(m?m[1]:"");')
PLACEHOLDER='00000000-0000-0000-0000-000000000000'

if [ -n "$CURRENT_ID" ] && [ "$CURRENT_ID" != "$PLACEHOLDER" ]; then
  ok "database_id قبلاً تنظیم شده: ${CURRENT_ID:0:8}…"
  DB_ID="$CURRENT_ID"
else
  say "پیدا کردن/ساختن پایگاه‌داده‌ی «$DB_NAME»…"
  [ "$DRY" = 1 ] && { say "dry-run: would look up / create D1 '$DB_NAME' and patch wrangler.toml"; }
  DB_ID=$([ "$DRY" = 1 ] && echo "" || $WR d1 list --json 2>/dev/null | node -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      try{const a=JSON.parse(d);const f=a.find(x=>x.name===process.argv[1]);
      process.stdout.write(f?f.uuid:"");}catch{process.stdout.write("");}
    });' "$DB_NAME" || true)
  if [ -z "$DB_ID" ]; then
    [ "$DRY" = 1 ] && { say "dry-run: would create D1 '$DB_NAME'"; } || {
      CREATED=$($WR d1 create "$DB_NAME" 2>&1)
      DB_ID=$(printf '%s' "$CREATED" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)
    }
  fi
  if [ "$DRY" = 1 ]; then DB_ID="$PLACEHOLDER"; fi
  [ -n "$DB_ID" ] || die "database_id پیدا نشد. دستی اجرا کنید: $WR d1 create $DB_NAME و مقدار را در wrangler.toml بگذارید."

  if [ "$DRY" != 1 ]; then
    cp wrangler.toml wrangler.toml.bak
    DB_ID="$DB_ID" node -e '
      const fs=require("fs");const id=process.env.DB_ID;
      const p="wrangler.toml";let s=fs.readFileSync(p,"utf8");
      s=s.replace(/database_id\s*=\s*"[^"]*"/,`database_id = "${id}"`);
      fs.writeFileSync(p,s);'
    rm -f wrangler.toml.bak
  fi
  ok "database_id نوشته شد: ${DB_ID:0:8}… (نام: $DB_NAME)"
fi

# ── ۴. مهاجرت‌ها ──────────────────────────────────────────────────────────
step "۴. اعمال مهاجرت‌ها روی D1 واقعی"
if [ "$DRY" = 1 ]; then say "dry-run: would apply schema/ to $DB_NAME --remote"
else
  # CI=1 → wrangler به‌جای پرسش، ادامه می‌دهد؛ echo y برای نسخه‌های قدیمی‌تر
  echo y | CI=1 $WR d1 migrations apply "$DB_NAME" --remote 2>&1 | tail -6
  TABLES=$(echo y | CI=1 $WR d1 execute "$DB_NAME" --remote \
    --command "SELECT count(*) AS n FROM sqlite_master WHERE type='table'" 2>/dev/null | grep -oE '[0-9]+' | tail -1 || echo 0)
  ok "جدول‌های موجود در D1: ${TABLES:-?}"
fi

# ── ۵. استقرار اول ────────────────────────────────────────────────────────
step "۵. استقرار"
say "نکته: تا وقتی SECRET گذاشته نشده، Worker عمداً ۵۰۳ می‌دهد (گارد بوت). این باگ نیست."
if [ "$DRY" = 1 ]; then say "dry-run: would run wrangler deploy"
else
  DEPLOY_OUT=$(CI=1 $WR deploy 2>&1) || { printf '%s\n' "$DEPLOY_OUT" | tail -25; die "دیپلوی ناموفق بود"; }
  URL=$(printf '%s' "$DEPLOY_OUT" | grep -oE 'https://[a-zA-Z0-9._-]+\.workers\.dev' | head -1 || true)
  printf '%s' "$DEPLOY_OUT" | grep -E 'Published|Current Version' | sed 's/^/  /' || true
  ok "دیپلوی شد${URL:+ → $URL}"
fi

# ── ۶. SECRET ─────────────────────────────────────────────────────────────
step "۶. رمز اصلی پنل"
gen() { node -e 'const c=require("crypto");process.stdout.write(c.randomBytes(24).toString("base64url"))'; }

if [ "$DRY" = 1 ]; then
  say "dry-run: would put SECRET (+ RECOVERY_CODE if provided)"
else
  HAS_SECRET=$(CI=1 $WR secret list 2>&1 || true)
  if printf '%s' "$HAS_SECRET" | grep -qE '^\s*SECRET\b|"name":\s*"SECRET"'; then
    ok "SECRET قبلاً گذاشته شده — دست نمی‌زنم"
  else
    if [ -n "${KAVEH_SECRET:-}" ]; then
      SECRET="$KAVEH_SECRET"; say "SECRET از محیط خوانده شد"
    elif [ "$YES" = 1 ]; then
      SECRET=$(gen); GENERATED=1
    else
      printf '\n  %sرمز ورود به پنل را وارد کنید (حداقل ۱۶ کاراکتر).%s\n' "$B" "$N"
      printf '  برای ساخت خودکار یک رمز قوی، فقط Enter بزنید: '
      read -r SECRET || true
      if [ -z "$SECRET" ]; then SECRET=$(gen); GENERATED=1; fi
    fi
    [ "${#SECRET}" -ge 16 ] || die "رمز باید حداقل ۱۶ کاراکتر باشد (این ${#SECRET} بود)"
    printf '%s' "$SECRET" | CI=1 $WR secret put SECRET >/dev/null 2>&1 \
      || printf '%s' "$SECRET" | $WR secret put SECRET >/dev/null
    ok "SECRET گذاشته شد — نسخه‌ی جدید به‌طور خودکار دیپلوی شد"
    if [ -n "${GENERATED:-}" ]; then
      printf '\n  %s⚠ این رمز فقط همین یک‌بار چاپ می‌شود. جای امنی ذخیره کنید:%s\n' "$Y" "$N"
      printf '  %s%s%s\n\n' "$B" "$SECRET" "$N"
    fi
    # کد بازیابی یک‌بارمصرف — اختیاری
    if [ -n "${KAVEH_RECOVERY_CODE:-}" ]; then
      printf '%s' "$KAVEH_RECOVERY_CODE" | CI=1 $WR secret put RECOVERY_CODE >/dev/null 2>&1 || true
      ok "RECOVERY_CODE گذاشته شد"
    fi
  fi
fi

# ── ۷. تأیید ──────────────────────────────────────────────────────────────
step "۷. تأیید زنده بودن"
if [ "$DRY" = 1 ]; then
  say "dry-run: would GET \$URL/api/whoami and \$URL/panel"
  printf '\n%s✓ نقشه کامل است — بدون --dry-run اجرا کنید%s\n\n' "$G" "$N"
  exit 0
fi

[ -n "${URL:-}" ] || URL=$(CI=1 $WR deployments list 2>/dev/null | grep -oE 'https://[a-zA-Z0-9._-]+\.workers\.dev' | head -1 || true)
[ -n "${URL:-}" ] || URL="https://${KAVEH_WORKER:-kaveh}.$(CI=1 $WR subdomain 2>/dev/null | tail -1 | tr -d '[:space:]').workers.dev"

WHOAMI=$(curl -sS -m 20 "$URL/api/whoami" 2>/dev/null || echo '{}')
PANEL=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' "$URL/panel" 2>/dev/null || echo 000)

if printf '%s' "$WHOAMI" | grep -q '"installed":true'; then
  ok "/api/whoami → installed:true"
else
  bad "/api/whoami پاسخ درست نداد: ${WHOAMI:0:120}"
  say "اگر ۵۰۳ دیدید یعنی SECRET هنوز اعمال نشده — چند ثانیه صبر کنید و دوباره امتحان کنید."
fi
[ "$PANEL" = 200 ] && ok "/panel → 200" || bad "/panel → $PANEL"

# کرون: تأیید از راه دور ممکن نیست، پس دقیق بگوییم چطور ببینند
printf '\n%s════ پنل شما ════%s\n' "$B" "$N"
printf '  %s%s/panel%s\n' "$B" "$URL" "$N"
printf '  کرون هر ۱۰ دقیقه: داشبورد → Workers & Pages → Triggers\n'
printf '  یا تب «عیب‌یابی» → «اجرای نگهداشت» (همان کد، با خلاصه‌ی JSON)\n'
printf '  لاگ زنده: %s wrangler tail --format pretty%s\n\n' "$D" "$N"
