import { describe, expect, it } from "vitest";
import { renderBootstrapScript } from "../src/agent";
import type { DeploymentRow, Env } from "../src/types";

const deployment: DeploymentRow = {
  id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  oauth_connection_id: "33333333-3333-4333-8333-333333333333",
  account_id: "a".repeat(32),
  zone_id: "b".repeat(32),
  worker_name: "v13-demo",
  worker_hostname: "sub.example.com",
  node_hostname: "node.example.com",
  vps_ipv4: "1.1.1.1",
  acme_email: "admin@example.com",
  reality_server_name: "www.microsoft.com",
  enable_ufw: 0,
  status: "awaiting_agent",
  status_detail: null,
  workflow_instance_id: null,
  subscription_token_hash: "hash",
  agent_token_hash: null,
  last_seen_at: null,
  created_at: "2026-09-09T00:00:00.000Z",
  updated_at: "2026-09-09T00:00:00.000Z",
  role: "standard",
  dns_tunnel_enabled: 0,
  tunnel_hostname: null,
  dnstt_public_key: null,
  slipstream_spki_sha256: null,
  tunnel_mtu: null,
  sleeper_anchor_hour: null,
  sleeper_consented_at: null,
  beacon_published_at: null,
};

const env = {
  PUBLIC_BASE_URL: "https://control.example.com",
} as unknown as Env;

describe("VPS bootstrap", () => {
  const script = renderBootstrapScript(env, deployment, "B".repeat(43));

  it("pins and verifies sing-box 1.14.0 artifacts", () => {
    expect(script).toContain("VERSION=1.14.0");
    expect(script).toContain("2375de6999f4f56ab46b4fc5ddf26a6aba1d3e61a0f4e7ddec2f4690457d5f63");
    expect(script).toContain("sha256sum --check --status");
  });

  it("checks configuration before replacing and starting the service", () => {
    expect(script).toContain("sing-box check -c /etc/sing-box/config.json.new");
    expect(script).toContain("ExecStartPre=/usr/local/bin/sing-box check");
    expect(script).toContain("systemctl restart --no-block sing-box.service");
    expect(script).toContain('systemctl is-active --quiet sing-box.service');
  });

  it("makes the protected config traversable by the service account", () => {
    expect(script).toContain("install -d -o root -g sing-box -m 0750 /etc/sing-box");
    expect(script).toContain("chmod 0640 /etc/sing-box/config.json.new");
    expect(script).toContain("chown root:sing-box /etc/sing-box/config.json.new");
  });

  it("allows the netlink family required for route monitoring", () => {
    expect(script).toContain("RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK");
  });

  it("keeps TCP 443 when free and falls back to TCP 8443 when occupied", () => {
    expect(script).toContain('VLESS_PORT=443');
    expect(script).toContain('VLESS_PORT=8443');
    expect(script).toContain('port_available tcp "$VLESS_PORT"');
    expect(script).toContain('"vlessPort": int(os.environ["VLESS_PORT"])');
    expect(script).toContain('ufw allow "$VLESS_PORT/tcp"');
  });

  it("uses a pinned self-signed Hysteria2 certificate without ACME listeners", () => {
    expect(script).toContain("openssl req -x509 -newkey ec");
    expect(script).toContain('"certificate_path": "/etc/sing-box/hysteria2.crt"');
    expect(script).toContain('"hysteria2CertSha256": os.environ["HYSTERIA2_CERT_SHA256"]');
    expect(script).toContain('"hysteria2SpkiSha256": os.environ["HYSTERIA2_SPKI_SHA256"]');
    expect(script).not.toContain('"type": "acme"');
  });

  it("opens the selected protocol ports when UFW is already active", () => {
    expect(script).toContain("ufw status | grep -q '^Status: active'");
    expect(script).toContain('if [ "$ENABLE_UFW" = "1" ] || [ "$UFW_ACTIVE" = "1" ]');
    expect(script).toContain('ufw allow "$VLESS_PORT/tcp"');
    expect(script).toContain("ufw allow 443/udp");
  });

  it("keeps the Reality private key on the VPS", () => {
    const callbackSection = script.slice(script.indexOf('payload = {'));
    expect(callbackSection).not.toContain('REALITY_PRIVATE_KEY');
    expect(callbackSection).toContain('REALITY_PUBLIC_KEY');
  });

  it("does not use an unreviewed curl-to-shell pipeline", () => {
    expect(script).not.toMatch(/curl[^\n]*\|\s*(?:sudo\s+)?(?:ba)?sh/u);
  });

  it("avoids SIGPIPE-prone Bootstrap pipelines", () => {
    expect(script).toContain("-perm -u+x -print -quit");
    expect(script).not.toContain("| head");
  });

});

