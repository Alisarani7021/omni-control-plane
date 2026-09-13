# V13.5.0 Release Manifest

Build date: 2026-09-13

## V13.5.1 — Independent DNS center

- New top-level «🌐 مرکز DNS» section, deliberately not nested in any other hub: healthy-resolver discovery (user-supplied IPv4//24../32 range, real TCP/53 canary probes from the Worker, verdicts healthy/fake/wrong/unreachable, chunked cron scanning with a fresh full pass every 30 minutes, 3 active ranges per tenant, 24h retention), the DNS-poison test with operator+city picker producing a single copy-paste-ready command, and three config builders that act through the tenant's own scoped Cloudflare connection: Master DNS (own DoH + RFC 9462-style SVCB record + protected sing-box/Clash snippets), White DNS (personal whitelist published as read-only TXT chunks in the user's zone + sing-box routing snippet) and Slipstream (delegation on demand + slipnet:// line with the node public key).
- Migration `0006_dns_center.sql`; cron wires `scanDueRanges` + `purgeOldDnsScans`.
- Production fixes shipped alongside: APNIC as the real source of IR ranges (the previously used RIPE irnic path never existed), Telegram-HTML-safe how-to texts, typed Cloudflare API errors with honest Persian wording, and automatic connection rebind for sleeper beacon publishes.

## V13.5.0 — National-net intelligence

- Network-state classification (`src/net-mode.ts`) with four honest states (open / throttled / national-only / blackout) plus an explicit `nodata` state; fed by two independent eyes: edge HTTPS probes run by the Worker cron every 5 minutes and inner agent reports. States render on the `/health` card and per-node detail with Persian labels; nothing is guessed without measurements.
- DNS-poisoning self-test (`src/dns-poison.ts`): public `GET /api/v1/dns-test.sh` one-liner asks known canaries through documented resolvers (system, 1.1.1.1, dns.cloudflare.com, Shecan, 403.online, Radar); answers of `127.0.0.1`/`0.0.0.0`/known blackhole IPs count as fake; anonymous, rate-limited ingest at `POST /api/v1/telemetry/dns-poison` and an honest «N از M پاسخ جعلی بود» card that also feeds the censorship-map aggregate (province|isp).
- Own-domain DoH on the user's data-plane Worker (`GET/POST /dns-query?k=v13_…`, RFC 8484): credential-gated, deterministic split resolver (.ir and national CDN names → national resolver, everything else → 1.1.1.1 via TCP-framed sockets), only A/AAAA/TXT answered (REFUSED otherwise), single cached response per question, hourly cap, counts-only D1 accounting. Android Private DNS is DoT (port 853) which Workers cannot serve; the honest equivalent is the one-field DoH URL in generated profiles, documented as such.
- DNS bootstrap without hosts-file dependence: generated sing-box profiles pin the Worker DoH hostname with a route rule (`override_address`/`override_port` plus a `tcp://1.1.1.1` address resolver); Clash output uses an equivalent `hosts:` map.
- Daily national-range intelligence (`src/geoip-ir.ts`): cron snapshots APNIC `delegated-apnic-extended-latest` (IRNIC is not part of the RIR statistics exchange; Iranian rows arrive via APNIC as its NIR), filters cc=IR, diffs against the previous day, keeps 14 days, and renders «منبع APNIC stats · +N رنج · -M رنج · امروز» with the snapshot sha256; a public sing-box v2 rule-set is served at `GET /api/v1/geoip-ir.json`.
- DNS tunnel auto-provisioning on the user's VPS (`src/dns-tunnel.ts` + bootstrap units): `t.<zone>` NS delegation through the existing scoped connection (single call); bootstrap installs `dnstt-server` (upstream Go module, sumdb-enforced) and `slipstream-server` pinned to commit `3e15c2d877b2a575a64ffc60da18123f6e6b259d`; Go 1.27.1 toolchain tarballs verified against official go.dev/dl SHA-256 constants with a loud failure on mismatch; keypairs are generated on the VPS and only public keys travel back via `/api/v1/agent/report`; bot card shows the ready `slipnet://` URI with copy button, app/field guide and TXT round-trip liveness (≤2s) on the health card; MTU auto-measurement probes five sizes (512…1400) and records the largest winner per (isp|province); expectations text (DNSTT tens–hundreds of kbit/s, Slipstream several times that, not a DNS replacement) and amplifier-abuse defenses (recursion off, ANY off, rate-limit, noisy-query drop) ship on the same card.
- «مستقیم داخل کشور» one-click profiles: every generated profile carries fixed route rules (.ir + geoip-ir rule-set + domestic CDNs + private ranges + DoH bootstrap pin → direct; everything else → tunnel), a measured direct-vs-tunnel ms comparison and a per-domain race winner rule-set (`GET /api/v1/race-direct.json`, ingest at `POST /api/v1/telemetry/race`, minimum two samples); three named outputs per protocol cover sniff-off and fakedns-on states, and a full Clash YAML (hosts pin + `GEOIP,IR,DIRECT`) is served from the subscription endpoint.
- Sleeper «خواب‌نت» nodes (`src/sleeper.ts`): `deployments.role = "sleeper"` silences periodic reporting while keeping contact; a deterministic per-day window (anchor hour ±9-minute jitter) reads exactly one read-only TXT beacon wrapped like WhiteHole (~1KB observed, stored locally at `/var/lib/v13-agent/sleeper.log`); survives a total control-plane Worker block because it needs no inbound path; the bot card states the three ethical constraints (own server only, own credentials only, ⛔ instant wake/sleep button plus user-inspectable local log) and refuses to arm without explicit consent.
- Telegram hardening: `TelegramMessage.date` is now required and updates older than ten minutes are acknowledged but never processed (webhook replay defense).
- Migration `0005_net_intel.sql` (new tables + deployment/agent_report columns); re-run `scripts/set-telegram-webhook.mjs` after deploy for the new bot commands.
- Tests: five new suites (`net-mode`, `dns-poison`, `geoip-ir`, `sleeper`, `dns-tunnel`) plus domestic-race, bootstrap, DoH and profile-policy assertions — 163 tests total.
- Full documentation in Persian: `docs/NET-INTEL-FA.md`.

## V13.4.0 — OMNI panel sections, ported into the Telegram bot

- The standalone `worker.js` bot surface is now native in this control plane: clean-IP radar (`/cleanip`), live censorship map / نت ملی (`/map`), WhiteHole DNS dead-drop publish & clear (`/whitehole`), AI key donation pool (`/donate`), node health (`/health`) and real counts (`/usage`); every view also has an inline-button equivalent.
- Crowdsourced telemetry has a public, strictly validated and rate-limited ingest surface: `POST /api/v1/telemetry/clean-ip`, `GET /api/v1/clean-ip` (JSON/text), `POST /api/v1/telemetry/map`, `GET /api/v1/map`, `GET /api/v1/whitehole/fetch.sh`.
- Honest data only: no simulated probes, no fabricated ping/online/traffic numbers. Unmeasured IPs are labelled `⚪ بدون داده`, and the absence of traffic metering is stated in the usage view.
- WhiteHole drops publish only IP/port/SNI/resolver TXT shards into the tenant's own zone through their scoped connection (6 publishes/hour); subscription links are never written to public DNS.
- Donated AI keys require an explicit consent screen, are encrypted with `TOKEN_ENCRYPTION_KEY` in a separate table, are displayed only as a redacted snippet, expire after 30 days, are withdrawn by the donor on demand, are reviewed only by `ADMIN_TELEGRAM_IDS`, and are never described as "active in a global pool".
- Intentionally not ported (hardcoded bot token in `worker.js` must be revoked, in-chat Cloudflare tokens, remote panel source deployment, forgeable `omni_auth=1` web login, worker-hosted proxy core, non-working PHANTOM decoy configs, `curl | bash` dnstt root installer): see `docs/PANEL-SECTIONS-FA.md`.
- New `0004_panel_sections.sql` migration plus `telegram_flows` for short-lived report/donation conversations; re-run `scripts/set-telegram-webhook.mjs` to register the six new bot commands.
- Tests: `tests/clean-ip.test.ts`, `tests/censorship-map.test.ts`, `tests/whitehole.test.ts`, `tests/ai-donate.test.ts`, `tests/telemetry-routes.test.ts` and an extended Telegram webhook suite (117 tests).

## V13.3.0 — Full worker management inside Telegram

- The bot now exposes full worker capabilities natively: step-by-step deployment wizard (7 steps + confirm), deployments list/detail, retry, revoke (with confirmation), bootstrap commands, subscription view/rotation, and Cloudflare connection list/disconnect.
- The «🛰️ ورود به محیط اختصاصی V13» section stays separate; login now offers two one-time links: open the panel inside Telegram (WebApp) or in the browser.
- New Cloudflare connections are still created only in the secure panel (inside Telegram via WebApp or in the browser); raw API tokens are never accepted in chat.
- Sensitive bot outputs (bootstrap commands, subscription URLs) are sent with `protect_content` plus a self-destruct («🧨 حذف این پیام») button.
- Bot and panel share one code path: `src/bot-actions.ts` reuses the same deployment/connection handlers with a bot principal; ownership and resource boundaries are enforced identically.
- New `0003_telegram_wizards.sql` migration stores short-lived (30-minute) wizard state; run `npx wrangler d1 migrations apply v13-control-plane --remote` before deploy.
- New `/cancel` bot command; webhook script installs it automatically.

## Omni private-section integration

- The Telegram bot is now the Omni private section: `/start` shows the Omni main menu with a dedicated «🛰️ ورود به محیط اختصاصی V13» button; pressing it issues a one-time login link and the follow-up button enters `/app`.
- Direct entry links (`/start v13`, plus `panel`/`app`/`omni` args), `/panel`, `/status` (Persian status summary, no secrets in chat) and `/help` commands are supported; plain-text menu labels work as button equivalents.
- Webhook registration now subscribes to `message` + `callback_query` and installs bot commands; re-run `scripts/set-telegram-webhook.mjs` after deploy.
- A dedicated branded entry page is served at `GET /omni` and linked from the landing page.
- Optional coexistence with an external Omni worker via `OMNI_FALLBACK_URL` (+ `OMNI_FALLBACK_SECRET`): updates outside the V13 section are forwarded over HTTPS; topologies are documented in `docs/OMNI-INTEGRATION-FA.md`.
- Free-text messages no longer receive a login link; the bot replies with a security reminder and the menu. Behavior change is intentional.

## nginx coexistence and pinned Hysteria2 TLS

- Hysteria2 now uses a locally generated P-256 self-signed certificate with certificate and SPKI SHA-256 pins; it no longer needs ACME listeners on TCP/80 or TCP/443 and therefore coexists with nginx without stopping it.
- Certificate pins are validated by the control plane, stored in the encrypted deployment bundle and propagated to both the Hysteria2 URI and sing-box client profile.
- When UFW is already active, Bootstrap adds only the detected SSH port, selected VLESS TCP port and Hysteria2 UDP/443 rule even when automatic UFW activation was not requested.
- The script-review command redacts `BOOTSTRAP_TOKEN` before displaying the downloaded file.
- One-time Telegram dashboard login links remain valid for 15 minutes (`LOGIN_LINK_TTL_SECONDS=900`).
- One-time Telegram dashboard login links remain valid for 15 minutes (`LOGIN_LINK_TTL_SECONDS=900`).
- One-time Telegram dashboard login links remain valid for 15 minutes (`LOGIN_LINK_TTL_SECONDS=900`).

## VPS bootstrap reliability hotfix

- The protected `/etc/sing-box` directory is explicitly owned by `root:sing-box` with mode `0750`, allowing the unprivileged service account to traverse the directory while keeping configuration secrets private.
- The hardened systemd sandbox now permits `AF_NETLINK`, which sing-box requires to subscribe to Linux route updates.
- Service startup is bounded and fail-fast instead of waiting indefinitely inside `systemctl enable --now`; failures emit the latest unit logs.
- Re-running an interrupted Bootstrap restarts sing-box so the reported credentials always match the active configuration.
- Bootstrap safely probes local sockets: VLESS Reality uses TCP/443 when free and automatically falls back to TCP/8443 when an existing web server such as nginx owns 443; Hysteria2 remains on UDP/443.
- The selected VLESS port is validated, stored inside the encrypted deployment bundle and propagated into every generated URI/client profile.
- Server listeners are IPv4-bound because provisioning requires a public IPv4 address; this avoids failures on hosts with IPv6 disabled.
- Script review falls back to `sed` on minimal Ubuntu images where `less` is not installed.
- Revocation marks the deployment before starting its Workflow, removing a race that could leave a completed revocation displayed as `revoking`.
- Reusing a Worker name or hostname now returns an explicit `409 deployment_resource_conflict` instead of a generic internal-server error.

## Least-privilege Scoped API Token release

- Zone selection now uses Cloudflare's effective per-zone `#dns_records:edit` permission metadata when the zone-list endpoint returns additional visible zones; broad DNS-edit tokens still fail closed.
- Token connection success and errors are rendered inside the Cloudflare connection card instead of the deployment form.
- The dashboard now provides an official Cloudflare template URL that pre-fills the token name and all three required permissions; the user only narrows Account/Zone resources, confirms creation, and pastes the one-time token back into V13.
- The primary Cloudflare connection path is a scoped API token submitted only through the authenticated same-origin HTTPS dashboard.
- Global API Key headers are prohibited. OAuth start/callback routes remain disabled and absent from the UI.
- Required permissions are limited to Workers Scripts Edit on one account plus DNS Edit and Zone Read on one specific zone.
- Token status and native expiry are checked with `/user/tokens/verify`.
- The connection endpoint performs non-destructive zone, DNS and Workers capability preflights and rejects tokens exposing more than one active zone.
- The discovered account and zone are persisted as an immutable connection resource boundary and enforced before deployment/rebinding.
- Tokens are encrypted with AES-256-GCM and connection-bound AAD. Stored expiry is the earlier of the local TTL (default 7,200 seconds) and Cloudflare's token expiry.
- No generic Cloudflare API proxy exists. Calls remain restricted to token verification, zone discovery, DNS and required Workers operations.
- Stored ciphertext is scrubbed after ready, failure, revoke/cancellation, disconnect, workflow-start failure or expiration. A scheduled handler runs every five minutes.
- Connection creation is authenticated, same-origin, size-limited and rate-limited, with at most three unexpired token connections per tenant.
- The dashboard provides exact least-privilege token creation steps and never places a token in URL, audit, log, Telegram or data plane.
- `0002_temporary_api_token.sql` adds authentication type, resource-boundary fields and an expiration index without removing existing data.

## Verification status

- Security preflight: passed
- Oxlint: 0 warnings and 0 errors
- TypeScript strict typecheck: passed
- Vitest: 56/56 tests passed across 9 files (21 Telegram + 9 wizard tests)
- npm audit: 0 known vulnerabilities
- Wrangler 4.130.0 dry-run build under Node.js 22: passed
- D1 clean local migration: both migrations applied; auth/resource columns and expiry index verified
- sing-box 1.14.0 server and client fixtures: passed

## Pinned external runtime artifact

- sing-box 1.14.0 linux-amd64 SHA-256: `2375de6999f4f56ab46b4fc5ddf26a6aba1d3e61a0f4e7ddec2f4690457d5f63`
- sing-box 1.14.0 linux-arm64 SHA-256: `04d9b40bc98dc55b6f509ce3292145c65478f65866bea64826ebb2f382385088`

## Required owner action

1. Back up D1 and apply `0002_temporary_api_token.sql`.
2. Deploy with `API_TOKEN_TTL_SECONDS=7200` and the five-minute cleanup cron.
3. Users create a custom token with the exact permissions/resources shown in the dashboard.
4. Users paste the token only into the authenticated HTTPS form and may revoke/delete it in Cloudflare after completion.
