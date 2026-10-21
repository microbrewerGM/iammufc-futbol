-- B15 request/job storage. This migration persists only the frozen closed
-- contract envelopes and bounded linkage metadata. It stores no raw source rows,
-- question text, credentials, or service identity in human history/telemetry.
-- Jobs and tombstones are eligible for deletion after 30 days; account linkage
-- has a separate 90-day history retention and is always deleted by account.
CREATE TABLE IF NOT EXISTS exploration_requests (
  request_id TEXT PRIMARY KEY CHECK (length(request_id) = 64 AND request_id NOT GLOB '*[^0-9a-f]*'),
  account_sub TEXT NOT NULL CHECK (length(account_sub) BETWEEN 1 AND 512),
  contract_version INTEGER NOT NULL CHECK (contract_version = 1),
  request_json TEXT NOT NULL CHECK (
    length(request_json) BETWEEN 2 AND 4096 AND json_valid(request_json) AND
    json_type(request_json) = 'object' AND
    json_extract(request_json, '$.version') = 1 AND
    json_extract(request_json, '$.family') = 'arrival_manager' AND
    json_extract(request_json, '$.population') = 'first_team_available' AND
    json_extract(request_json, '$.joining_basis') = 'effective_first_team_spell_entry' AND
    json_extract(request_json, '$.academy_basis') = 'documented_first_team_promotion' AND
    json_extract(request_json, '$.visualization') = 'table' AND
    json_type(request_json, '$.as_of') = 'text'
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS idx_exploration_requests_account_recent
  ON exploration_requests(account_sub, created_at DESC, request_id);
CREATE INDEX IF NOT EXISTS idx_exploration_requests_expiry
  ON exploration_requests(expires_at);

CREATE TRIGGER IF NOT EXISTS exploration_requests_closed_insert
BEFORE INSERT ON exploration_requests
WHEN (SELECT count(*) FROM json_each(NEW.request_json)) != 7
BEGIN
  SELECT RAISE(ABORT, 'invalid arrival-manager request shape');
END;
CREATE TRIGGER IF NOT EXISTS exploration_requests_closed_update
BEFORE UPDATE OF request_json ON exploration_requests
WHEN (SELECT count(*) FROM json_each(NEW.request_json)) != 7
BEGIN
  SELECT RAISE(ABORT, 'invalid arrival-manager request shape');
END;

-- Derived group rows contain stable contract IDs, finite coverage and lineage;
-- no names or source roster/transfer/tenure payloads. Group artifacts are bounded
-- to 100 assigned/unknown members by the contract and expire after 30 days.
CREATE TABLE IF NOT EXISTS exploration_results (
  request_id TEXT PRIMARY KEY REFERENCES exploration_requests(request_id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL CHECK (length(snapshot_id) BETWEEN 1 AND 96),
  artifact_key TEXT NOT NULL CHECK (length(artifact_key) = 64 AND artifact_key NOT GLOB '*[^0-9a-f]*'),
  transform_code_version TEXT NOT NULL CHECK (length(transform_code_version) BETWEEN 1 AND 96),
  renderer_version TEXT NOT NULL CHECK (length(renderer_version) BETWEEN 1 AND 96),
  roster_snapshot_id TEXT CHECK (roster_snapshot_id IS NULL OR length(roster_snapshot_id) BETWEEN 1 AND 96),
  feasibility TEXT NOT NULL CHECK (feasibility IN ('available','computable_now_queued','computable_but_expensive','no_data','no_rights')),
  coverage TEXT NOT NULL CHECK (coverage IN ('complete','partial','missing')),
  population_count INTEGER NOT NULL CHECK (typeof(population_count) = 'integer' AND population_count BETWEEN 0 AND 100),
  assigned_json TEXT NOT NULL CHECK (length(assigned_json) BETWEEN 2 AND 196608 AND json_valid(assigned_json) AND json_type(assigned_json) = 'array' AND json_array_length(assigned_json) <= 100),
  unknown_json TEXT NOT NULL CHECK (length(unknown_json) BETWEEN 2 AND 98304 AND json_valid(unknown_json) AND json_type(unknown_json) = 'array' AND json_array_length(unknown_json) <= 100),
  lineage_json TEXT NOT NULL CHECK (length(lineage_json) BETWEEN 2 AND 4096 AND json_valid(lineage_json) AND json_type(lineage_json) = 'array' AND json_array_length(lineage_json) <= 32),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > created_at),
  CHECK (json_array_length(assigned_json) + json_array_length(unknown_json) = population_count),
  CHECK (feasibility != 'available' OR (coverage != 'missing' AND roster_snapshot_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_exploration_results_expiry ON exploration_results(expires_at);

CREATE TABLE IF NOT EXISTS exploration_result_groups (
  request_id TEXT NOT NULL REFERENCES exploration_results(request_id) ON DELETE CASCADE,
  manager_id TEXT NOT NULL CHECK (length(manager_id) BETWEEN 1 AND 96 AND manager_id NOT GLOB '*[^a-z0-9:_-]*'),
  member_count INTEGER NOT NULL CHECK (typeof(member_count) = 'integer' AND member_count BETWEEN 1 AND 100),
  members_json TEXT NOT NULL CHECK (length(members_json) BETWEEN 2 AND 65536 AND json_valid(members_json) AND json_type(members_json) = 'array' AND json_array_length(members_json) = member_count),
  lineage_json TEXT NOT NULL CHECK (length(lineage_json) BETWEEN 2 AND 4096 AND json_valid(lineage_json) AND json_type(lineage_json) = 'array' AND json_array_length(lineage_json) BETWEEN 1 AND 32),
  PRIMARY KEY (request_id, manager_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS exploration_jobs (
  job_id TEXT PRIMARY KEY CHECK (length(job_id) = 64 AND job_id NOT GLOB '*[^0-9a-f]*'),
  request_id TEXT NOT NULL UNIQUE REFERENCES exploration_requests(request_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued','running','failed','published')),
  attempt INTEGER NOT NULL CHECK (typeof(attempt) = 'integer' AND attempt BETWEEN 0 AND 3),
  lease_id TEXT CHECK (lease_id IS NULL OR (length(lease_id) BETWEEN 1 AND 96 AND lease_id NOT GLOB '*[^a-z0-9:_-]*')),
  lease_expires_at TEXT,
  retry_after TEXT,
  failure TEXT CHECK (failure IS NULL OR failure IN ('source_unavailable','validation_failed','publication_failed','lease_expired','attempts_exhausted')),
  publication_json TEXT CHECK (publication_json IS NULL OR (length(publication_json) BETWEEN 2 AND 16384 AND json_valid(publication_json) AND json_type(publication_json) = 'object')),
  admitted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > admitted_at),
  CHECK ((status = 'queued' AND lease_id IS NULL AND lease_expires_at IS NULL AND failure IS NULL AND publication_json IS NULL) OR
         (status = 'running' AND attempt BETWEEN 1 AND 3 AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL AND failure IS NULL AND publication_json IS NULL) OR
         (status = 'failed' AND attempt BETWEEN 1 AND 3 AND lease_id IS NULL AND lease_expires_at IS NULL AND failure IS NOT NULL AND publication_json IS NULL) OR
         (status = 'published' AND attempt BETWEEN 1 AND 3 AND lease_id IS NULL AND lease_expires_at IS NULL AND retry_after IS NULL AND failure IS NULL AND publication_json IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_exploration_jobs_due
  ON exploration_jobs(status, retry_after, admitted_at, job_id);
CREATE INDEX IF NOT EXISTS idx_exploration_jobs_expiry ON exploration_jobs(expires_at);

-- Operation IDs are service-scoped opaque references. Never persist credentials
-- or service identity values; the bridge supplies a stable non-secret scope key.
CREATE TABLE IF NOT EXISTS exploration_job_idempotency (
  scope_key TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 96),
  operation_type TEXT NOT NULL CHECK (operation_type IN ('claim','ack')),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 96 AND operation_id NOT GLOB '*[^a-z0-9:_-]*'),
  body_hash TEXT NOT NULL CHECK (length(body_hash) = 64 AND body_hash NOT GLOB '*[^0-9a-f]*'),
  response_json TEXT NOT NULL CHECK (length(response_json) BETWEEN 2 AND 65536 AND json_valid(response_json)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > created_at),
  PRIMARY KEY (scope_key, operation_type, operation_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_exploration_idempotency_expiry
  ON exploration_job_idempotency(expires_at);

-- Human history retention is separate from job/tombstone retention. Explicit
-- account-scoped deletion cascades request/result/group/job state.
CREATE TABLE IF NOT EXISTS exploration_request_accounts (
  request_id TEXT PRIMARY KEY REFERENCES exploration_requests(request_id) ON DELETE CASCADE,
  account_sub TEXT NOT NULL CHECK (length(account_sub) BETWEEN 1 AND 512),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS idx_exploration_request_accounts_account_recent
  ON exploration_request_accounts(account_sub, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exploration_request_accounts_expiry
  ON exploration_request_accounts(expires_at);
