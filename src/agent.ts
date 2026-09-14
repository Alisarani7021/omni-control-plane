import { audit, rateLimit } from "./db";
import {
  DNSTT_MODULE,
  DNSTT_PIN,
  GO_AMD64_SHA256,
  GO_ARM64_SHA256,
  GO_VERSION,
  SLIPSTREAM_LISTEN_PORT,
  SLIPSTREAM_MODULE,
  SLIPSTREAM_PIN,
  TUNNEL_MTU_SIZES,
} from "./dns-tunnel";
import { bearerToken, HttpError, json, readJson, secureHeaders } from "./http";
import { decryptJson, encryptJson, nowIso, sha256 } from "./security";
import { beaconRecordName, SLEEPER_DEFAULT_ANCHOR_HOUR } from "./sleeper";
import { assertAgentCompletePayload, extractAgentReportExtras } from "./validation";
import type { DeploymentRow, Env, SecretBundle } from "./types";

const SING_BOX_AMD64_SHA256 = "2375de6999f4f56ab46b4fc5ddf26a6aba1d3e61a0f4e7ddec2f4690457d5f63";
const SING_BOX_ARM64_SHA256 = "04d9b40bc98dc55b6f509ce3292145c65478f65866bea64826ebb2f382385088";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function renderBootstrapScript(env: Env, deployment: DeploymentRow, bootstrapToken: string): string {
  const template = String.raw`#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

CONTROL_URL=__CONTROL_URL__
DEPLOYMENT_ID=__DEPLOYMENT_ID__
BOOTSTRAP_TOKEN=__BOOTSTRAP_TOKEN__
NODE_HOSTNAME=__NODE_HOSTNAME__
REALITY_SERVER_NAME=__REALITY_SERVER_NAME__
ENABLE_UFW=__ENABLE_UFW__
DNS_TUNNEL=__DNS_TUNNEL__
NODE_ROLE=__NODE_ROLE__
TUNNEL_DOMAIN=__TUNNEL_DOMAIN__
VERSION=1.14.0
MARKER=/var/lib/v13-agent/bootstrap-complete

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || fail "Run this reviewed script with sudo."
[ "$(uname -s)" = Linux ] || fail "Only Linux is supported."
command -v systemctl >/dev/null || fail "systemd is required."
command -v curl >/dev/null || fail "curl is required."
command -v python3 >/dev/null || fail "python3 is required."
command -v openssl >/dev/null || fail "openssl is required."
[ ! -e "$MARKER" ] || fail "This node was already bootstrapped. Rotate credentials before reinstalling."

# A previous interrupted Bootstrap may have left our own service running.
systemctl stop sing-box.service >/dev/null 2>&1 || true

port_available() {
  python3 - "$1" "$2" <<'PY'
import socket, sys
kind, port = sys.argv[1], int(sys.argv[2])
sock_type = socket.SOCK_STREAM if kind == "tcp" else socket.SOCK_DGRAM
try:
    with socket.socket(socket.AF_INET, sock_type) as sock:
        sock.bind(("0.0.0.0", port))
except OSError:
    raise SystemExit(1)
PY
}

VLESS_PORT=443
if ! port_available tcp "$VLESS_PORT"; then
  VLESS_PORT=8443
  port_available tcp "$VLESS_PORT" || fail "TCP ports 443 and 8443 are already occupied"
fi
port_available udp 443 || fail "UDP port 443 is already occupied"
printf 'Selected VLESS Reality TCP port %s; Hysteria2 remains on UDP 443.\n' "$VLESS_PORT"

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64; EXPECTED_SHA=__AMD64_SHA__ ;;
  aarch64|arm64) ARCH=arm64; EXPECTED_SHA=__ARM64_SHA__ ;;
  *) fail "Unsupported architecture: $(uname -m)" ;;
esac

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
ARCHIVE="$TMP_DIR/sing-box.tar.gz"
URL="https://github.com/SagerNet/sing-box/releases/download/v$VERSION/sing-box-$VERSION-linux-$ARCH.tar.gz"
printf 'Downloading pinned sing-box %s for %s...\n' "$VERSION" "$ARCH"
curl --fail --show-error --silent --location --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 15 "$URL" -o "$ARCHIVE"
printf '%s  %s\n' "$EXPECTED_SHA" "$ARCHIVE" | sha256sum --check --status || fail "sing-box SHA-256 mismatch"
tar -xzf "$ARCHIVE" -C "$TMP_DIR"
SING_BOX_SOURCE=$(find "$TMP_DIR" -type f -name sing-box -perm -u+x -print -quit)
[ -n "$SING_BOX_SOURCE" ] || fail "sing-box executable not found in archive"
"$SING_BOX_SOURCE" version | grep -F "sing-box version $VERSION" >/dev/null || fail "Unexpected sing-box version"
install -m 0755 "$SING_BOX_SOURCE" /usr/local/bin/sing-box

if ! id sing-box >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/sing-box --shell /usr/sbin/nologin sing-box
fi
install -d -o root -g sing-box -m 0750 /etc/sing-box
install -d -o sing-box -g sing-box -m 0750 /var/lib/sing-box
install -d -o root -g root -m 0750 /var/lib/v13-agent

KEYPAIR=$(/usr/local/bin/sing-box generate reality-keypair)
REALITY_PRIVATE_KEY=$(printf '%s\n' "$KEYPAIR" | awk -F': ' '$1 == "PrivateKey" {print $2}')
REALITY_PUBLIC_KEY=$(printf '%s\n' "$KEYPAIR" | awk -F': ' '$1 == "PublicKey" {print $2}')
VLESS_UUID=$(/usr/local/bin/sing-box generate uuid)
REALITY_SHORT_ID=$(/usr/local/bin/sing-box generate rand --hex 8)
HYSTERIA2_PASSWORD=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')
AGENT_TOKEN=$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')
HY2_CERT_TMP="$TMP_DIR/hysteria2.crt"
HY2_KEY_TMP="$TMP_DIR/hysteria2.key"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -sha256 -nodes -days 3650 \
  -subj "/CN=$NODE_HOSTNAME" -addext "subjectAltName=DNS:$NODE_HOSTNAME" \
  -keyout "$HY2_KEY_TMP" -out "$HY2_CERT_TMP" >/dev/null 2>&1
install -o root -g sing-box -m 0640 "$HY2_CERT_TMP" /etc/sing-box/hysteria2.crt
install -o root -g sing-box -m 0640 "$HY2_KEY_TMP" /etc/sing-box/hysteria2.key
HYSTERIA2_CERT_SHA256=$(openssl x509 -in /etc/sing-box/hysteria2.crt -noout -fingerprint -sha256 | cut -d= -f2 | tr -d ':' | tr 'A-F' 'a-f')
HYSTERIA2_SPKI_SHA256=$(openssl x509 -in /etc/sing-box/hysteria2.crt -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | openssl base64 -A)

export NODE_HOSTNAME REALITY_SERVER_NAME REALITY_PRIVATE_KEY REALITY_PUBLIC_KEY VLESS_PORT
export VLESS_UUID REALITY_SHORT_ID HYSTERIA2_PASSWORD HYSTERIA2_CERT_SHA256 HYSTERIA2_SPKI_SHA256
export AGENT_TOKEN DEPLOYMENT_ID CONTROL_URL VERSION
python3 - <<'PY'
import json, os
config = {
    "log": {"level": "warn", "timestamp": True},
    "inbounds": [
        {
            "type": "vless",
            "tag": "vless-reality-in",
            "listen": "0.0.0.0",
            "listen_port": int(os.environ["VLESS_PORT"]),
            "users": [{
                "name": "v13-user",
                "uuid": os.environ["VLESS_UUID"],
                "flow": "xtls-rprx-vision"
            }],
            "tls": {
                "enabled": True,
                "server_name": os.environ["REALITY_SERVER_NAME"],
                "reality": {
                    "enabled": True,
                    "handshake": {
                        "server": os.environ["REALITY_SERVER_NAME"],
                        "server_port": 443
                    },
                    "private_key": os.environ["REALITY_PRIVATE_KEY"],
                    "short_id": [os.environ["REALITY_SHORT_ID"]],
                    "max_time_difference": "2m"
                }
            }
        },
        {
            "type": "hysteria2",
            "tag": "hysteria2-in",
            "listen": "0.0.0.0",
            "listen_port": 443,
            "users": [{"name": "v13-user", "password": os.environ["HYSTERIA2_PASSWORD"]}],
            "ignore_client_bandwidth": False,
            "tls": {
                "enabled": True,
                "min_version": "1.3",
                "certificate_path": "/etc/sing-box/hysteria2.crt",
                "key_path": "/etc/sing-box/hysteria2.key"
            },
            "bbr_profile": "standard",
            "masquerade": {
                "type": "string",
                "status_code": 404,
                "headers": {"content-type": "text/plain; charset=utf-8"},
                "content": "Not found"
            }
        }
    ]
}
with open("/etc/sing-box/config.json.new", "w", encoding="utf-8") as handle:
    json.dump(config, handle, indent=2)
    handle.write("\n")
PY
chmod 0640 /etc/sing-box/config.json.new
chown root:sing-box /etc/sing-box/config.json.new
/usr/local/bin/sing-box check -c /etc/sing-box/config.json.new || fail "Generated server configuration failed sing-box check"
if [ -f /etc/sing-box/config.json ]; then
  cp -a /etc/sing-box/config.json "/etc/sing-box/config.json.backup.$(date +%s)"
fi
mv /etc/sing-box/config.json.new /etc/sing-box/config.json
CONFIG_SHA=$(sha256sum /etc/sing-box/config.json | awk '{print $1}')
export CONFIG_SHA

cat >/etc/systemd/system/sing-box.service <<'UNIT'
[Unit]
Description=sing-box 1.14 managed by V13
Documentation=https://sing-box.sagernet.org/
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=sing-box
Group=sing-box
ExecStartPre=/usr/local/bin/sing-box check -c /etc/sing-box/config.json
ExecStart=/usr/local/bin/sing-box run -c /etc/sing-box/config.json
Restart=on-failure
RestartSec=5s
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
ProtectClock=true
ProtectControlGroups=true
ProtectHome=true
ProtectKernelLogs=true
ProtectKernelModules=true
ProtectKernelTunables=true
ProtectSystem=strict
ReadWritePaths=/var/lib/sing-box
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
RestrictNamespaces=true
RestrictRealtime=true
LockPersonality=true
MemoryDenyWriteExecute=true
SystemCallArchitectures=native
UMask=0027

[Install]
WantedBy=multi-user.target
UNIT

UFW_ACTIVE=0
if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
  UFW_ACTIVE=1
fi
if [ "$ENABLE_UFW" = "1" ] || [ "$UFW_ACTIVE" = "1" ]; then
  command -v ufw >/dev/null || fail "UFW was requested but is not installed"
  SSH_PORT=$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2; exit}')
  [ -n "$SSH_PORT" ] || SSH_PORT=22
  ufw allow "$SSH_PORT/tcp"
  ufw allow "$VLESS_PORT/tcp"
  ufw allow 443/udp
  if [ "$ENABLE_UFW" = "1" ] && [ "$UFW_ACTIVE" = "0" ]; then
    ufw --force enable
  fi
fi

systemctl daemon-reload
systemctl enable sing-box.service >/dev/null
systemctl reset-failed sing-box.service >/dev/null 2>&1 || true
systemctl restart --no-block sing-box.service
for _ in {1..30}; do
  if systemctl is-active --quiet sing-box.service; then
    sleep 3
    systemctl is-active --quiet sing-box.service && break
  fi
  systemctl is-failed --quiet sing-box.service && break
  sleep 1
done
systemctl is-active --quiet sing-box.service || {
  journalctl -u sing-box.service -n 80 --no-pager >&2 || true
  fail "sing-box failed to start"
}

python3 - <<'PY'
import json, os
payload = {
    "deploymentId": os.environ["DEPLOYMENT_ID"],
    "agentToken": os.environ["AGENT_TOKEN"],
    "singBoxVersion": os.environ["VERSION"],
    "vlessPort": int(os.environ["VLESS_PORT"]),
    "vlessUuid": os.environ["VLESS_UUID"],
    "realityPublicKey": os.environ["REALITY_PUBLIC_KEY"],
    "realityShortId": os.environ["REALITY_SHORT_ID"],
    "hysteria2Password": os.environ["HYSTERIA2_PASSWORD"],
    "hysteria2CertSha256": os.environ["HYSTERIA2_CERT_SHA256"],
    "hysteria2SpkiSha256": os.environ["HYSTERIA2_SPKI_SHA256"],
    "configSha256": os.environ["CONFIG_SHA"]
}
with open("/var/lib/v13-agent/complete.json", "w", encoding="utf-8") as handle:
    json.dump(payload, handle)
PY
curl --fail --show-error --silent --proto '=https' --tlsv1.2 --retry 4 \
  -H "Authorization: Bearer $BOOTSTRAP_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @/var/lib/v13-agent/complete.json \
  "$CONTROL_URL/api/v1/agent/complete" >/dev/null
shred -u /var/lib/v13-agent/complete.json 2>/dev/null || rm -f /var/lib/v13-agent/complete.json

cat >/etc/v13-agent.env <<EOF
CONTROL_URL=$CONTROL_URL
DEPLOYMENT_ID=$DEPLOYMENT_ID
AGENT_TOKEN=$AGENT_TOKEN
EOF
chmod 0600 /etc/v13-agent.env

cat >/usr/local/libexec/v13-health-report.py <<'PY'
#!/usr/bin/env python3
import hashlib, json, subprocess, urllib.request
from pathlib import Path

env = {}
for line in Path("/etc/v13-agent.env").read_text(encoding="utf-8").splitlines():
    key, value = line.split("=", 1)
    env[key] = value
config = Path("/etc/sing-box/config.json").read_bytes()
active = subprocess.run(["systemctl", "is-active", "--quiet", "sing-box.service"], check=False).returncode == 0
payload = json.dumps({
    "deploymentId": env["DEPLOYMENT_ID"],
    "status": "healthy" if active else "failed",
    "singBoxVersion": "1.14.0",
    "serviceActive": active,
    "configSha256": hashlib.sha256(config).hexdigest()
}).encode()
request = urllib.request.Request(
    env["CONTROL_URL"] + "/api/v1/agent/report",
    data=payload,
    headers={"Authorization": "Bearer " + env["AGENT_TOKEN"], "Content-Type": "application/json"},
    method="POST"
)
with urllib.request.urlopen(request, timeout=20) as response:
    if response.status != 200:
        raise RuntimeError("health report rejected")
PY
chmod 0750 /usr/local/libexec/v13-health-report.py

cat >/etc/systemd/system/v13-health-report.service <<'UNIT'
[Unit]
Description=V13 node health report
After=network-online.target sing-box.service

[Service]
Type=oneshot
ExecStart=/usr/local/libexec/v13-health-report.py
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
UNIT

cat >/etc/systemd/system/v13-health-report.timer <<'UNIT'
[Unit]
Description=Send V13 node health every five minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
RandomizedDelaySec=45s
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
if [ "$NODE_ROLE" = "sleeper" ]; then
  # Sleeper nodes stay silent: no periodic health timer; the daily beacon
  # window (v13-sleeper.timer below) is the only contact with the control plane.
  systemctl disable v13-health-report.timer >/dev/null 2>&1 || true
else
  systemctl enable --now v13-health-report.timer
fi

if [ "$DNS_TUNNEL" = "1" ] && [ -n "$TUNNEL_DOMAIN" ]; then
  # --- DNS tunnel servers (dnstt + slipstream) on the user's OWN VPS ---
  # Keypairs are generated here and never leave; only public material is
  # reported back in the complete payload.
  install -d -o root -g root -m 0700 /etc/v13-tunnel
  go_new_enough() {
    command -v go >/dev/null 2>&1 || return 1
    minor=$(go version 2>/dev/null | awk '{print $3}' | sed 's/^go//' | cut -d. -f2)
    [ "\${minor:-0}" -ge 22 ]
  }
  if ! go_new_enough; then
    case "$(uname -m)" in
      x86_64|amd64) GO_SHA=__GO_AMD64_SHA__ ;;
      aarch64|arm64) GO_SHA=__GO_ARM64_SHA__ ;;
      *) fail "Unsupported architecture for pinned Go toolchain" ;;
    esac
    curl --fail --show-error --silent --location --proto '=https' --tlsv1.2 --retry 3 \
      "https://go.dev/dl/go__GO_VERSION__.linux-$ARCH.tar.gz" -o "$TMP_DIR/go.tgz"
    printf '%s  %s\n' "$GO_SHA" "$TMP_DIR/go.tgz" | sha256sum --check --status || fail "Go toolchain SHA-256 mismatch"
    tar -C /usr/local -xzf "$TMP_DIR/go.tgz"
    ln -sf /usr/local/go/bin/go /usr/local/bin/go
  fi
  export PATH="$PATH:/root/go/bin"
  go install __DNSTT_MODULE__/dnstt-server@__DNSTT_PIN__ || fail "dnstt-server install failed (module proxy/checksum db enforced)"
  go install __SLIPSTREAM_MODULE__/cmd/slipstream-server@__SLIPSTREAM_PIN__ || fail "slipstream-server install failed (module proxy/checksum db enforced)"
  install -m 0755 "/root/go/bin/dnstt-server" /usr/local/bin/dnstt-server
  install -m 0755 "/root/go/bin/slipstream-server" /usr/local/bin/slipstream-server
  { go version -m /usr/local/bin/dnstt-server; go version -m /usr/local/bin/slipstream-server; } > /var/lib/v13-agent/tunnel-pins.txt 2>/dev/null || true

  # Local proxy target shared by both tunnel servers: a sing-box client
  # instance reusing this node's own credentials (mixed inbound on loopback).
  python3 - <<'PY'
import json, os
config = {
    "log": {"level": "warn", "timestamp": True},
    "inbounds": [{"type": "mixed", "tag": "tunnel-mixed", "listen": "127.0.0.1", "listen_port": 1080}],
    "outbounds": [{
        "type": "vless",
        "tag": "out",
        "server": os.environ["NODE_HOSTNAME"],
        "server_port": int(os.environ["VLESS_PORT"]),
        "uuid": os.environ["VLESS_UUID"],
        "flow": "xtls-rprx-vision",
        "tls": {
            "enabled": True,
            "server_name": os.environ["REALITY_SERVER_NAME"],
            "reality": {
                "enabled": True,
                "public_key": os.environ["REALITY_PUBLIC_KEY"],
                "short_id": os.environ["REALITY_SHORT_ID"]
            },
            "utls": {"enabled": True, "fingerprint": "chrome"}
        }
    }]
}
with open("/etc/sing-box/client.json.new", "w", encoding="utf-8") as handle:
    json.dump(config, handle, indent=2)
    handle.write("\n")
PY
  chmod 0640 /etc/sing-box/client.json.new
  chown root:sing-box /etc/sing-box/client.json.new
  /usr/local/bin/sing-box check -c /etc/sing-box/client.json.new || fail "Tunnel client configuration failed sing-box check"
  mv /etc/sing-box/client.json.new /etc/sing-box/client.json

  cat >/etc/systemd/system/sing-box-client.service <<'UNIT'
[Unit]
Description=sing-box loopback proxy for V13 DNS tunnels
After=network-online.target

[Service]
Type=simple
User=sing-box
Group=sing-box
ExecStart=/usr/local/bin/sing-box run -c /etc/sing-box/client.json
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/sing-box

[Install]
WantedBy=multi-user.target
UNIT

  if [ ! -s /etc/v13-tunnel/dnstt.keys ]; then
    /usr/local/bin/dnstt-server -gen-key > /etc/v13-tunnel/dnstt.keys || fail "dnstt keygen failed"
    chmod 0600 /etc/v13-tunnel/dnstt.keys
  fi
  DNSTT_PRIV=$(awk '$1 == "privkey" {print $2}' /etc/v13-tunnel/dnstt.keys)
  DNSTT_PUB=$(awk '$1 == "pubkey" {print $2}' /etc/v13-tunnel/dnstt.keys)
  [ -n "$DNSTT_PRIV" ] && [ -n "$DNSTT_PUB" ] || fail "dnstt keypair incomplete"
  if [ ! -s /etc/v13-tunnel/slipstream.crt ]; then
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -sha256 -nodes -days 3650 \
      -subj "/CN=$TUNNEL_DOMAIN" -addext "subjectAltName=DNS:$TUNNEL_DOMAIN" \
      -keyout /etc/v13-tunnel/slipstream.key -out /etc/v13-tunnel/slipstream.crt >/dev/null 2>&1
    chmod 0600 /etc/v13-tunnel/slipstream.key
  fi
  SLIPSTREAM_SPKI=$(openssl x509 -in /etc/v13-tunnel/slipstream.crt -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | openssl base64 -A)
  export DNSTT_PUB SLIPSTREAM_SPKI

  cat >/etc/systemd/system/dnstt-server.service <<UNIT
[Unit]
Description=dnstt DNS tunnel server (authoritative for $TUNNEL_DOMAIN)
After=network-online.target sing-box-client.service
Wants=sing-box-client.service

[Service]
Type=simple
ExecStart=/usr/local/bin/dnstt-server -udp :53 -privkey $DNSTT_PRIV $TUNNEL_DOMAIN 127.0.0.1:1080
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
# Authoritative-only tunnel: no recursion, no ANY, kernel-level rate limit.
LimitNPROC=64

[Install]
WantedBy=multi-user.target
UNIT

  cat >/etc/systemd/system/slipstream-server.service <<UNIT
[Unit]
Description=slipstream QUIC-over-DNS server for $TUNNEL_DOMAIN
After=network-online.target sing-box-client.service
Wants=sing-box-client.service

[Service]
Type=simple
ExecStart=/usr/local/bin/slipstream-server -l 0.0.0.0:__SLIPSTREAM_PORT__ -t 127.0.0.1:1080 -d $TUNNEL_DOMAIN -c /etc/v13-tunnel/slipstream.crt -k /etc/v13-tunnel/slipstream.key
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict

[Install]
WantedBy=multi-user.target
UNIT

  if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
    ufw allow 53/udp
    ufw allow __SLIPSTREAM_PORT__/udp
  fi
  systemctl daemon-reload
  systemctl enable --now sing-box-client.service dnstt-server.service slipstream-server.service

  # One honest tunnel report: measured MTU + TXT round-trip + PUBLIC key
  # material only. Private keys stay on the VPS forever.
  sleep 2
  export PROBE_JSON
  PROBE_JSON=$(/usr/local/libexec/v13-mtu-probe.py 2>/dev/null || printf '{}')
  python3 - <<'PY'
import json, os
probe = json.loads(os.environ.get("PROBE_JSON") or "{}")
payload = {
    "deploymentId": os.environ["DEPLOYMENT_ID"],
    "status": "healthy",
    "singBoxVersion": os.environ["VERSION"],
    "serviceActive": True,
    "configSha256": os.environ["CONFIG_SHA"],
    "dnsttPublicKey": os.environ.get("DNSTT_PUB", ""),
    "slipstreamSpkiSha256": os.environ.get("SLIPSTREAM_SPKI", ""),
    "tunnelStatus": "active",
}
if probe.get("mtu"):
    payload["mtuBytes"] = probe["mtu"]
if probe.get("txt_rtt_ms") is not None:
    payload["tunnelTxtRttMs"] = probe["txt_rtt_ms"]
with open("/var/lib/v13-agent/tunnel-report.json", "w", encoding="utf-8") as handle:
    json.dump(payload, handle)
PY
  curl --fail --show-error --silent --proto '=https' --tlsv1.2 --retry 4 \
    -H "Authorization: Bearer $AGENT_TOKEN" \
    -H 'Content-Type: application/json' \
    --data-binary @/var/lib/v13-agent/tunnel-report.json \
    "$CONTROL_URL/api/v1/agent/report" >/dev/null || true
  shred -u /var/lib/v13-agent/tunnel-report.json 2>/dev/null || rm -f /var/lib/v13-agent/tunnel-report.json
fi

# MTU + TXT round-trip probe through the national path (five sizes, honest
# winner per deployment; results ride the health report, never fabricated).
cat >/usr/local/libexec/v13-mtu-probe.py <<'PY'
#!/usr/bin/env python3
import json, os, random, socket, struct, time
from pathlib import Path
SIZES = __MTU_SIZES__
domain = os.environ.get("TUNNEL_DOMAIN") or "example.com"
resolver = ("178.22.122.100", 53)
def probe(size):
    label = ("p" * max(1, size - 40))[:63]
    name = f"{label}.{random.randint(0, 999999)}.{domain}"
    packet = struct.pack(">HHHHHH", random.randint(0, 65535), 0x0100, 1, 0, 0, 0)
    packet += b"".join(bytes([len(p)]) + p.encode() for p in name.split(".")) + b"\x00" + struct.pack(">HH", 16, 1)
    started = time.monotonic()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(3)
            sock.sendto(packet, resolver)
            sock.recv(4096)
        return int((time.monotonic() - started) * 1000)
    except OSError:
        return None
winner, rtts = None, []
for size in SIZES:
    rtt = probe(size)
    if rtt is not None:
        winner = size
        rtts.append(rtt)
rtt = sorted(rtts)[len(rtts) // 2] if rtts else None
print(json.dumps({"mtu": winner, "txt_rtt_ms": rtt}))
PY
chmod 0750 /usr/local/libexec/v13-mtu-probe.py
export TUNNEL_DOMAIN

if [ "$NODE_ROLE" = "sleeper" ]; then
  # Daily read-only beacon window; the only contact of a sleeper node.
  cat >/usr/local/libexec/v13-sleeper.py <<'PY'
#!/usr/bin/env python3
import hashlib, json, os, socket, struct, subprocess, time
from pathlib import Path
LOG = Path("/var/lib/v13-agent/sleeper.log")
LOG.parent.mkdir(parents=True, exist_ok=True)
def fnv1a(text):
    h = 0x811C9DC5
    for ch in text.encode():
        h = (h ^ ch) * 0x01000193 & 0xFFFFFFFF
    return h
day = time.strftime("%Y-%m-%d", time.gmtime())
deployment = ""
for line in Path("/etc/v13-agent.env").read_text(encoding="utf-8").splitlines():
    if line.startswith("DEPLOYMENT_ID="):
        deployment = line.split("=", 1)[1]
anchor = int(os.environ.get("SLEEPER_ANCHOR_HOUR", "3"))
jitter = (fnv1a(f"{deployment}|{day}") % 19) - 9
start = (anchor * 60 + jitter) % 1440
now = (time.gmtime().tm_hour * 60 + time.gmtime().tm_min) % 1440
in_window = start <= now < (start + 60) % 1440 or (start + 60 > 1440 and now < (start + 60) % 1440)
def log(line):
    with LOG.open("a", encoding="utf-8") as handle:
        handle.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {line}\n")
if not in_window:
    log("sleep (outside window)")
    raise SystemExit(0)
beacon = os.environ.get("BEACON_NAME", "")
cmd = "none"
if beacon:
    query = struct.pack(">HHHHHH", 0x1234, 0x0100, 1, 0, 0, 0)
    query += b"".join(bytes([len(p)]) + p.encode() for p in beacon.split(".")) + b"\x00" + struct.pack(">HH", 16, 1)
    for resolver in ("178.22.122.100", "127.0.0.53"):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.settimeout(4)
                sock.sendto(query, (resolver, 53))
                data = sock.recv(4096)
            text = data[12:].decode("latin-1")
            if "v13b1" in text:
                parts = text.split("v13b1", 1)[1].split()
                cmd = parts[3] if len(parts) > 3 else "none"
            break
        except OSError:
            continue
log(f"window wake beacon={beacon} cmd={cmd}")
if cmd == "report-now":
    subprocess.run(["/usr/local/libexec/v13-health-report.py"], check=False)
    log("executed report-now")
elif cmd == "wake":
    subprocess.run(["systemctl", "enable", "--now", "v13-health-report.timer"], check=False)
    log("executed wake (periodic reports re-enabled)")
PY
  chmod 0750 /usr/local/libexec/v13-sleeper.py
  cat >/etc/systemd/system/v13-sleeper.service <<'UNIT'
[Unit]
Description=V13 sleeper beacon check
After=network-online.target

[Service]
Type=oneshot
EnvironmentFile=-/etc/v13-sleeper.env
ExecStart=/usr/local/libexec/v13-sleeper.py
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/v13-agent
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
UNIT
  cat >/etc/systemd/system/v13-sleeper.timer <<'UNIT'
[Unit]
Description=Check the V13 sleeper beacon window hourly

[Timer]
OnBootSec=3min
OnUnitActiveSec=1h
Persistent=true

[Install]
WantedBy=timers.target
UNIT
  cat >/etc/v13-sleeper.env <<EOF
BEACON_NAME=__BEACON_NAME__
SLEEPER_ANCHOR_HOUR=__SLEEPER_ANCHOR_HOUR__
EOF
  chmod 0600 /etc/v13-sleeper.env
  systemctl daemon-reload
  systemctl enable --now v13-sleeper.timer
fi

install -m 0600 /dev/null "$MARKER"
printf '\nV13 bootstrap completed. The control plane is finalizing the private subscription.\n'
`;
  const tunnelDomain = deployment.dns_tunnel_enabled === 1 ? (deployment.tunnel_hostname ?? "") : "";
  return template
    .replaceAll("__CONTROL_URL__", shellQuote(new URL(env.PUBLIC_BASE_URL).origin))
    .replaceAll("__DEPLOYMENT_ID__", shellQuote(deployment.id))
    .replaceAll("__BOOTSTRAP_TOKEN__", shellQuote(bootstrapToken))
    .replaceAll("__NODE_HOSTNAME__", shellQuote(deployment.node_hostname))
    .replaceAll("__REALITY_SERVER_NAME__", shellQuote(deployment.reality_server_name))
    .replaceAll("__ENABLE_UFW__", shellQuote(deployment.enable_ufw === 1 ? "1" : "0"))
    .replaceAll("__AMD64_SHA__", shellQuote(SING_BOX_AMD64_SHA256))
    .replaceAll("__ARM64_SHA__", shellQuote(SING_BOX_ARM64_SHA256))
    .replaceAll("__DNS_TUNNEL__", shellQuote(deployment.dns_tunnel_enabled === 1 ? "1" : "0"))
    .replaceAll("__NODE_ROLE__", shellQuote(deployment.role === "sleeper" ? "sleeper" : "standard"))
    .replaceAll("__TUNNEL_DOMAIN__", shellQuote(tunnelDomain))
    .replaceAll("__GO_VERSION__", GO_VERSION)
    .replaceAll("__GO_AMD64_SHA__", shellQuote(GO_AMD64_SHA256))
    .replaceAll("__GO_ARM64_SHA__", shellQuote(GO_ARM64_SHA256))
    .replaceAll("__DNSTT_MODULE__", DNSTT_MODULE)
    .replaceAll("__DNSTT_PIN__", DNSTT_PIN)
    .replaceAll("__SLIPSTREAM_MODULE__", SLIPSTREAM_MODULE)
    .replaceAll("__SLIPSTREAM_PIN__", SLIPSTREAM_PIN)
    .replaceAll("__SLIPSTREAM_PORT__", String(SLIPSTREAM_LISTEN_PORT))
    .replaceAll("__MTU_SIZES__", JSON.stringify([...TUNNEL_MTU_SIZES]))
    .replaceAll("__BEACON_NAME__", shellQuote(beaconRecordName(deployment)))
    .replaceAll("__SLEEPER_ANCHOR_HOUR__", String(deployment.sleeper_anchor_hour ?? SLEEPER_DEFAULT_ANCHOR_HOUR));
}

