-- Deprecated compatibility storage: exploration_requests and its owner
-- triggers remain untouched, but all tables introduced here use the neutral
-- exploration_shared_requests table and never consult the legacy owner row.
-- Account deletion/unlink removes only exploration_request_links rows. The
-- bounded GC statement at the end removes up to 100 unlinked requests per run.

CREATE TABLE IF NOT EXISTS exploration_shared_requests (
  request_id TEXT PRIMARY KEY CHECK (length(request_id) = 64 AND request_id NOT GLOB '*[^0-9a-f]*'),
  contract_version INTEGER NOT NULL CHECK (contract_version = 1),
  request_json TEXT NOT NULL CHECK (
    length(request_json) BETWEEN 2 AND 4096 AND json_valid(request_json) AND
    json_type(request_json) = 'object' AND json_extract(request_json, '$.version') = 1 AND
    json_extract(request_json, '$.family') = 'arrival_manager' AND
    json_extract(request_json, '$.population') = 'first_team_available' AND
    json_extract(request_json, '$.joining_basis') = 'effective_first_team_spell_entry' AND
    json_extract(request_json, '$.academy_basis') = 'documented_first_team_promotion' AND
    json_extract(request_json, '$.visualization') = 'table' AND json_type(request_json, '$.as_of') = 'text'
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+90 days'))
);
CREATE INDEX IF NOT EXISTS idx_exploration_shared_requests_expiry
  ON exploration_shared_requests(expires_at);

CREATE TABLE IF NOT EXISTS exploration_request_links (
  request_id TEXT NOT NULL REFERENCES exploration_shared_requests(request_id) ON DELETE CASCADE,
  account_sub TEXT NOT NULL CHECK (length(account_sub) BETWEEN 1 AND 512),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+90 days')),
  PRIMARY KEY (request_id, account_sub)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_exploration_request_links_account_recent
  ON exploration_request_links(account_sub, created_at DESC, request_id);
CREATE INDEX IF NOT EXISTS idx_exploration_request_links_expiry
  ON exploration_request_links(expires_at);
CREATE TRIGGER IF NOT EXISTS exploration_request_links_shared_insert
BEFORE INSERT ON exploration_request_links
WHEN NOT EXISTS (
  SELECT 1 FROM exploration_shared_requests AS r WHERE r.request_id = NEW.request_id
) OR length(NEW.account_sub) NOT BETWEEN 1 AND 512
BEGIN
  SELECT RAISE(ABORT, 'account link must name an existing shared request and valid account');
END;
CREATE TRIGGER IF NOT EXISTS exploration_request_links_shared_update
BEFORE UPDATE ON exploration_request_links
WHEN NEW.request_id IS NOT OLD.request_id OR NEW.account_sub IS NOT OLD.account_sub OR NOT EXISTS (
  SELECT 1 FROM exploration_shared_requests AS r WHERE r.request_id = NEW.request_id
) OR length(NEW.account_sub) NOT BETWEEN 1 AND 512
BEGIN
  SELECT RAISE(ABORT, 'shared request link identity is immutable');
END;

-- Shared payload rows cascade only from the account-neutral request record.
CREATE TABLE IF NOT EXISTS exploration_shared_results (
  request_id TEXT PRIMARY KEY REFERENCES exploration_shared_requests(request_id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  artifact_key TEXT NOT NULL,
  transform_code_version TEXT NOT NULL,
  renderer_version TEXT NOT NULL,
  roster_snapshot_id TEXT,
  feasibility TEXT NOT NULL,
  coverage TEXT NOT NULL,
  population_count INTEGER NOT NULL,
  assigned_json TEXT NOT NULL,
  unknown_json TEXT NOT NULL,
  lineage_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS exploration_shared_result_groups (
  request_id TEXT NOT NULL REFERENCES exploration_shared_results(request_id) ON DELETE CASCADE,
  manager_id TEXT NOT NULL,
  member_count INTEGER NOT NULL,
  members_json TEXT NOT NULL,
  lineage_json TEXT NOT NULL,
  PRIMARY KEY (request_id, manager_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS exploration_shared_jobs (
  job_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES exploration_shared_requests(request_id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  lease_id TEXT,
  lease_expires_at TEXT,
  claimed_at TEXT,
  retry_after TEXT,
  failure TEXT,
  publication_json TEXT,
  admitted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Backfill canonical work and each account's independent retention window.
-- The owner column is read only as migration input and is not copied.
INSERT OR IGNORE INTO exploration_shared_requests
  (request_id, contract_version, request_json, created_at, expires_at)
SELECT request_id, contract_version, request_json, created_at, expires_at
FROM exploration_requests;

INSERT OR IGNORE INTO exploration_request_links (request_id, account_sub, created_at, expires_at)
SELECT request_id, account_sub, created_at, expires_at
FROM exploration_request_accounts;
INSERT OR IGNORE INTO exploration_request_links (request_id, account_sub, created_at, expires_at)
SELECT request_id, account_sub, created_at, expires_at
FROM exploration_requests;

INSERT OR IGNORE INTO exploration_shared_results
  (request_id, snapshot_id, artifact_key, transform_code_version, renderer_version, roster_snapshot_id,
   feasibility, coverage, population_count, assigned_json, unknown_json, lineage_json, created_at, expires_at)
SELECT request_id, snapshot_id, artifact_key, transform_code_version, renderer_version, roster_snapshot_id,
       feasibility, coverage, population_count, assigned_json, unknown_json, lineage_json, created_at, expires_at
FROM exploration_results;
INSERT OR IGNORE INTO exploration_shared_result_groups
  (request_id, manager_id, member_count, members_json, lineage_json)
SELECT request_id, manager_id, member_count, members_json, lineage_json
FROM exploration_result_groups;
INSERT OR IGNORE INTO exploration_shared_jobs
  (job_id, request_id, status, attempt, lease_id, lease_expires_at, claimed_at, retry_after, failure,
   publication_json, admitted_at, created_at, updated_at, expires_at)
SELECT job_id, request_id, status, attempt, lease_id, lease_expires_at, claimed_at, retry_after, failure,
       publication_json, admitted_at, created_at, updated_at, expires_at
FROM exploration_jobs;

-- Bounded collector statement: execute when running the collector. Cascades
-- from the neutral request row remove its shared results/groups/jobs.
-- DELETE FROM exploration_shared_requests
-- WHERE request_id IN (
--   SELECT r.request_id
--   FROM exploration_shared_requests AS r
--   WHERE NOT EXISTS (
--     SELECT 1 FROM exploration_request_links AS l WHERE l.request_id = r.request_id
--   )
--   ORDER BY r.expires_at, r.request_id
--   LIMIT 100
-- );
