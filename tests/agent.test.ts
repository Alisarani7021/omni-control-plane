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
    expect(script).toContain('systemctl is-active --quiet sing-box.service');
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
