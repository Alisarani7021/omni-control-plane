PRAGMA foreign_keys = ON;

-- One active conversational wizard (e.g. deployment creation) per Telegram user.
-- State is short-lived JSON; expires_at is enforced on every read.
CREATE TABLE telegram_wizards (
  telegram_user_id TEXT PRIMARY KEY,
  flow TEXT NOT NULL,
  step TEXT NOT NULL,
  state_json TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_telegram_wizards_expiry ON telegram_wizards(expires_at);
