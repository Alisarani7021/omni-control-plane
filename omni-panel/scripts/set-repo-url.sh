#!/usr/bin/env bash
# Make this repo "anyone can deploy their own" ready:
#
#   bash scripts/set-repo-url.sh <github-owner>/<repo> [GH_TOKEN]
#
# 1. rewrites the Deploy-with-Workers button + clone URLs in README.md
# 2. fills repository/homepage/bugs in package.json
# 3. with a GH_TOKEN that has Administration:write, marks the repo as a GitHub
#    TEMPLATE, so other people get a "Use this template" button and can start
#    from a clean copy without fork history
set -euo pipefail
cd "$(dirname "$0")/.."
SLUG="${1:?usage: set-repo-url.sh <owner>/<repo> [GH_TOKEN]}"
GH_TOKEN="${2:-}"
URL="https://github.com/$SLUG"

python3 - "$URL" <<'PY'
import json, re, sys
url = sys.argv[1]

p = "README.md"; s = open(p).read()
s = re.sub(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", url, s)
open(p, "w").write(s)

p = "package.json"; d = json.load(open(p))
d["repository"] = {"type": "git", "url": "git+" + url + ".git"}
d["homepage"] = url + "#readme"
d["bugs"] = {"url": url + "/issues"}
d["keywords"] = sorted(set((d.get("keywords") or []) + [
    "cloudflare-workers", "vless", "trojan", "proxy", "panel", "d1",
    "durable-objects", "subscription", "persian", "self-hosted"]))
json.dump(d, open(p, "w"), ensure_ascii=False, indent=2); open(p, "a").write("\n")
print("README.md + package.json →", url)
PY

if [ -n "$GH_TOKEN" ]; then
  printf "marking %s as a GitHub template → " "$SLUG"
  curl -sS -m 30 -X PATCH -H "Authorization: Bearer $GH_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$SLUG" -d '{"is_template":true,"has_issues":true}' \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d);console.log(r.is_template?"ok":"FAILED "+JSON.stringify(r.message||r).slice(0,120));});'
fi

echo
echo "Deploy button for anyone:"
echo "  https://deploy.workers.cloudflare.com/?url=$URL"
