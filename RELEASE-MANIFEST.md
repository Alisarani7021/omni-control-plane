# V13.1.1 Release Manifest

Build date: 2026-09-10

## Least-privilege Scoped API Token release

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
- Vitest: 20/20 tests passed across 7 files, including scoped-token connection and lifecycle tests
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
