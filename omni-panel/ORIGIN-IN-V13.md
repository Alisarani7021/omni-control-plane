# OMNI panel inside this repo

This directory is the full OMNI panel source (engine, agent channel, headless
bundle, optional web UI, tests, docs), imported on 2026-09-14 from the now
**deleted** standalone repository at commit b63b34c355d0ee5c5924b471e8213e41eb5d644b.

The Telegram bot in ../src is the primary UI. `scripts/sync-omni-panel.mjs`
pins the headless bundle from this tree into src/omni-source.ts — no network,
no external repo. The web UI here is an optional component of the same product.
