PRAGMA foreign_keys = ON;

-- V13.5 "net intel" release: network-mode classification, DNS poisoning
-- self-test, RIPE/IRNIC national ranges, measured MTU, domestic race and the
-- sleeper role. Every number here is a real report or a public registry
-- value; nothing is simulated.

-- 1) EDGE PROBES — the control plane (Cloudflare edge) fetches each ready
--    deployment's data-plane /healthz on the cron tick. This is the
--    "is my node reachable from outside" eye; the VPS agent stays the
--    "is the inside path alive" eye. Both feed src/net-mode.ts.
CREATE TABLE edge_probes (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  http_status INTEGER,
  latency_ms INTEGER,
  probed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_edge_probes_deployment ON edge_probes(deployment_id, probed_at DESC);
CREATE INDEX idx_edge_probes_expiry ON edge_probes(expires_at);

-- 2) DNS POISONING SELF-TEST — crowd-submitted resolver answers for canary
--    names. The server only classifies (blackhole ranges), never invents.
CREATE TABLE dns_poison_reports (
  id TEXT PRIMARY KEY,
  isp TEXT NOT NULL,
  city TEXT NOT NULL,
  fake_count INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_dns_poison_window ON dns_poison_reports(created_at DESC);
CREATE INDEX idx_dns_poison_expiry ON dns_poison_reports(expires_at);

-- 3) MEASURED MTU — winner per (isp, city) of the five-size DNS probe.
CREATE TABLE mtu_reports (
  isp TEXT NOT NULL,
  city TEXT NOT NULL,
  mtu INTEGER NOT NULL CHECK (mtu BETWEEN 512 AND 1400),
  samples INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (isp, city)
);
CREATE INDEX idx_mtu_reports_expiry ON mtu_reports(expires_at);

-- 4) TUNNEL vs DIRECT RACE — crowd-reported per-domain winner.
CREATE TABLE race_reports (
  domain TEXT PRIMARY KEY,
  direct_ms INTEGER,
  tunnel_ms INTEGER,
  winner TEXT NOT NULL CHECK (winner IN ('direct', 'tunnel', 'tie')),
  samples INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_race_expiry ON race_reports(expires_at);

-- 5) RIPE/IRNIC DELEGATIONS — daily snapshot diff card plus the live range
--    set behind the public sing-box rule-set (/api/v1/geoip-ir.json).
CREATE TABLE rir_ir_snapshots (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL UNIQUE,
  source_url TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  range_count INTEGER NOT NULL,
  added INTEGER NOT NULL,
  removed INTEGER NOT NULL,
  fetched_at TEXT NOT NULL
);
CREATE TABLE geoip_ir_current (
  cidr TEXT PRIMARY KEY,
  family TEXT NOT NULL CHECK (family IN ('ipv4', 'ipv6')),
  first_seen_day TEXT NOT NULL
);

-- 6) DEPLOYMENT EXTENSIONS — sleeper role + DNS tunnel metadata.
--    Only PUBLIC tunnel material is stored; private keys never leave the VPS.
ALTER TABLE deployments ADD COLUMN role TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE deployments ADD COLUMN dns_tunnel_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deployments ADD COLUMN tunnel_hostname TEXT;
ALTER TABLE deployments ADD COLUMN dnstt_public_key TEXT;
ALTER TABLE deployments ADD COLUMN slipstream_spki_sha256 TEXT;
ALTER TABLE deployments ADD COLUMN tunnel_mtu INTEGER;
ALTER TABLE deployments ADD COLUMN sleeper_anchor_hour INTEGER;
ALTER TABLE deployments ADD COLUMN sleeper_consented_at TEXT;
ALTER TABLE deployments ADD COLUMN beacon_published_at TEXT;

-- One-shot commands delivered through the daily TXT beacon window.
CREATE TABLE sleeper_commands (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  command TEXT NOT NULL CHECK (command IN ('report-now', 'wake')),
  queued_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX idx_sleeper_commands_pending ON sleeper_commands(deployment_id, consumed_at, queued_at DESC);

-- 7) AGENT REPORT EXTENSIONS — tunnel health and measured MTU on the node.
ALTER TABLE agent_reports ADD COLUMN mtu_bytes INTEGER;
ALTER TABLE agent_reports ADD COLUMN tunnel_txt_rtt_ms INTEGER;
ALTER TABLE agent_reports ADD COLUMN tunnel_status TEXT;
