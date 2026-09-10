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
});
