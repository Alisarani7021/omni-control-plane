-- Kaveh tenant nodes provisioned by the control plane on the tenant's own
-- Cloudflare account. The agent key is encrypted exactly like connection
-- tokens: AES-256-GCM with a per-row AAD, scrubbed on delete.
CREATE TABLE IF NOT EXISTS kaveh_nodes (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  connection_id  TEXT NOT NULL,
  account_id     TEXT NOT NULL,
  worker_name    TEXT NOT NULL,
  d1_id          TEXT NOT NULL,
  base_url       TEXT NOT NULL,
  agent_key_enc  TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kaveh_nodes_tenant ON kaveh_nodes (tenant_id);
