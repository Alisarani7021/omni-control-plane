import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteDeployment, DELETABLE_DEPLOYMENT_STATUSES } from "../src/deployments";
import type { DeploymentRow, Env, SessionPrincipal } from "../src/types";

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
  status: "failed",
  status_detail: "agent_timeout",
  workflow_instance_id: null,
  subscription_token_hash: "hash",
  agent_token_hash: null,
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

function envFor(status: string): { env: Env; statements: Array<{ sql: string; values: unknown[] }> } {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const statement = (sql: string) => ({
    bind: (...values: unknown[]) => {
      const record = { sql, values };
      statements.push(record);
      return {
        first: async () => (sql.includes("SELECT * FROM deployments") ? { ...deployment, status } : null),
        run: async () => ({ success: true, meta: { changes: 1 } }),
      };
    },
  });
  return {
    env: {
      DB: { prepare: statement, batch: async (items: unknown[]) => items.map(() => ({ success: true, meta: { changes: 1 } })) },
    } as unknown as Env,
    statements,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("deployment record deletion", () => {
  it("only lets finished-or-broken records go", async () => {
    expect(DELETABLE_DEPLOYMENT_STATUSES).toEqual(["failed", "revoked"]);
    for (const status of ["ready", "queued", "preparing", "awaiting_agent", "finalizing", "revoking"]) {
      const { env: testEnv, statements } = envFor(status);
      await expect(deleteDeployment(testEnv, principal, deployment.id)).rejects.toMatchObject({
        status: 409,
        code: "deployment_not_deletable",
      });
      expect(statements).toHaveLength(1);
    }
  });

  it("clears the children it owns and audits the removal", async () => {
    const { env: testEnv, statements } = envFor("failed");
    const response = await deleteDeployment(testEnv, principal, deployment.id);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, deleted: deployment.id });

    const deleted = statements.map((item) => item.sql);
    expect(deleted).toContain("DELETE FROM agent_reports WHERE deployment_id = ?");
    expect(deleted).toContain("DELETE FROM bootstrap_tokens WHERE deployment_id = ?");
    expect(deleted).toContain("DELETE FROM deployment_secrets WHERE deployment_id = ?");
    const row = statements.find((item) => item.sql === "DELETE FROM deployments WHERE id = ? AND tenant_id = ?");
    expect(row?.values).toEqual([deployment.id, principal.tenantId]);
    expect(deleted.some((sql) => sql.includes("INSERT INTO audit_events"))).toBe(true);
  });

  it("refuses to touch another tenant's record", async () => {
    const { env: testEnv } = envFor("failed");
    const other = { ...principal, tenantId: "99999999-9999-4999-8999-999999999999" };
    testEnv.DB.prepare = () => ({
      bind: () => ({ first: async () => null, run: async () => ({ success: true, meta: { changes: 0 } }) }),
    }) as never;
    await expect(deleteDeployment(testEnv, other, deployment.id)).rejects.toMatchObject({ status: 404 });
  });
});
