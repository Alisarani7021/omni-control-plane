import { describe, expect, it } from "vitest";
import { buildReadyBundle } from "../src/profiles";
import type { DeploymentRow, SecretBundle } from "../src/types";

const deployment: DeploymentRow = {
  id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  oauth_connection_id: "33333333-3333-4333-8333-333333333333",
  account_id: "a".repeat(32),
  zone_id: "b".repeat(32),
  worker_name: "v13-demo",
  worker_hostname: "sub.example.com",
  node_hostname: "node.example.com",
  vps_ipv4: "203.0.113.10",
  acme_email: "admin@example.com",
  reality_server_name: "www.microsoft.com",
  enable_ufw: 0,
  status: "agent_ready",
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

const secrets: SecretBundle = {
  subscriptionToken: "s".repeat(43),
  vlessPort: 8443,
  vlessUuid: "bf000d23-0752-40b4-affe-68f7707a9661",
  realityPublicKey: "jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0",
  realityShortId: "0123456789abcdef",
  hysteria2Password: "A_secure-password_0123456789abcdef",
  hysteria2CertSha256: "a".repeat(64),
  hysteria2SpkiSha256: `${"A".repeat(43)}=`,
};

describe("profile generation", () => {
  it("generates only implemented protocols", () => {
    const bundle = buildReadyBundle(deployment, secrets);
    expect(bundle.uris).toHaveLength(2);
    expect(bundle.uris[0]).toContain("security=reality");
    expect(bundle.uris[1]).toContain("hysteria2://");
    expect(bundle.uris.join("\n")).not.toMatch(/tuic|wireguard|shadowtls/iu);
  });

  it("does not expose a Reality private key", () => {
    const serialized = JSON.stringify(buildReadyBundle(deployment, secrets));
    expect(serialized).not.toContain("private_key");
    expect(serialized).not.toContain("subscriptionToken");
  });

  it("pins the self-signed Hysteria2 certificate in URI and sing-box profile", () => {
    const bundle = buildReadyBundle(deployment, secrets);
    expect(bundle.uris[1]).toContain("insecure=1");
    expect(bundle.uris[1]).toContain("pinSHA256=");
    const hy2 = bundle.profiles.hysteria2 as {
      outbounds: Array<{ tls: { insecure: boolean; certificate_public_key_sha256: string[] } }>;
    };
    expect(hy2.outbounds[0]?.tls).toEqual(expect.objectContaining({
      insecure: true,
      certificate_public_key_sha256: [secrets.hysteria2SpkiSha256],
    }));
  });

  it("builds separate sing-box profiles with one real outbound each", () => {
    const bundle = buildReadyBundle(deployment, secrets);
    const vless = bundle.profiles.vless as { outbounds: Array<{ type: string; server_port: number }> };
    const hy2 = bundle.profiles.hysteria2 as { outbounds: Array<{ type: string }> };
    expect(vless.outbounds).toEqual([
      expect.objectContaining({ type: "vless", server_port: 8443 }),
      expect.objectContaining({ type: "direct" }),
    ]);
    expect(bundle.uris[0]).toContain(":8443?");
    expect(hy2.outbounds).toEqual([
      expect.objectContaining({ type: "hysteria2" }),
      expect.objectContaining({ type: "direct" }),
    ]);
  });
});

describe("net-intel routing policy", () => {
  const bundle = buildReadyBundle(deployment, secrets, {
    subscriptionToken: secrets.subscriptionToken,
    controlOrigin: "https://control.example.com",
  });

  it("routes national ranges and the DoH bootstrap direct", () => {
    const profile = bundle.profiles.vless as {
      dns: { servers: Array<{ tag: string }>; final: string };
      route: { rules: Array<Record<string, unknown>>; rule_set: Array<{ tag: string; url?: string }> };
    };
    expect(profile.dns.final).toBe("doh-own");
    expect(profile.dns.servers.map((server) => server.tag)).toContain("ir-direct");
    const urls = profile.route.rule_set.map((set) => set.url ?? "").join(" ");
    expect(urls).toContain("/api/v1/geoip-ir.json");
    expect(urls).toContain("/api/v1/race-direct.json");
    expect(JSON.stringify(profile.route.rules)).toContain("override_address");
  });

  it("pins the worker hostname without a hosts file", () => {
    const profile = bundle.profiles.vless as { route: { rules: Array<Record<string, unknown>> } };
    const pin = profile.route.rules.find((rule) => rule.domain === "sub.example.com");
    expect(pin).toBeDefined();
    expect(pin?.override_address).toBe("104.16.0.1");
  });

  it("emits three labelled sniff/fakedns states per protocol", () => {
    expect(Object.keys(bundle.profileVariants)).toEqual([
      "vless · sniff خاموش",
      "vless · fakedns روشن",
      "hysteria2 · sniff خاموش",
      "hysteria2 · fakedns روشن",
    ]);
  });

  it("ships a Clash YAML with hosts pinning and DIRECT national rules", () => {
    expect(bundle.clashYaml).toContain("hosts:");
    expect(bundle.clashYaml).toContain("sub.example.com: 104.16.0.1");
    expect(bundle.clashYaml).toContain("GEOIP,IR,DIRECT");
  });
});
