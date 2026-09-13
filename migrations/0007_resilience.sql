-- Safety net: tenants whose earlier migration run missed a 0005/0005-duplicate
-- file end up with missing telemetry tables, which made ONE failing cron stage
-- kill the whole tick (DNS scan never advanced). Recreate every table and
-- index idempotently; existing data is untouched.
CREATE TABLE IF NOT EXISTS edge_probes (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  http_status INTEGER,
  latency_ms INTEGER,
  probed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edge_probes_deployment ON edge_probes(deployment_id, probed_at DESC);
CREATE INDEX IF NOT EXISTS idx_edge_probes_expiry ON edge_probes(expires_at);

CREATE TABLE IF NOT EXISTS dns_poison_reports (
  id TEXT PRIMARY KEY,
  isp TEXT NOT NULL,
  city TEXT NOT NULL,
  fake_count INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dns_poison_window ON dns_poison_reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dns_poison_expiry ON dns_poison_reports(expires_at);

CREATE TABLE IF NOT EXISTS mtu_reports (
  isp TEXT NOT NULL,
  city TEXT NOT NULL,
  mtu INTEGER NOT NULL CHECK (mtu BETWEEN 512 AND 1400),
  samples INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (isp, city)
);
CREATE INDEX IF NOT EXISTS idx_mtu_reports_expiry ON mtu_reports(expires_at);

CREATE TABLE IF NOT EXISTS race_reports (
  domain TEXT PRIMARY KEY,
  direct_ms INTEGER,
  tunnel_ms INTEGER,
  winner TEXT NOT NULL CHECK (winner IN ('direct', 'tunnel', 'tie')),
  samples INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_race_expiry ON race_reports(expires_at);

CREATE TABLE IF NOT EXISTS rir_ir_snapshots (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL UNIQUE,
  source_url TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  range_count INTEGER NOT NULL,
  added INTEGER NOT NULL,
  removed INTEGER NOT NULL,
  fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS geoip_ir_current (
  cidr TEXT PRIMARY KEY,
  family TEXT NOT NULL CHECK (family IN ('ipv4', 'ipv6')),
  first_seen_day TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sleeper_commands (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  command TEXT NOT NULL CHECK (command IN ('report-now', 'wake')),
  queued_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sleeper_commands_pending ON sleeper_commands(deployment_id, consumed_at, queued_at DESC);

CREATE TABLE IF NOT EXISTS panel_deployments (
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
CREATE INDEX IF NOT EXISTS idx_panel_deployments_tenant ON panel_deployments(tenant_id, created_at DESC);
