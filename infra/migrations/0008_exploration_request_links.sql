-- Separate canonical request/job/result state from account-scoped history.
-- Existing single-account history is preserved as one account link per request.

DROP TRIGGER IF EXISTS exploration_request_accounts_owner_insert;
DROP TRIGGER IF EXISTS exploration_request_accounts_owner_update;

CREATE TABLE exploration_request_accounts_v8 (
  request_id TEXT NOT NULL REFERENCES exploration_requests(request_id) ON DELETE CASCADE,
  account_sub TEXT NOT NULL CHECK (length(account_sub) BETWEEN 1 AND 512),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+90 days')),
  PRIMARY KEY (request_id, account_sub)
) WITHOUT ROWID;

INSERT INTO exploration_request_accounts_v8 (request_id, account_sub, created_at, expires_at)
SELECT request_id, account_sub, created_at, expires_at FROM exploration_request_accounts;

DROP TABLE exploration_request_accounts;
ALTER TABLE exploration_request_accounts_v8 RENAME TO exploration_request_accounts;

DROP INDEX IF EXISTS idx_exploration_requests_account_recent;
ALTER TABLE exploration_requests DROP COLUMN account_sub;

CREATE INDEX IF NOT EXISTS idx_exploration_requests_recent
  ON exploration_requests(created_at DESC, request_id);
CREATE INDEX IF NOT EXISTS idx_exploration_request_accounts_account_recent
  ON exploration_request_accounts(account_sub, created_at DESC, request_id);
CREATE INDEX IF NOT EXISTS idx_exploration_request_accounts_expiry
  ON exploration_request_accounts(expires_at);

-- Keep the owner-match guard at the account boundary: every link must name an
-- existing shared request and a valid account owner. Account identity is never
-- copied onto, or used to change, the canonical request row.
CREATE TRIGGER exploration_request_accounts_owner_insert
BEFORE INSERT ON exploration_request_accounts
WHEN NOT EXISTS (
  SELECT 1 FROM exploration_requests r WHERE r.request_id = NEW.request_id
) OR length(NEW.account_sub) NOT BETWEEN 1 AND 512
BEGIN
  SELECT RAISE(ABORT, 'account link owner must match an existing request');
END;
CREATE TRIGGER exploration_request_accounts_owner_update
BEFORE UPDATE ON exploration_request_accounts
WHEN NEW.request_id IS NOT OLD.request_id OR NEW.account_sub IS NOT OLD.account_sub OR NOT EXISTS (
  SELECT 1 FROM exploration_requests r WHERE r.request_id = NEW.request_id
) OR length(NEW.account_sub) NOT BETWEEN 1 AND 512
BEGIN
  SELECT RAISE(ABORT, 'account link owner is immutable');
END;
