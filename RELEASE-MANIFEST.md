# V13.2.0 Release Manifest

Build date: 2026-09-10

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
- Vitest: 38/38 tests passed across 6 files (15 new Omni/Telegram tests)
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
