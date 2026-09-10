PRAGMA foreign_keys = ON;

-- Panel sections ported from the standalone OMNI worker into the native bot:
-- clean-IP radar, censorship map (netmeli), WhiteHole DNS dead-drop, AI key
-- donation pool, and the short-lived conversational flows that feed them.

-- 1) CLEAN-IP RADAR — crowd-reported reachability per (ip, operator, city).
--    Values are client self-reports, never probe results fabricated by the server.
CREATE TABLE clean_ip_reports (
  ip TEXT NOT NULL,
  operator TEXT NOT NULL,
  city TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  loss_pct REAL NOT NULL,
  ok_count INTEGER NOT NULL DEFAULT 0,
  report_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (ip, operator, city)
);
CREATE INDEX idx_clean_ip_reports_segment ON clean_ip_reports(operator, city, updated_at DESC);
CREATE INDEX idx_clean_ip_reports_expiry ON clean_ip_reports(expires_at);

-- 2) LIVE CENSORSHIP MAP — one row per client report, no IP and no user id stored.
CREATE TABLE map_reports (
  id TEXT PRIMARY KEY,
  isp TEXT NOT NULL,
  city TEXT NOT NULL,
  transport TEXT NOT NULL,
  rtt_ms INTEGER,
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_map_reports_window ON map_reports(created_at DESC);
CREATE INDEX idx_map_reports_expiry ON map_reports(expires_at);

-- 3) WHITEHOLE DEAD-DROP — one row per publish into the tenant's own zone DNS.
CREATE TABLE whitehole_drops (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  zone_name TEXT NOT NULL,
  record_names TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  shard_count INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('published', 'failed', 'cleared')),
  detail TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_whitehole_drops_tenant ON whitehole_drops(tenant_id, created_at DESC);
CREATE INDEX idx_whitehole_drops_expiry ON whitehole_drops(expires_at);

-- 4) AI KEY DONATIONS — metadata only in this table; the secret lives in a
--    child row so a withdrawal can hard-delete the ciphertext.
CREATE TABLE ai_donations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  donor_user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL UNIQUE,
  key_snippet TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  review_at TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_ai_donations_status ON ai_donations(status, created_at DESC);
CREATE INDEX idx_ai_donations_donor ON ai_donations(donor_user_id, created_at DESC);
CREATE INDEX idx_ai_donations_expiry ON ai_donations(expires_at);

CREATE TABLE ai_donation_secrets (
  donation_id TEXT PRIMARY KEY REFERENCES ai_donations(id) ON DELETE CASCADE,
  secret_enc TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 5) Short-lived conversational flows (report submission, donation consent).
--    Kept separate from telegram_wizards so the deploy wizard stays untouched.
CREATE TABLE telegram_flows (
  telegram_user_id TEXT PRIMARY KEY,
  flow TEXT NOT NULL,
  step TEXT NOT NULL,
  state_json TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_telegram_flows_expiry ON telegram_flows(expires_at);
