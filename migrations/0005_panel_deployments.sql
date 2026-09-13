PRAGMA foreign_keys = ON;

-- Panel deploys from «🚀 دیپلوی پنل جدید». A third-party panel (BPB, Zeus, ناهان, …)
-- has no VPS, no ACME issue and no Reality config, so it cannot share the
-- `deployments` table without inventing values. One row per attempt, and the row
-- records which source bytes went out (host + sha256) instead of trusting a name.
CREATE TABLE panel_deployments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id TEXT REFERENCES oauth_connections(id),
  account_id TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  worker_domain TEXT NOT NULL,
  panel_key TEXT NOT NULL,
  panel_name TEXT NOT NULL,
  panel_path TEXT NOT NULL,
  panel_url TEXT NOT NULL,
  source_host TEXT NOT NULL DEFAULT '',
  source_sha256 TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('provisioning', 'live', 'verifying', 'failed')),
  detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, worker_name)
);
CREATE INDEX idx_panel_deployments_tenant ON panel_deployments(tenant_id, created_at DESC);
