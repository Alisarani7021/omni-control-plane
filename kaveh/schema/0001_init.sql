-- migration 0001_init
-- Kaveh schema. Every migration is a separate file applied by `wrangler d1 migrations apply`.
-- Zeus does this with inline `CREATE TABLE IF NOT EXISTS` fired on *every single request*,
-- which means schema changes cannot be versioned, rolled back, or reasoned about.

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT    NOT NULL UNIQUE,
  uuid           TEXT    NOT NULL UNIQUE,
  sub_token      TEXT    NOT NULL UNIQUE,
  quota_gb       REAL    NOT NULL DEFAULT 50,
  used_bytes     INTEGER NOT NULL DEFAULT 0,
  expiry_days    INTEGER NOT NULL DEFAULT 30,
  first_connect  INTEGER NOT NULL DEFAULT 1,   -- 1 = clock starts on first connection
  activated_at   INTEGER,                      -- unix ms, NULL until first connect
  expires_at     INTEGER,                      -- unix ms
  device_limit   INTEGER NOT NULL DEFAULT 3,
  request_limit  INTEGER NOT NULL DEFAULT 0,   -- 0 = unlimited
  requests_used  INTEGER NOT NULL DEFAULT 0,
  ips            TEXT    NOT NULL DEFAULT '[]',
  proxies        TEXT    NOT NULL DEFAULT '[]',
  connection     TEXT    NOT NULL DEFAULT 'ws',
  tls            TEXT    NOT NULL DEFAULT 'on',
  fragment       TEXT    NOT NULL DEFAULT '',
  fingerprint    TEXT    NOT NULL DEFAULT '',
  block_list     TEXT    NOT NULL DEFAULT '[]',
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_by     TEXT,
  note           TEXT    NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_active   ON users(is_active);
CREATE INDEX IF NOT EXISTS idx_users_expiry   ON users(expires_at);
CREATE INDEX IF NOT EXISTS idx_users_uuid     ON users(uuid);
CREATE INDEX IF NOT EXISTS idx_users_subtok   ON users(sub_token);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  subject    TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'admin',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip_hash    TEXT,
  ua_hash    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  ip_hash    TEXT,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);

CREATE TABLE IF NOT EXISTS usage_daily (
  day        TEXT NOT NULL,          -- YYYY-MM-DD (UTC)
  username   TEXT NOT NULL,
  up_bytes   INTEGER NOT NULL DEFAULT 0,
  down_bytes INTEGER NOT NULL DEFAULT 0,
  conns      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, username)
);

CREATE TABLE IF NOT EXISTS plans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  quota_gb    REAL NOT NULL,
  expiry_days INTEGER NOT NULL,
  device_limit INTEGER NOT NULL DEFAULT 3,
  price_toman INTEGER NOT NULL DEFAULT 0,
  is_public   INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  label      TEXT NOT NULL,
  host       TEXT NOT NULL,
  port       INTEGER NOT NULL DEFAULT 443,
  kind       TEXT NOT NULL DEFAULT 'socks5',
  priority   INTEGER NOT NULL DEFAULT 100,
  healthy    INTEGER NOT NULL DEFAULT 1,
  last_check INTEGER,
  latency_ms INTEGER,
  created_at INTEGER NOT NULL
);