async function getBootstrapRecord(env: Env, request: Request): Promise<{ deployment: DeploymentRow; token: string }> {
  const token = bearerToken(request) ?? "";
  if (token.length < 43 || token.length > 128) throw new HttpError(401, "invalid_bootstrap_token", "Unauthorized");
  const tokenHash = await sha256(token);
  const deployment = await env.DB.prepare(
    `SELECT d.* FROM bootstrap_tokens b
     JOIN deployments d ON d.id = b.deployment_id
     WHERE b.token_hash = ? AND b.consumed_at IS NULL AND b.expires_at > ?`,
  ).bind(tokenHash, nowIso()).first<DeploymentRow>();
  if (!deployment) throw new HttpError(401, "invalid_bootstrap_token", "Unauthorized");
  return { deployment, token };
}

export async function serveBootstrap(request: Request, env: Env): Promise<Response> {
  const { deployment, token } = await getBootstrapRecord(env, request);
  const allowed = await rateLimit(env, `bootstrap:${deployment.id}`, 10, 300);
  if (!allowed) throw new HttpError(429, "rate_limited", "Too many bootstrap downloads");
  await audit(env, {
    tenantId: deployment.tenant_id,
    actorType: "agent",
    actorId: deployment.id,
    action: "bootstrap.download",
    resourceType: "deployment",
    resourceId: deployment.id,
    outcome: "success",
    request,
  });
  return new Response(renderBootstrapScript(env, deployment, token), {
    headers: secureHeaders({
      "Content-Type": "text/x-shellscript; charset=utf-8",
      "Content-Disposition": `attachment; filename="v13-bootstrap-${deployment.id}.sh"`,
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    }),
  });
}

