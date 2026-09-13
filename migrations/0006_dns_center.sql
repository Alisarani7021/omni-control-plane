-- V13.5.1 — independent DNS center: healthy-resolver discovery + config builders
CREATE TABLE IF NOT EXISTS dns_scan_ranges (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cidr TEXT NOT NULL,
  ips_total INTEGER NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_scan_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS dns_scan_results (
  id TEXT PRIMARY KEY,
  range_id TEXT NOT NULL REFERENCES dns_scan_ranges(id) ON DELETE CASCADE,
  ip TEXT NOT NULL,
  ok INTEGER NOT NULL,
  rtt_ms INTEGER,
  verdict TEXT NOT NULL,
  checked_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dns_range_due ON dns_scan_ranges(last_scan_at, created_at);
CREATE INDEX IF NOT EXISTS idx_dns_result_recent ON dns_scan_results(verdict, checked_at);
