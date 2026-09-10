ALTER TABLE oauth_connections
ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'oauth'
CHECK (auth_type IN ('oauth', 'api_token'));

ALTER TABLE oauth_connections ADD COLUMN resource_account_id TEXT;
ALTER TABLE oauth_connections ADD COLUMN resource_account_name TEXT;
ALTER TABLE oauth_connections ADD COLUMN resource_zone_id TEXT;
ALTER TABLE oauth_connections ADD COLUMN resource_zone_name TEXT;

CREATE INDEX idx_oauth_connections_expiry
ON oauth_connections(auth_type, revoked_at, expires_at);
