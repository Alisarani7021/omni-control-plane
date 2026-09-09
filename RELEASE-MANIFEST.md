# V13.0.0 Release Manifest

Build date: 2026-09-09

## Verification status

- Security preflight: passed (16 source files)
- Oxlint: passed with 0 warnings and 0 errors
- TypeScript strict typecheck: passed
- Vitest: 10/10 tests passed across 3 files
- npm audit: 0 known vulnerabilities at moderate-or-higher threshold (and 0 total at build time)
- Wrangler 4.130.0 dry-run build on Node 22.12.0: passed
- D1 migration local application: 24 statements passed
- sing-box 1.14.0 validation: server, VLESS client, and Hysteria2 client fixtures all passed `sing-box check`
- Rendered VPS bootstrap: passed `bash -n`
- Local runtime smoke tests: public health 200; one-time login 303 then replay 400; authenticated API 200; forged static cookie 401; removed legacy paths 404; security headers present

## Pinned external runtime artifact

- sing-box 1.14.0 linux-amd64 SHA-256: `2375de6999f4f56ab46b4fc5ddf26a6aba1d3e61a0f4e7ddec2f4690457d5f63`
- sing-box 1.14.0 linux-arm64 SHA-256: `04d9b40bc98dc55b6f509ce3292145c65478f65866bea64826ebb2f382385088`

## Required manual configuration

The source contains placeholders only. Production deploy requires the owner to configure the D1 database ID, control hostname, bot username, Cloudflare OAuth client ID, and four Worker Secrets described in `docs/SETUP-FA.md`.

No production account, DNS, Telegram, or VPS was changed while creating this release.
