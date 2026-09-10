#!/usr/bin/env bash
set -Eeuo pipefail

VERSION=1.14.0
AMD64_SHA256=2375de6999f4f56ab46b4fc5ddf26a6aba1d3e61a0f4e7ddec2f4690457d5f63
ARM64_SHA256=04d9b40bc98dc55b6f509ce3292145c65478f65866bea64826ebb2f382385088
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64; EXPECTED_SHA=$AMD64_SHA256 ;;
  aarch64|arm64) ARCH=arm64; EXPECTED_SHA=$ARM64_SHA256 ;;
  *) printf 'Unsupported test architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
esac

ARCHIVE="$TMP_DIR/sing-box.tar.gz"
URL="https://github.com/SagerNet/sing-box/releases/download/v$VERSION/sing-box-$VERSION-linux-$ARCH.tar.gz"
curl --fail --show-error --silent --location --proto '=https' --tlsv1.2 --retry 3 "$URL" -o "$ARCHIVE"
printf '%s  %s\n' "$EXPECTED_SHA" "$ARCHIVE" | sha256sum --check --status
tar -xzf "$ARCHIVE" -C "$TMP_DIR"
BIN=$(find "$TMP_DIR" -type f -name sing-box -perm -u+x | head -n 1)
"$BIN" version | grep -F "sing-box version $VERSION" >/dev/null
for config in "$ROOT"/tests/fixtures/*-sing-box-1.14.json; do
  printf 'Checking %s\n' "$(basename "$config")"
  "$BIN" check -c "$config"
done
printf 'All sing-box %s fixtures are valid.\n' "$VERSION"
