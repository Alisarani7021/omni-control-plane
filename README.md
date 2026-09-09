# V13 Control Plane

A secure, multi-tenant BYOC control plane for Cloudflare, Telegram, D1, Workflows, and user-owned VPS nodes.

## What it does

- Uses Telegram only as an identity/bootstrap UI; it never asks users to paste Cloudflare tokens or VPS passwords into chat.
- Uses Cloudflare OAuth Authorization Code + PKCE and minimum configured scopes.
- Stores tenants, sessions, jobs, audit events, and health status in D1.
- Encrypts OAuth and deployment credentials with AES-256-GCM envelope encryption and context-bound AAD.
- Provisions idempotently through Cloudflare Workflows.
- Deploys a locally bundled data-plane Worker; no runtime download of unpinned Worker source.
- Installs pinned sing-box `1.14.0` on an existing Debian/Ubuntu VPS after SHA-256 verification.
- Generates only two implemented profiles: VLESS Reality over TCP/443 and Hysteria2 over UDP/443.
- Protects subscriptions with random per-deployment revocable bearer URLs.
- Sends no subscription credentials through Telegram.

## Deliberately not included

- Password login, forgeable flag cookies, public `/setwebhook`, public `/sub`, token onboarding in chat, plaintext credential storage, third-party panel installers, fabricated protocol links, or promises of connectivity during a total loss of network path.
- VPS purchasing: the owner must choose/pay for a provider and obtain a public IPv4 VPS. After that, DNS, sing-box install, server configuration, validation, data-plane publication, and health reporting are automated.

## Start here

Read **[`docs/SETUP-FA.md`](docs/SETUP-FA.md)** from top to bottom. It includes emergency rotation of credentials exposed by the old Worker and a zero-to-production deployment guide.

Additional documents:

- [`docs/ARCHITECTURE-FA.md`](docs/ARCHITECTURE-FA.md)
- [`docs/SECURITY-FA.md`](docs/SECURITY-FA.md)
- [`docs/OPERATIONS-FA.md`](docs/OPERATIONS-FA.md)

## Verification

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

`verify:sing-box` downloads the official `1.14.0` Linux archive over HTTPS, verifies its pinned SHA-256, and runs `sing-box check` against the server and both client fixtures.

## Runtime secrets

Set only with `wrangler secret put`:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `CF_OAUTH_CLIENT_SECRET`
- `TOKEN_ENCRYPTION_KEY` (base64url encoding of exactly 32 random bytes)

Never put real values in `wrangler.jsonc`, source code, Telegram, tickets, or screenshots.

## License and responsibility

Use only on accounts, domains, and servers you own or are explicitly authorized to administer. Availability depends on Cloudflare, the VPS, and reachable network paths. No software can guarantee external connectivity when no route to external infrastructure exists.