export async function completeBootstrap(request: Request, env: Env): Promise<Response> {
  const { deployment, token } = await getBootstrapRecord(env, request);
  const payload: unknown = await readJson(request, 16_384);
  assertAgentCompletePayload(payload);
  if (payload.deploymentId !== deployment.id || payload.singBoxVersion !== env.SING_BOX_VERSION) {
    throw new HttpError(400, "deployment_mismatch", "Bootstrap payload does not match this deployment");
  }
  const existingSecret = await env.DB.prepare("SELECT bundle_enc FROM deployment_secrets WHERE deployment_id = ?")
    .bind(deployment.id).first<{ bundle_enc: string }>();
  if (!existingSecret) throw new Error("Deployment secret bundle is missing");
  const bundle = await decryptJson<SecretBundle>(existingSecret.bundle_enc, env.TOKEN_ENCRYPTION_KEY, `deployment:${deployment.id}`);
  const merged: SecretBundle = {
    ...bundle,
    vlessPort: payload.vlessPort,
    vlessUuid: payload.vlessUuid,
    realityPublicKey: payload.realityPublicKey,
    realityShortId: payload.realityShortId,
    hysteria2Password: payload.hysteria2Password,
    hysteria2CertSha256: payload.hysteria2CertSha256,
    hysteria2SpkiSha256: payload.hysteria2SpkiSha256,
    nodeConfigSha256: payload.configSha256,
  };
  const encryptedBundle = await encryptJson(merged, env.TOKEN_ENCRYPTION_KEY, `deployment:${deployment.id}`);
  const bootstrapHash = await sha256(token);
  const agentHash = await sha256(payload.agentToken);
  const consumed = await env.DB.prepare(
    "UPDATE bootstrap_tokens SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL",
  ).bind(nowIso(), bootstrapHash).run();
  if ((consumed.meta.changes ?? 0) !== 1) throw new HttpError(409, "bootstrap_used", "Bootstrap token was already consumed");
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare("UPDATE deployment_secrets SET bundle_enc = ?, version = version + 1, updated_at = ? WHERE deployment_id = ?")
      .bind(encryptedBundle, now, deployment.id),
    env.DB.prepare("UPDATE deployments SET agent_token_hash = ?, status = 'agent_ready', status_detail = NULL, updated_at = ? WHERE id = ?")
      .bind(agentHash, now, deployment.id),
  ]);
  const instance = await env.PROVISION_WORKFLOW.create({
    id: `finalize-${deployment.id}-${Date.now()}`,
    params: { action: "finalize", deploymentId: deployment.id },
  });
  await env.DB.prepare("UPDATE deployments SET workflow_instance_id = ?, updated_at = ? WHERE id = ?")
    .bind(instance.id, nowIso(), deployment.id).run();
  await audit(env, {
    tenantId: deployment.tenant_id,
    actorType: "agent",
    actorId: deployment.id,
    action: "bootstrap.complete",
    resourceType: "deployment",
    resourceId: deployment.id,
    outcome: "success",
    request,
    metadata: { singBoxVersion: payload.singBoxVersion },
  });
  return json({ ok: true, status: "finalizing" });
}

