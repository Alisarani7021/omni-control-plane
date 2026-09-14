import { afterEach, describe, expect, it, vi } from "vitest";
import { rotateSubscriptionToken } from "../src/deployments";
import { bytesToBase64Url, encryptJson, sha256 } from "../src/security";
import type { ConnectionRow, DeploymentRow, Env, SecretBundle, SessionPrincipal } from "../src/types";

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
  status: "ready",
  status_detail: null,
  workflow_instance_id: null,
  subscription_token_hash: "old-hash",
  agent_token_hash: "agent-hash",
  last_seen_at: null,
  created_at: "2026-09-10T00:00:00.000Z",
  updated_at: "2026-09-10T00:00:00.000Z",
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

const principal: SessionPrincipal = {
  tenantId: deployment.tenant_id,
  telegramUserId: "123456789",
  displayName: "Test User",
  isAdmin: false,
  sessionHash: "session-hash",
};

function encryptionKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

afterEach(() => vi.unstubAllGlobals());

describe("subscription credential rotation", () => {
  it("publishes a fresh hash, returns a fresh hidden credential, and scrubs temporary Cloudflare access", async () => {
    const key = encryptionKey();
    const cloudflareToken = "scoped-cloudflare-token-1234567890";
    const accessTokenEnc = await encryptJson(
      cloudflareToken,
      key,
      `cloudflare:${deployment.oauth_connection_id}:api-token`,
    );
    const connection: ConnectionRow = {
      id: deployment.oauth_connection_id,
      tenant_id: deployment.tenant_id,
      auth_type: "api_token",
      access_token_enc: accessTokenEnc,
      refresh_token_enc: null,
      expires_at: "2099-01-01T00:00:00.000Z",
      scopes: "scoped-api-token",
      cf_user_id: "token-id",
      cf_email: null,
      resource_account_id: deployment.account_id,
      resource_account_name: "Example Account",
      resource_zone_id: deployment.zone_id,
      resource_zone_name: "example.com",
      revoked_at: null,
      created_at: deployment.created_at,
      updated_at: deployment.updated_at,
    };
    const originalSecrets: SecretBundle = {
      subscriptionToken: "o".repeat(43),
      vlessPort: 8443,
      vlessUuid: "44444444-4444-4444-8444-444444444444",
      realityPublicKey: "reality-public-key",
      realityShortId: "0123456789abcdef",
      hysteria2Password: "h".repeat(43),
      hysteria2CertSha256: "c".repeat(64),
      hysteria2SpkiSha256: "spki-pin",
    };
    const bundleEnc = await encryptJson(originalSecrets, key, `deployment:${deployment.id}`);
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const DB = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => {
          const statement = { sql, values };
          statements.push(statement);
          return {
            first: async () => {
              if (sql.includes("SELECT * FROM deployments")) return deployment;
              if (sql.includes("SELECT * FROM oauth_connections")) return connection;
              if (sql.includes("SELECT bundle_enc")) return { bundle_enc: bundleEnc };
              if (sql.includes("SELECT COUNT(*) AS count")) return { count: 0 };
              return null;
            },
            run: async () => ({ success: true, meta: { changes: 1 } }),
          };
        },
      }),
      batch: async () => [],
    };
    const env = { DB, TOKEN_ENCRYPTION_KEY: key, PUBLIC_BASE_URL: "https://control.example.com" } as unknown as Env;
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ success: true, result: {} }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await rotateSubscriptionToken(
      new Request(`https://control.example.com/api/v1/deployments/${deployment.id}/subscription-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
      env,
      principal,
      deployment.id,
    );
    const result = await response.json<{ subscriptions: { uri: string } }>();
    const newToken = result.subscriptions.uri.split("/").at(-1) ?? "";

    expect(response.status).toBe(200);
    expect(newToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(newToken).not.toBe(originalSecrets.subscriptionToken);
    const upload = fetchMock.mock.calls[0];
    expect(upload).toBeDefined();
    if (!upload) throw new Error("Worker upload was not called");
    const body = (upload[1] as RequestInit).body as FormData;
    const metadata = JSON.parse(await (body.get("metadata") as Blob).text()) as {
      bindings: Array<{ name: string; text: string }>;
    };
    expect(metadata.bindings.find((binding) => binding.name === "SUB_TOKEN_HASH")?.text).toBe(await sha256(newToken));
    expect(JSON.stringify(statements)).not.toContain(newToken);
    expect(statements.some(({ sql }) => sql.includes("access_token_enc = 'erased'"))).toBe(true);
  });
});
