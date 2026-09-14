#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════
#  دیپلوی مستقیم روی اکانت Cloudflare با توکن API — بدون مرورگر، بدون login
#
#    CF_TOKEN=<token> bash scripts/deploy-remote.sh
#
#  چرا یک اسکریپت جدا از activate.sh؟ چون activate.sh برای انسانی است که پشت
#  کامپیوتر نشسته و می‌تواند `wrangler login` بزند. این برای حالتی است که
#  کاربر روی گوشی است و فقط یک توکن دارد: همه‌چیز با API و بدون پرسش.
#
#  کارهایی که می‌کند، به ترتیب:
#    ۱. اعتبار توکن را با /user/tokens/verify می‌سنجد (قبل از هر تغییری)
#    ۲. اکانت را پیدا می‌کند — اگر بیشتر از یکی بود، CF_ACCOUNT_ID لازم است
#    ۳. تداخل اسم Worker را چک می‌کند و در صورت نیاز اسم جایگزین می‌گذارد
#    ۴. زیردامنه‌ی workers.dev را چک می‌کند
#    ۵. دیپلوی می‌کند (D1 خودش auto-provision می‌شود، اسکیما موقع بوت)
#    ۶. SECRET تولید می‌کند و می‌گذارد — چاپش نمی‌کند
#    ۷. آدرس را واقعاً صدا می‌زند و گزارش می‌دهد
# ══════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

TOKEN="${CF_TOKEN:-${CLOUDFLARE_API_TOKEN:-}}"
[ -n "$TOKEN" ] || { echo "✗ توکن لازم است: CF_TOKEN=… bash scripts/deploy-remote.sh" >&2; exit 2; }

API=https://api.cloudflare.com/client/v4
AUTH="Authorization: Bearer $TOKEN"
step() { printf '\n▸ %s\n' "$1"; }
ok()   { printf '  ✓ %s\n' "$1"; }
bad()  { printf '  ✗ %s\n' "$1"; }
info() { printf '  · %s\n' "$1"; }
die()  { printf '\n✗ %s\n\n' "$1" >&2; exit 1; }

cf() { curl -sS -m 60 -H "$AUTH" -H 'content-type: application/json' "$@"; }
# jget <field-path…> از stdin — پارسر کوچک JSON بدون وابستگی به jq
jget() { node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    let v;try{v=JSON.parse(d)}catch(e){console.log("");return}
    for(const k of process.argv.slice(1)){ v = (v==null?undefined:v[k]); }
    console.log(v===undefined||v===null?"":(typeof v==="object"?JSON.stringify(v):String(v)));
  });' "$@"; }

if [ -x node_modules/.bin/wrangler ]; then WR="node_modules/.bin/wrangler"; else WR="npx --yes wrangler@4.86.0"; fi

# ── ۱. اعتبار توکن ────────────────────────────────────────────────────────
step "۱. اعتبار توکن"
V=$(cf "$API/user/tokens/verify")
if [ "$(printf '%s' "$V" | jget success)" != "true" ]; then
  bad "توکن رد شد"
  printf '%s' "$V" | jget errors | head -c 400; echo
  die "یک توکن جدید بسازید. اجازه‌های لازم: Workers Scripts: Edit + D1: Edit"
fi
ok "توکن معتبر است (status: $(printf '%s' "$V" | jget result status))"

# ── ۲. اکانت ──────────────────────────────────────────────────────────────
step "۲. پیدا کردن اکانت"
ACC=$(cf "$API/accounts?per_page=50")
N=$(printf '%s' "$ACC" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).result.length)}catch{console.log(0)}})')
[ "${N:-0}" -gt 0 ] || die "توکن به هیچ اکانتی دسترسی ندارد. در صفحه‌ی توکن، Account Resources را روی All accounts بگذارید."

if [ -n "${CF_ACCOUNT_ID:-}" ]; then
  ACCOUNT_ID="$CF_ACCOUNT_ID"; info "اکانت از محیط: $ACCOUNT_ID"
elif [ "$N" = 1 ]; then
  ACCOUNT_ID=$(printf '%s' "$ACC" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d).result[0];console.log(r.id+" "+r.name)})')
  ok "اکانت: ${ACCOUNT_ID#* } (${ACCOUNT_ID%% *})"
  ACCOUNT_ID="${ACCOUNT_ID%% *}"
else
  bad "$N اکانت دیده شد — نمی‌دانم کدام"
  printf '%s' "$ACC" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{for(const a of JSON.parse(d).result)console.log("    "+a.id+"  "+a.name)})'
  die "دوباره با CF_ACCOUNT_ID=<id> اجرا کنید (همان id بالا)"
fi
export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID"