describe("DNS tunnel + sleeper bootstrap units", () => {
  const tunnelDeployment: DeploymentRow = {
    ...deployment,
    dns_tunnel_enabled: 1,
    tunnel_hostname: "t.example.com",
    role: "sleeper",
    sleeper_anchor_hour: 3,
  };
  const tunnelScript = renderBootstrapScript(env, tunnelDeployment, "B".repeat(43));
  const standardScript = renderBootstrapScript(env, deployment, "B".repeat(43));

  it("installs dnstt and slipstream pinned through the Go module proxy", () => {
    expect(tunnelScript).toContain("go install www.bamsoftware.com/git/dnstt.git/dnstt-server@latest");
    expect(tunnelScript).toContain("go install github.com/getlantern/slipstream/cmd/slipstream-server@3e15c2d877b2a575a64ffc60da18123f6e6b259d");
    expect(tunnelScript).toContain('fail "Go toolchain SHA-256 mismatch"');
  });

  it("keeps tunnel private keys on the VPS and reports public material only", () => {
    expect(tunnelScript).toContain("dnstt-server -gen-key");
    expect(tunnelScript).toContain("chmod 0600 /etc/v13-tunnel/dnstt.keys");
    expect(tunnelScript).toContain('"dnsttPublicKey": os.environ.get("DNSTT_PUB", "")');
    expect(tunnelScript).not.toContain("dnstt.priv");
  });

  it("wires systemd units for both tunnel servers and the loopback proxy", () => {
    expect(tunnelScript).toContain("dnstt-server.service");
    expect(tunnelScript).toContain("slipstream-server.service");
    expect(tunnelScript).toContain("sing-box-client.service");
    expect(tunnelScript).toContain("-udp :53 -privkey");
  });

  it("flags tunnel provisioning per deployment via the header, guarded at runtime", () => {
    expect(standardScript).toContain("DNS_TUNNEL='0'");
    expect(tunnelScript).toContain("DNS_TUNNEL='1'");
    expect(tunnelScript).toContain('if [ "$DNS_TUNNEL" = "1" ] && [ -n "$TUNNEL_DOMAIN" ]; then');
    expect(tunnelScript).toContain("TUNNEL_DOMAIN='t.example.com'");
  });

  it("silences periodic reports for sleeper nodes via the role header and installs the beacon timer", () => {
    expect(standardScript).toContain("NODE_ROLE='standard'");
    expect(tunnelScript).toContain("NODE_ROLE='sleeper'");
    expect(tunnelScript).toContain('if [ "$NODE_ROLE" = "sleeper" ]; then');
    expect(tunnelScript).toContain("systemctl disable v13-health-report.timer");
    expect(tunnelScript).toContain("v13-sleeper.timer");
    expect(tunnelScript).toContain("/var/lib/v13-agent/sleeper.log");
  });

  it("measures MTU through five probe sizes on the national path", () => {
    expect(tunnelScript).toContain("SIZES = [512,768,1024,1180,1400]");
    expect(tunnelScript).toContain("v13-mtu-probe.py");
  });
});
