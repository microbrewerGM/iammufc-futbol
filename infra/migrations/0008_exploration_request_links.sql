-- Keep the legacy owner column and table for compatibility. New shared work
-- uses this separate account-link table, where one request can belong to many
-- accounts and each link has independent retention.
CREATE TABLE IF NOT EXISTS exploration_request_links (
  request_id TEXT NOT NULL REFERENCES exploration_requests(request_id) ON DELETE CASCADE,
  account_sub TEXT NOT NULL CHECK (length(account_sub) BETWEEN 1 AND 512),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+90 days')),
  PRIMARY KEY (request_id, account_sub)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_exploration_request_links_account_recent
  ON exploration_request_links(account_sub, created_at DESC, request_id);
CREATE INDEX IF NOT EXISTS idx_exploration_request_links_expiry
  ON exploration_request_links(expires_at);

CREATE TRIGGER IF NOT EXISTS exploration_request_links_owner_insert
BEFORE INSERT ON exploration_request_links
WHEN NOT EXISTS (
  SELECT 1 FROM exploration_requests r WHERE r.request_id = NEW.request_id
) OR length(NEW.account_sub) NOT BETWEEN 1 AND 512
BEGIN
  SELECT RAISE(ABORT, 'account link must name an existing request and valid owner');
END;
CREATE TRIGGER IF NOT EXISTS exploration_request_links_owner_update
BEFORE UPDATE ON exploration_request_links
WHEN NEW.request_id IS NOT OLD.request_id OR NEW.account_sub IS NOT OLD.account_sub OR NOT EXISTS (
  SELECT 1 FROM exploration_requests r WHERE r.request_id = NEW.request_id
) OR length(NEW.account_sub) NOT BETWEEN 1 AND 512
BEGIN
  SELECT RAISE(ABORT, 'account link owner is immutable');
END;

-- Preserve any links already recorded in the legacy table, including their
-- original retention dates. The request owner is a fallback for rows where
-- only the legacy column was populated.
INSERT OR IGNORE INTO exploration_request_links (request_id, account_sub, created_at, expires_at)
SELECT request_id, account_sub, created_at, expires_at
FROM exploration_request_accounts;

INSERT OR IGNORE INTO exploration_request_links (request_id, account_sub, created_at, expires_at)
SELECT request_id, account_sub, created_at, expires_at
FROM exploration_requests;
