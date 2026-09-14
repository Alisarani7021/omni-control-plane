#!/usr/bin/env bash
# End-to-end smoke test against a RUNNING Worker (local or production).
#
#   BASE=http://127.0.0.1:8787 PASSWORD='kaveh-demo-1234' bash scripts/smoke.sh
#
# Exercises every layer: assets → auth → D1 → Durable Objects → config
# generation → subscription → cron. Exits non-zero on the first failure so CI
# can gate a deploy on it.
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:8787}"
PASSWORD="${PASSWORD:-kaveh-demo-1234}"
J="$(mktemp)"
PASS=0; FAIL=0

say()  { printf '  %s\n' "$*"; }
ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$*"; }
chk()  { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (expected $2, got $1)"; fi; }
code() { curl -s -o "$1" -w '%{http_code}' "${@:2}"; }

echo "── Kaveh smoke test → $BASE"

echo "▸ static assets (served by the asset server, not the Worker)"
c=$(code /tmp/k_idx.html "$BASE/")
chk "$c" "200" "GET / → 200"
grep -q "کاوه" /tmp/k_idx.html && ok "shell contains the panel markup" || bad "shell looks wrong"
c=$(code /dev/null "$BASE/assets/app.css"); chk "$c" "200" "GET /assets/app.css"
c=$(code /dev/null "$BASE/panel");           chk "$c" "200" "GET /panel (SPA fallback)"

echo "▸ boot state"
c=$(code /tmp/k_who.json "$BASE/api/whoami"); chk "$c" "200" "GET /api/whoami"
INSTALLED=$(python3 -c 'import json;print(json.load(open("/tmp/k_who.json")).get("installed"))' 2>/dev/null || echo False)

echo "▸ auth"
if [ "$INSTALLED" = "False" ]; then
  c=$(code /tmp/k_auth.json -c "$J" -X POST "$BASE/api/setup" -H 'content-type: application/json' -d "{\"username\":\"admin\",\"password\":\"$PASSWORD\"}")
  chk "$c" "200" "POST /api/setup"
else
  say "panel already installed → logging in"
  c=$(code /tmp/k_auth.json -c "$J" -X POST "$BASE/api/login" -H 'content-type: application/json' -d "{\"password\":\"$PASSWORD\"}")
  chk "$c" "200" "POST /api/login"
fi
grep -q "kaveh_session" "$J" && ok "session cookie set on the RESPONSE (HttpOnly/SameSite=Strict)" || bad "no session cookie"

c=$(code /dev/null "$BASE/api/overview"); chk "$c" "401" "unauthenticated /api/overview → 401"
c=$(code /tmp/k_ov.json -b "$J" "$BASE/api/overview?days=7"); chk "$c" "200" "authenticated /api/overview → 200"

echo "▸ users (D1 round-trips)"
U="smoke-$(date +%s)"
c=$(code /tmp/k_new.json -b "$J" -X POST "$BASE/api/users" -H 'content-type: application/json' \
  -d "{\"username\":\"$U\",\"quota_gb\":50,\"expiry_days\":30,\"fragment\":\"mci\",\"fingerprint\":\"chrome\",\"device_limit\":2}")
chk "$c" "200" "POST /api/users ($U)"
UUID=$(python3 -c 'import json;print(json.load(open("/tmp/k_new.json"))["user"]["uuid"])' 2>/dev/null)
TOKEN=$(python3 -c 'import json;print(json.load(open("/tmp/k_new.json"))["user"]["sub_token"])' 2>/dev/null)
[ -n "$UUID" ] && ok "uuid issued: ${UUID:0:8}…" || bad "no uuid"

c=$(code /tmp/k_get.json -b "$J" "$BASE/api/users/$U"); chk "$c" "200" "GET /api/users/$U"
python3 - <<'PY' && ok "configs generated for all 4 formats" || bad "config generation incomplete"
import json,sys
c=json.load(open("/tmp/k_get.json"))["configs"]
assert c["uris"] and c["uris"][0].startswith("vless://"), "no vless uri"
assert c["singbox"]["outbounds"], "no sing-box outbounds"
assert "proxies:" in c["clash"], "no clash proxies"
assert len(c["base64"]) > 40, "no base64 sub"
q=dict(x.split("=",1) for x in c["uris"][0].split("?",1)[1].split("#")[0].split("&"))
assert q["security"]=="tls" and q["sni"] and q["type"]=="ws" and q["fp"]=="chrome", "missing uri params"
PY

echo "▸ duplicate username must 409, not silently overwrite"
c=$(code /dev/null -b "$J" -X POST "$BASE/api/users" -H 'content-type: application/json' -d "{\"username\":\"$U\",\"quota_gb\":1}")
chk "$c" "409" "duplicate POST /api/users"

echo "▸ subscription endpoints"
c=$(code /tmp/k_sub.txt "$BASE/s/$TOKEN"); chk "$c" "200" "GET /s/<token>"
python3 -c 'import base64,sys;d=base64.b64decode(open("/tmp/k_sub.txt","rb").read());assert d.startswith(b"vless://")' \
  && ok "base64 body decodes to vless://" || bad "sub body is not base64 vless"
c=$(code /dev/null "$BASE/s/$TOKEN?type=singbox"); chk "$c" "200" "GET /s/<token>?type=singbox"
c=$(code /dev/null "$BASE/s/$TOKEN?type=clash");   chk "$c" "200" "GET /s/<token>?type=clash"
c=$(code /dev/null "$BASE/s/does-not-exist");      chk "$c" "404" "unknown token → 404"
c=$(code /tmp/k_st.html "$BASE/status/$TOKEN");    chk "$c" "200" "GET /status/<token>"

echo "▸ bulk operations (single D1 batch)"
c=$(code /tmp/k_bulk.json -b "$J" -X POST "$BASE/api/users/bulk" -H 'content-type: application/json' \
  -d "{\"usernames\":[\"$U\"],\"op\":\"reset_traffic\"}")
chk "$c" "200" "POST /api/users/bulk"

echo "▸ settings + audit log"
c=$(code /tmp/k_set.json -b "$J" -X PUT "$BASE/api/settings" -H 'content-type: application/json' \
  -d '{"public_host":"panel.example.workers.dev","block_nsfw":"1","clean_ips":["104.16.0.0"]}')
chk "$c" "200" "PUT /api/settings"
python3 -c 'import json;s=json.load(open("/tmp/k_set.json"))["settings"];assert "admin_hash" not in s' \
  && ok "admin_hash redacted from the browser payload" || bad "SECRET LEAKED TO CLIENT"
c=$(code /tmp/k_log.json -b "$J" "$BASE/api/diag/logs?limit=20"); chk "$c" "200" "GET /api/diag/logs"
python3 -c 'import json;e=json.load(open("/tmp/k_log.json"))["entries"];assert any(x["action"]=="user.create" for x in e)' \
  && ok "user.create recorded in the audit trail" || bad "audit log missing the create event"
python3 -c 'import json;e=json.load(open("/tmp/k_log.json"))["entries"];assert all(not x["ip_hash"] or len(x["ip_hash"])<=16 for x in e)' \
  && ok "audit stores an IP hash, never a raw IP" || bad "raw IP in audit log"

echo "▸ CSRF: mutating request with no JSON content-type is refused"
c=$(code /dev/null -b "$J" -X POST "$BASE/api/users/bulk" -H 'content-type: text/plain' -d 'x')
chk "$c" "403" "POST without JSON/csrf header → 403"

echo "▸ rate limiting via the Guard Durable Object"
# A unique source IP per run, so re-running the suite doesn't inherit a ban.
# In production Cloudflare overwrites cf-connecting-ip, so this can't be spoofed;
# under `wrangler dev --local` it passes through, which is what we want here.
FAKE_IP="203.0.113.$((RANDOM % 250 + 1))"
CODES=""
for i in $(seq 1 12); do CODES="$CODES $(code /dev/null -X POST "$BASE/api/login" -H 'content-type: application/json' -H "cf-connecting-ip: $FAKE_IP" -d '{"password":"wrong-password-x"}')"; done
# Assert on the whole sequence, not the final code. Against production the fake
# cf-connecting-ip is overwritten by Cloudflare, so all 12 attempts land on the
# real source IP and the Guard escalates 401 → 429 → 403 (a 15-minute ban after
# three abusive windows). Reading only the last code would report 403 and call a
# perfectly working brute-force guard a failure.
say "codes:$CODES"
if printf '%s' "$CODES" | grep -q 429; then
  ok "Guard returned 429 within 12 failed logins (from $FAKE_IP)"
elif printf '%s' "$CODES" | grep -q 403; then
  ok "Guard escalated straight to a 403 ban — this IP was already abusive (expected on a re-run against production)"
else
  bad "no rate limiting at all:$CODES"
fi
# Lift it again so the next run (and the operator's own browser) is not locked out.
UB=$(code /tmp/k_ub.json -b "$J" -X POST "$BASE/api/diag/unban" -H 'content-type: application/json' -d '{}')
chk "$UB" "200" "POST /api/diag/unban (self-unban for the operator's IP)"

echo "▸ maintenance pass (the exact code the Cron Trigger runs)"
c=$(code /tmp/k_maint.json -b "$J" -X POST "$BASE/api/diag/maintenance" -H 'content-type: application/json' -d '{}')
chk "$c" "200" "POST /api/diag/maintenance"
python3 -c 'import json;d=json.load(open("/tmp/k_maint.json"));assert "expired_handled" in d and "ms" in d' \
  && ok "summary returned: $(python3 -c 'import json;d=json.load(open("/tmp/k_maint.json"));print(f"expired={d["expired_handled"]} ips={d["ips_rotated"]} {d["ms"]}ms")')" \
  || bad "maintenance summary malformed"
# `wrangler dev --local` cannot dispatch /cdn-cgi/handler/scheduled reliably
# (it answers "exception" without invoking the handler), so the cron body is
# verified through the shared entrypoint above instead. In production the
# Cron Trigger calls scheduled() directly — `wrangler tail` shows the
# "maintenance.done" line every 10 minutes.
say "note: local /cdn-cgi/handler/scheduled is skipped — see docs/DEPLOY.md"

echo "▸ tunnel probe (VLESS over WebSocket) — before cleanup, the user must exist"
# Target must NOT be a Cloudflare-fronted host: Workers are forbidden from
# connect()ing into Cloudflare's own network, so cp.cloudflare.com / discord.com
# / 1.1.1.1 all fail with "proxy request failed, cannot connect to the specified
# address" — a platform rule, not a Kaveh bug. Verified against production:
#   api.github.com:443 ✓   httpbin.org:80 ✓   httpbin.org:443 ✓
#   www.wikipedia.org:443 ✓   cp.cloudflare.com:80 ✗   discord.com:443 ✗
TUNNEL_HOST="${TUNNEL_HOST:-httpbin.org}"
TUNNEL_PORT="${TUNNEL_PORT:-80}"
node --experimental-websocket scripts/ws-probe.js "$BASE" "$UUID" "$TUNNEL_HOST" "$TUNNEL_PORT" >/tmp/k_ws.txt 2>&1
if grep -q "TUNNEL OK" /tmp/k_ws.txt; then
  ok "VLESS tunnel carried real bytes to origin ($TUNNEL_HOST:$TUNNEL_PORT)"
  grep "response header" /tmp/k_ws.txt | sed 's/^/      /'
else
  bad "tunnel probe failed:"; sed 's/^/      /' /tmp/k_ws.txt
fi

echo "▸ cleanup"
# The frontend always sends x-kaveh-csrf (see ui/assets/api.js); a bodyless
# DELETE from curl must too, otherwise the CSRF gate rejects it — by design.
c=$(code /dev/null -b "$J" -H 'x-kaveh-csrf: 1' -X DELETE "$BASE/api/users/$U"); chk "$c" "200" "DELETE /api/users/$U (with CSRF header)"

rm -f "$J"
echo
printf '── %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
