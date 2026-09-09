PRAGMA foreign_keys = ON;

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL UNIQUE,
  telegram_username TEXT,
  display_name TEXT NOT NULL,
  locale TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE telegram_updates (
  update_id INTEGER PRIMARY KEY,
  received_at TEXT NOT NULL
);

CREATE TABLE login_links (
  token_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_login_links_expiry ON login_links(expires_at);

CREATE TABLE sessions (
  session_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent_hash TEXT
);
CREATE INDEX idx_sessions_tenant ON sessions(tenant_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL REFERENCES sessions(session_hash) ON DELETE CASCADE,
  pkce_verifier_enc TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_oauth_states_expiry ON oauth_states(expires_at);

CREATE TABLE oauth_connections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'cloudflare' CHECK (provider = 'cloudflare'),
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT,
  expires_at TEXT,
  scopes TEXT,
  cf_user_id TEXT,
  cf_email TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_oauth_connections_tenant ON oauth_connections(tenant_id, revoked_at);

CREATE TABLE deployments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  oauth_connection_id TEXT NOT NULL REFERENCES oauth_connections(id),
  account_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  worker_hostname TEXT NOT NULL,
  node_hostname TEXT NOT NULL,
  vps_ipv4 TEXT NOT NULL,
  acme_email TEXT NOT NULL,
  reality_server_name TEXT NOT NULL,
  enable_ufw INTEGER NOT NULL DEFAULT 0 CHECK (enable_ufw IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('queued', 'preparing', 'awaiting_agent', 'agent_ready', 'finalizing', 'ready', 'revoking', 'failed', 'revoked')),
  status_detail TEXT,
  workflow_instance_id TEXT,
  subscription_token_hash TEXT NOT NULL,
  agent_token_hash TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, worker_name),
  UNIQUE (worker_hostname),
  UNIQUE (node_hostname)
);
CREATE INDEX idx_deployments_tenant ON deployments(tenant_id, created_at DESC);
CREATE INDEX idx_deployments_status ON deployments(status);

CREATE TABLE deployment_secrets (
  deployment_id TEXT PRIMARY KEY REFERENCES deployments(id) ON DELETE CASCADE,
  bundle_enc TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE bootstrap_tokens (
  token_hash TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL UNIQUE REFERENCES deployments(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_bootstrap_tokens_expiry ON bootstrap_tokens(expires_at);

CREATE TABLE agent_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded', 'failed')),
  sing_box_version TEXT,
  service_active INTEGER NOT NULL CHECK (service_active IN (0, 1)),
  config_sha256 TEXT,
  reported_at TEXT NOT NULL
);
CREATE INDEX idx_agent_reports_deployment ON agent_reports(deployment_id, reported_at DESC);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('telegram', 'user', 'agent', 'workflow', 'system')),
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
  ip_hash TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_tenant_time ON audit_events(tenant_id, created_at DESC);

CREATE TABLE rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  hits INTEGER NOT NULL
);
