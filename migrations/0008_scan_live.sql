-- Live scan message binding + single-round result cleanliness.
ALTER TABLE dns_scan_ranges ADD COLUMN live_chat_id TEXT;
ALTER TABLE dns_scan_ranges ADD COLUMN live_message_id INTEGER;
