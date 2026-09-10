import { audit, rateLimit } from "./db";
import { bearerToken, HttpError, json, readJson, secureHeaders } from "./http";
import { decryptJson, encryptJson, nowIso, sha256 } from "./security";
import { assertAgentCompletePayload } from "./validation";
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
ACME_EMAIL=__ACME_EMAIL__
REALITY_SERVER_NAME=__REALITY_SERVER_NAME__
ENABLE_UFW=__ENABLE_UFW__
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
SING_BOX_SOURCE=$(find "$TMP_DIR" -type f -name sing-box -perm -u+x | head -n 1)
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
HYSTERIA2_PASSWORD=$(openssl rand -base64 36 | tr -d '=+/\n' | head -c 43)
AGENT_TOKEN=$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')

export NODE_HOSTNAME ACME_EMAIL REALITY_SERVER_NAME REALITY_PRIVATE_KEY REALITY_PUBLIC_KEY VLESS_PORT
export VLESS_UUID REALITY_SHORT_ID HYSTERIA2_PASSWORD AGENT_TOKEN DEPLOYMENT_ID CONTROL_URL VERSION
python3 - <<'PY'
import json, os
config = {
    "log": {"level": "warn", "timestamp": True},
    "certificate_providers": [{
        "type": "acme",
        "tag": "hy2-acme",
        "domain": [os.environ["NODE_HOSTNAME"]],
        "data_directory": "/var/lib/sing-box/acme",
        "default_server_name": os.environ["NODE_HOSTNAME"],
        "email": os.environ["ACME_EMAIL"],
        "provider": "letsencrypt",
        "key_type": "p256"
    }],
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
                "certificate_provider": "hy2-acme"
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

if [ "$ENABLE_UFW" = "1" ]; then
  command -v ufw >/dev/null || fail "UFW was requested but is not installed"
  SSH_PORT=$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2; exit}')
  [ -n "$SSH_PORT" ] || SSH_PORT=22
  ufw allow "$SSH_PORT/tcp"
  ufw allow 80/tcp
  ufw allow "$VLESS_PORT/tcp"
  ufw allow 443/udp
  ufw --force enable
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
systemctl enable --now v13-health-report.timer
install -m 0600 /dev/null "$MARKER"
printf '\nV13 bootstrap completed. The control plane is finalizing the private subscription.\n'
`;
  return template
    .replaceAll("__CONTROL_URL__", shellQuote(new URL(env.PUBLIC_BASE_URL).origin))
    .replaceAll("__DEPLOYMENT_ID__", shellQuote(deployment.id))
    .replaceAll("__BOOTSTRAP_TOKEN__", shellQuote(bootstrapToken))
    .replaceAll("__NODE_HOSTNAME__", shellQuote(deployment.node_hostname))
    .replaceAll("__ACME_EMAIL__", shellQuote(deployment.acme_email))
    .replaceAll("__REALITY_SERVER_NAME__", shellQuote(deployment.reality_server_name))
    .replaceAll("__ENABLE_UFW__", shellQuote(deployment.enable_ufw === 1 ? "1" : "0"))
    .replaceAll("__AMD64_SHA__", shellQuote(SING_BOX_AMD64_SHA256))
    .replaceAll("__ARM64_SHA__", shellQuote(SING_BOX_ARM64_SHA256));
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
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO agent_reports (deployment_id, status, sing_box_version, service_active, config_sha256, reported_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(deployment.id, body.status, body.singBoxVersion, body.serviceActive ? 1 : 0, body.configSha256, now),
    env.DB.prepare("UPDATE deployments SET last_seen_at = ?, updated_at = ? WHERE id = ?")
      .bind(now, now, deployment.id),
  ]);
  return json({ ok: true });
}