# ── ۳. تداخل اسم Worker ───────────────────────────────────────────────────
step "۳. اسم Worker"
WANT=$(node -e 'const s=require("fs").readFileSync("wrangler.toml","utf8");console.log((s.match(/^name\s*=\s*"([^"]+)"/m)||[,"kaveh"])[1])')
SCRIPTS=$(cf "$API/accounts/$ACCOUNT_ID/workers/scripts?per_page=100")
TAKEN=$(printf '%s' "$SCRIPTS" | node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    try{const r=JSON.parse(d).result||[];console.log(r.some(s=>s.id===process.argv[1])?"1":"")}catch{console.log("")}
  });' "$WANT")
NAME="$WANT"
if [ "$TAKEN" = 1 ]; then
  NAME="${WANT}-$(node -e 'console.log(require("crypto").randomBytes(2).toString("hex"))')"
  info "«$WANT» قبلاً در این اکانت هست → از «$NAME» استفاده می‌کنم تا چیز دیگری را خراب نکنم"
else
  ok "اسم «$NAME» آزاد است"
fi
export CLOUDFLARE_API_TOKEN="$TOKEN"

# ── ۴. زیردامنه‌ی workers.dev ─────────────────────────────────────────────
step "۴. زیردامنه‌ی workers.dev"
SUB=$(cf "$API/accounts/$ACCOUNT_ID/workers/subdomain")
SUBDOMAIN=$(printf '%s' "$SUB" | jget result subdomain)
if [ -n "$SUBDOMAIN" ]; then
  ok "زیردامنه: ${SUBDOMAIN}.workers.dev"
  URL="https://${NAME}.${SUBDOMAIN}.workers.dev"
else
  info "این اکانت هنوز زیردامنه‌ی workers.dev ندارد"
  info "wrangler سعی می‌کند موقع دیپلوی ثبتش کند؛ اگر نشد:"
  info "  $WR subdomain <یک-اسم-یونیک>   (یا داشبورد → Workers & Pages → Your subdomain)"
  URL=""
fi

# ── ۵. دیپلوی ─────────────────────────────────────────────────────────────
step "۵. دیپلوی"
info "D1 خودش ساخته می‌شود (database_id عمداً در wrangler.toml نیست)"
if OUT=$(CI=1 $WR deploy --name "$NAME" 2>&1); then
  printf '%s' "$OUT" | grep -E 'Published|Current Version|workers\.dev' | sed 's/^/  /' || true
  ok "دیپلوی شد"
else
  printf '%s\n' "$OUT" | tail -25 | sed 's/^/  /'
  die "دیپلوی ناموفق بود"
fi
[ -n "$URL" ] || URL=$(printf '%s' "$OUT" | grep -oE 'https://[a-zA-Z0-9._-]+\.workers\.dev' | head -1 || true)
[ -n "$URL" ] || die "آدرس Worker پیدا نشد — خروجی بالا را ببینید"

# ── ۶. SECRET ─────────────────────────────────────────────────────────────
step "۶. کلید امضای نشست‌ها"
HAS=$(CI=1 $WR secret list --name "$NAME" 2>&1 || true)
if printf '%s' "$HAS" | grep -qE '\bSECRET\b'; then
  ok "SECRET از قبل هست — دست نمی‌زنم"
else
  # تولید، ارسال، و هرگز چاپ نکردن: این کلید امضای کوکی نشست‌هاست،
  # نه رمز ورود. کسی به آن نیاز ندارد، پس در هیچ لاگی هم نمی‌آید.
  GEN=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')
  printf '%s' "$GEN" | CI=1 $WR secret put SECRET --name "$NAME" >/dev/null 2>&1 \
    || printf '%s' "$GEN" | $WR secret put SECRET --name "$NAME" >/dev/null
  ok "SECRET ساخته و گذاشته شد (چاپ نمی‌شود)"
fi

# ── ۷. تأیید ──────────────────────────────────────────────────────────────
step "۷. تأیید روی آدرس واقعی"
sleep 3
W=$(curl -sS -m 25 "$URL/api/whoami" 2>/dev/null || echo '{}')
P=$(curl -sS -m 25 -o /dev/null -w '%{http_code}' "$URL/panel" 2>/dev/null || echo 000)
printf '%s' "$W" | grep -q '"ok":true' && ok "/api/whoami پاسخ داد: $(printf '%s' "$W" | head -c 160)" \
                                        || bad "/api/whoami: $(printf '%s' "$W" | head -c 200)"
[ "$P" = 200 ] && ok "/panel → 200" || bad "/panel → $P"

printf '\n════════════════════════════════════════\n'
printf '  آدرس پنل:  %s/panel\n' "$URL"
printf '  اکانت:     %s\n' "$ACCOUNT_ID"
printf '  Worker:    %s\n' "$NAME"
printf '════════════════════════════════════════\n'
printf '  قدم بعدی شما: همین آدرس را در مرورگر باز کنید و رمز مدیر را بسازید.\n'
printf '  تا وقتی رمز ساخته نشده، هر کس آدرس را داشته باشد می‌تواند مالک پنل شود.\n'
printf '  بعد از آن، توکن API را در داشبورد Delete/Roll کنید.\n\n'