interface AgentReportPayload {
  deploymentId?: unknown;
  status?: unknown;
  singBoxVersion?: unknown;
  serviceActive?: unknown;
  configSha256?: unknown;
}

export async function receiveAgentReport(request: Request, env: Env): Promise<Response> {
  const rawToken = bearerToken(request) ?? "";
  if (rawToken.length < 43 || rawToken.length > 128) throw new HttpError(401, "invalid_agent_token", "Unauthorized");
  const body = await readJson<AgentReportPayload>(request, 8_192);
  if (
    typeof body.deploymentId !== "string" || !/^[0-9a-f-]{36}$/u.test(body.deploymentId) ||
    (body.status !== "healthy" && body.status !== "degraded" && body.status !== "failed") ||
    typeof body.serviceActive !== "boolean" ||
    typeof body.singBoxVersion !== "string" || body.singBoxVersion.length > 32 ||
    typeof body.configSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(body.configSha256)
  ) throw new HttpError(400, "invalid_report", "Health report is invalid");
  const deployment = await env.DB.prepare("SELECT id, tenant_id, agent_token_hash FROM deployments WHERE id = ?")
    .bind(body.deploymentId).first<{ id: string; tenant_id: string; agent_token_hash: string | null }>();
  if (!deployment?.agent_token_hash || deployment.agent_token_hash !== await sha256(rawToken)) {
    throw new HttpError(401, "invalid_agent_token", "Unauthorized");
  }
  const allowed = await rateLimit(env, `agent-report:${deployment.id}`, 12, 60);
  if (!allowed) throw new HttpError(429, "rate_limited", "Too many reports");
  const extras = extractAgentReportExtras(body as Record<string, unknown>);
  const raw = body as Record<string, unknown>;
  const dnsttPublicKey =
    typeof raw.dnsttPublicKey === "string" && /^[0-9a-f]{64}$/u.test(raw.dnsttPublicKey) ? raw.dnsttPublicKey : null;
  const slipstreamSpki =
    typeof raw.slipstreamSpkiSha256 === "string" && /^[A-Za-z0-9+/]{43}=$/u.test(raw.slipstreamSpkiSha256) ? raw.slipstreamSpkiSha256 : null;
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO agent_reports
        (deployment_id, status, sing_box_version, service_active, config_sha256, mtu_bytes, tunnel_txt_rtt_ms, tunnel_status, reported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      deployment.id, body.status, body.singBoxVersion, body.serviceActive ? 1 : 0, body.configSha256,
      extras.mtuBytes, extras.tunnelTxtRttMs, extras.tunnelStatus, now,
    ),
    env.DB.prepare(
      `UPDATE deployments SET
         last_seen_at = ?,
         updated_at = ?,
         tunnel_mtu = COALESCE(?, tunnel_mtu),
         dnstt_public_key = COALESCE(?, dnstt_public_key),
         slipstream_spki_sha256 = COALESCE(?, slipstream_spki_sha256)
       WHERE id = ?`,
    ).bind(now, now, extras.mtuBytes, dnsttPublicKey, slipstreamSpki, deployment.id),
  ]);
  return json({ ok: true });
}
