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
    json_type(request_json, '$.version') IS NOT NULL AND json_extract(request_json, '$.version') = 1 AND
    json_type(request_json, '$.family') IS NOT NULL AND json_extract(request_json, '$.family') = 'arrival_manager' AND
    json_type(request_json, '$.population') IS NOT NULL AND json_extract(request_json, '$.population') = 'first_team_available' AND
    json_type(request_json, '$.joining_basis') IS NOT NULL AND json_extract(request_json, '$.joining_basis') = 'effective_first_team_spell_entry' AND
    json_type(request_json, '$.academy_basis') IS NOT NULL AND json_extract(request_json, '$.academy_basis') = 'documented_first_team_promotion' AND
    json_type(request_json, '$.visualization') IS NOT NULL AND json_extract(request_json, '$.visualization') = 'table' AND
    json_type(request_json, '$.as_of') = 'text'
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+90 days'))
);
CREATE INDEX IF NOT EXISTS idx_exploration_requests_account_recent
  ON exploration_requests(account_sub, created_at DESC, request_id);
CREATE INDEX IF NOT EXISTS idx_exploration_requests_expiry
  ON exploration_requests(expires_at);

CREATE TRIGGER IF NOT EXISTS exploration_requests_closed_insert
BEFORE INSERT ON exploration_requests
WHEN (SELECT count(*) FROM json_each(NEW.request_json)) != 7 OR
  json_type(NEW.request_json, '$.version') IS NULL OR json_type(NEW.request_json, '$.family') IS NULL OR
  json_type(NEW.request_json, '$.as_of') IS NULL OR json_type(NEW.request_json, '$.population') IS NULL OR
  json_type(NEW.request_json, '$.joining_basis') IS NULL OR json_type(NEW.request_json, '$.academy_basis') IS NULL OR
  json_type(NEW.request_json, '$.visualization') IS NULL
BEGIN
  SELECT RAISE(ABORT, 'invalid arrival-manager request shape');
END;
CREATE TRIGGER IF NOT EXISTS exploration_requests_closed_update
BEFORE UPDATE OF request_json ON exploration_requests
WHEN (SELECT count(*) FROM json_each(NEW.request_json)) != 7 OR
  json_type(NEW.request_json, '$.version') IS NULL OR json_type(NEW.request_json, '$.family') IS NULL OR
  json_type(NEW.request_json, '$.as_of') IS NULL OR json_type(NEW.request_json, '$.population') IS NULL OR
  json_type(NEW.request_json, '$.joining_basis') IS NULL OR json_type(NEW.request_json, '$.academy_basis') IS NULL OR
  json_type(NEW.request_json, '$.visualization') IS NULL
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
  expires_at TEXT NOT NULL CHECK (expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+30 days')),
  CHECK (json_array_length(assigned_json) + json_array_length(unknown_json) = population_count),
  CHECK (feasibility != 'available' OR (coverage != 'missing' AND roster_snapshot_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_exploration_results_expiry ON exploration_results(expires_at);

-- Validate every nested result object against the closed v1 contract. Expiry
-- deletion is run by B15-BRIDGE after leases/account links are safely handled.
CREATE TRIGGER IF NOT EXISTS exploration_results_privacy_insert
BEFORE INSERT ON exploration_results
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.assigned_json) AS item
    WHERE item.type != 'object' OR (SELECT count(*) FROM json_each(item.value)) != 7 OR
    json_type(item.value, '$.member_id') IS NOT 'text' OR json_type(item.value, '$.person_id') IS NOT 'text' OR
    json_type(item.value, '$.spell_id') IS NOT 'text' OR json_type(item.value, '$.manager_id') IS NOT 'text' OR
    json_type(item.value, '$.event_id') IS NOT 'text' OR json_type(item.value, '$.tenure_id') IS NOT 'text' OR
    json_type(item.value, '$.lineage') IS NOT 'array' OR json_array_length(json_extract(item.value, '$.lineage')) NOT BETWEEN 1 AND 32 OR
    EXISTS (SELECT 1 FROM json_each(json_extract(item.value, '$.lineage')) WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 96)
) OR EXISTS (
  SELECT 1 FROM json_each(NEW.unknown_json) AS item
    WHERE item.type != 'object' OR (SELECT count(*) FROM json_each(item.value)) != 5 OR
    json_type(item.value, '$.member_id') IS NOT 'text' OR json_type(item.value, '$.person_id') IS NULL OR json_type(item.value, '$.person_id') NOT IN ('text','null') OR
    json_type(item.value, '$.spell_id') IS NULL OR json_type(item.value, '$.spell_id') NOT IN ('text','null') OR json_type(item.value, '$.reason') IS NOT 'text' OR
    json_extract(item.value, '$.reason') NOT IN ('identity_unresolved','spell_missing','arrival_missing','promotion_missing','date_uncertain','boundary_unresolved','tenure_missing','tenure_overlap','source_conflict') OR
    json_type(item.value, '$.lineage') IS NOT 'array' OR json_array_length(json_extract(item.value, '$.lineage')) NOT BETWEEN 1 AND 32 OR
    EXISTS (SELECT 1 FROM json_each(json_extract(item.value, '$.lineage')) WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 96)
) OR EXISTS (SELECT 1 FROM json_each(NEW.lineage_json) WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 96)
BEGIN
  SELECT RAISE(ABORT, 'invalid private result JSON shape');
END;
CREATE TRIGGER IF NOT EXISTS exploration_results_privacy_update
BEFORE UPDATE OF assigned_json, unknown_json, lineage_json ON exploration_results
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.assigned_json) AS item
    WHERE item.type != 'object' OR (SELECT count(*) FROM json_each(item.value)) != 7 OR
      json_type(item.value, '$.member_id') IS NOT 'text' OR json_type(item.value, '$.person_id') IS NOT 'text' OR
      json_type(item.value, '$.spell_id') IS NOT 'text' OR json_type(item.value, '$.manager_id') IS NOT 'text' OR
      json_type(item.value, '$.event_id') IS NOT 'text' OR json_type(item.value, '$.tenure_id') IS NOT 'text' OR
      json_type(item.value, '$.lineage') IS NOT 'array' OR json_array_length(json_extract(item.value, '$.lineage')) NOT BETWEEN 1 AND 32 OR
      EXISTS (SELECT 1 FROM json_each(json_extract(item.value, '$.lineage')) WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 96)
  ) OR EXISTS (
    SELECT 1 FROM json_each(NEW.unknown_json) AS item
    WHERE item.type != 'object' OR (SELECT count(*) FROM json_each(item.value)) != 5 OR
      json_type(item.value, '$.member_id') IS NOT 'text' OR json_type(item.value, '$.person_id') IS NULL OR json_type(item.value, '$.person_id') NOT IN ('text','null') OR
      json_type(item.value, '$.spell_id') IS NULL OR json_type(item.value, '$.spell_id') NOT IN ('text','null') OR json_type(item.value, '$.reason') IS NOT 'text' OR
      json_extract(item.value, '$.reason') NOT IN ('identity_unresolved','spell_missing','arrival_missing','promotion_missing','date_uncertain','boundary_unresolved','tenure_missing','tenure_overlap','source_conflict') OR
      json_type(item.value, '$.lineage') IS NOT 'array' OR json_array_length(json_extract(item.value, '$.lineage')) NOT BETWEEN 1 AND 32 OR
      EXISTS (SELECT 1 FROM json_each(json_extract(item.value, '$.lineage')) WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 96)
  ) OR EXISTS (SELECT 1 FROM json_each(NEW.lineage_json) WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 96)
  THEN RAISE(ABORT, 'invalid private result JSON shape') END;
END;

CREATE TABLE IF NOT EXISTS exploration_result_groups (
  request_id TEXT NOT NULL REFERENCES exploration_results(request_id) ON DELETE CASCADE,
  manager_id TEXT NOT NULL CHECK (length(manager_id) BETWEEN 1 AND 96 AND manager_id NOT GLOB '*[^a-z0-9:_-]*'),
  member_count INTEGER NOT NULL CHECK (typeof(member_count) = 'integer' AND member_count BETWEEN 1 AND 100),
  members_json TEXT NOT NULL CHECK (length(members_json) BETWEEN 2 AND 65536 AND json_valid(members_json) AND json_type(members_json) = 'array' AND json_array_length(members_json) = member_count),
  lineage_json TEXT NOT NULL CHECK (length(lineage_json) BETWEEN 2 AND 4096 AND json_valid(lineage_json) AND json_type(lineage_json) = 'array' AND json_array_length(lineage_json) BETWEEN 1 AND 32),
  PRIMARY KEY (request_id, manager_id)
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS exploration_result_groups_privacy_insert
BEFORE INSERT ON exploration_result_groups
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.members_json) AS item
  WHERE item.type != 'object' OR (SELECT count(*) FROM json_each(item.value)) != 7 OR
    json_type(item.value, '$.member_id') IS NOT 'text' OR json_type(item.value, '$.person_id') IS NOT 'text' OR
    json_type(item.value, '$.spell_id') IS NOT 'text' OR json_type(item.value, '$.manager_id') IS NOT 'text' OR
    json_type(item.value, '$.event_id') IS NOT 'text' OR json_type(item.value, '$.tenure_id') IS NOT 'text' OR
    json_type(item.value, '$.lineage') IS NOT 'array' OR json_array_length(json_extract(item.value, '$.lineage')) NOT BETWEEN 1 AND 32 OR
    EXISTS (SELECT 1 FROM json_each(json_extract(item.value, '$.lineage')) WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 96)
) OR EXISTS (SELECT 1 FROM json_each(NEW.lineage_json) WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 96)
BEGIN
  SELECT RAISE(ABORT, 'invalid private group JSON shape');
END;
CREATE TRIGGER IF NOT EXISTS exploration_result_groups_privacy_update
BEFORE UPDATE OF members_json, lineage_json ON exploration_result_groups
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.members_json) AS item
  WHERE item.type != 'object' OR (SELECT count(*) FROM json_each(item.value)) != 7 OR
    json_type(item.value, '$.member_id') IS NOT 'text' OR json_type(item.value, '$.person_id') IS NOT 'text' OR
    json_type(item.value, '$.spell_id') IS NOT 'text' OR json_type(item.value, '$.manager_id') IS NOT 'text' OR
    json_type(item.value, '$.event_id') IS NOT 'text' OR json_type(item.value, '$.tenure_id') IS NOT 'text' OR
    json_type(item.value, '$.lineage') IS NOT 'array' OR json_array_length(json_extract(item.value, '$.lineage')) NOT BETWEEN 1 AND 32 OR
    EXISTS (SELECT 1 FROM json_each(json_extract(item.value, '$.lineage')) WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 96)
) OR EXISTS (SELECT 1 FROM json_each(NEW.lineage_json) WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 96)
BEGIN
  SELECT RAISE(ABORT, 'invalid private group JSON shape');
END;

CREATE TABLE IF NOT EXISTS exploration_jobs (
  job_id TEXT PRIMARY KEY CHECK (length(job_id) = 64 AND job_id NOT GLOB '*[^0-9a-f]*'),
  request_id TEXT NOT NULL UNIQUE REFERENCES exploration_requests(request_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued','running','failed','published')),
  attempt INTEGER NOT NULL CHECK (typeof(attempt) = 'integer' AND attempt BETWEEN 0 AND 3),
  lease_id TEXT CHECK (lease_id IS NULL OR (length(lease_id) BETWEEN 1 AND 96 AND lease_id NOT GLOB '*[^a-z0-9:_-]*')),
  lease_expires_at TEXT,
  claimed_at TEXT,
  retry_after TEXT,
  failure TEXT CHECK (failure IS NULL OR failure IN ('source_unavailable','validation_failed','publication_failed','lease_expired','attempts_exhausted')),
  publication_json TEXT CHECK (publication_json IS NULL OR (length(publication_json) BETWEEN 2 AND 16384 AND json_valid(publication_json) AND json_type(publication_json) = 'object')),
  admitted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', admitted_at, '+30 days')),
  CHECK ((status = 'queued' AND lease_id IS NULL AND lease_expires_at IS NULL AND failure IS NULL AND publication_json IS NULL) OR
         (status = 'running' AND attempt BETWEEN 1 AND 3 AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_expires_at > claimed_at AND failure IS NULL AND publication_json IS NULL) OR
         (status = 'failed' AND attempt BETWEEN 1 AND 3 AND claimed_at IS NOT NULL AND lease_id IS NULL AND lease_expires_at IS NULL AND failure IS NOT NULL AND publication_json IS NULL) OR
         (status = 'published' AND attempt BETWEEN 1 AND 3 AND claimed_at IS NOT NULL AND lease_id IS NULL AND lease_expires_at IS NULL AND retry_after IS NULL AND failure IS NULL AND publication_json IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS exploration_jobs_initial_insert
BEFORE INSERT ON exploration_jobs
WHEN NEW.status != 'queued' OR NEW.attempt != 0 OR NEW.lease_id IS NOT NULL OR
  NEW.lease_expires_at IS NOT NULL OR NEW.claimed_at IS NOT NULL OR NEW.retry_after IS NOT NULL OR
  NEW.failure IS NOT NULL OR NEW.publication_json IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'exploration jobs must start queued and unclaimed');
END;
-- Keep job IDs and attempt counters as tombstones until the retention window
-- closes; otherwise delete/reinsert can reset the state machine.
CREATE TRIGGER IF NOT EXISTS exploration_jobs_retained_delete
BEFORE DELETE ON exploration_jobs
WHEN OLD.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
BEGIN
  SELECT RAISE(ABORT, 'exploration jobs retained until expiry');
END;
CREATE TRIGGER IF NOT EXISTS exploration_jobs_state_machine
BEFORE UPDATE ON exploration_jobs
WHEN NEW.job_id IS NOT OLD.job_id OR NEW.request_id IS NOT OLD.request_id OR
  NEW.admitted_at IS NOT OLD.admitted_at OR NEW.created_at IS NOT OLD.created_at OR
  NEW.expires_at IS NOT OLD.expires_at OR NOT (
  (OLD.status = 'queued' AND NEW.status = 'running' AND NEW.attempt = OLD.attempt + 1 AND NEW.attempt <= 3 AND
   NEW.claimed_at IS NOT NULL AND NEW.lease_id IS NOT NULL AND NEW.lease_expires_at > NEW.claimed_at AND
   NEW.failure IS NULL AND NEW.publication_json IS NULL) OR
  (OLD.status = 'running' AND NEW.status = 'failed' AND NEW.attempt = OLD.attempt AND
   NEW.claimed_at = OLD.claimed_at AND NEW.lease_id IS NULL AND NEW.lease_expires_at IS NULL AND
   NEW.failure IS NOT NULL AND NEW.publication_json IS NULL AND
   ((NEW.failure = 'attempts_exhausted' AND NEW.retry_after IS NULL) OR
    (NEW.failure IN ('source_unavailable','validation_failed','publication_failed','lease_expired') AND
     NEW.retry_after IS NOT NULL AND NEW.retry_after > NEW.claimed_at AND
     NEW.retry_after <= strftime('%Y-%m-%dT%H:%M:%SZ', NEW.claimed_at, '+1 day')))) OR
  (OLD.status = 'running' AND NEW.status = 'published' AND NEW.attempt = OLD.attempt AND
   NEW.claimed_at = OLD.claimed_at AND NEW.lease_id IS NULL AND NEW.lease_expires_at IS NULL AND
   NEW.failure IS NULL AND NEW.publication_json IS NOT NULL) OR
  (OLD.status = 'failed' AND NEW.status = 'queued' AND NEW.attempt = OLD.attempt AND
   OLD.attempt < 3 AND OLD.failure != 'attempts_exhausted' AND OLD.retry_after IS NOT NULL AND
   NEW.retry_after IS NULL AND
   NEW.lease_id IS NULL AND NEW.lease_expires_at IS NULL AND
   NEW.failure IS NULL AND NEW.publication_json IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid exploration job state transition');
END;
CREATE TRIGGER IF NOT EXISTS exploration_jobs_publication_shape_insert
BEFORE INSERT ON exploration_jobs
WHEN NEW.publication_json IS NOT NULL AND (
  (SELECT count(*) FROM json_each(NEW.publication_json)) != 8 OR
  json_type(NEW.publication_json, '$.artifact_key') IS NOT 'text' OR length(json_extract(NEW.publication_json, '$.artifact_key')) != 64 OR
  json_type(NEW.publication_json, '$.request_id') IS NOT 'text' OR length(json_extract(NEW.publication_json, '$.request_id')) != 64 OR
  json_type(NEW.publication_json, '$.validation_record_id') IS NOT 'text' OR json_type(NEW.publication_json, '$.publication_id') IS NOT 'text' OR
  json_type(NEW.publication_json, '$.loaded_snapshot_id') IS NOT 'text' OR json_type(NEW.publication_json, '$.coverage_record_id') IS NOT 'text' OR
  json_type(NEW.publication_json, '$.loaded_at') IS NOT 'text' OR substr(json_extract(NEW.publication_json, '$.loaded_at'), -1) != 'Z' OR
  json_type(NEW.publication_json, '$.lineage') IS NOT 'array' OR json_array_length(json_extract(NEW.publication_json, '$.lineage')) NOT BETWEEN 1 AND 32 OR
  EXISTS (SELECT 1 FROM json_each(json_extract(NEW.publication_json, '$.lineage')) WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 96)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid publication JSON shape');
END;
CREATE TRIGGER IF NOT EXISTS exploration_jobs_publication_shape_update
BEFORE UPDATE OF publication_json ON exploration_jobs
WHEN NEW.publication_json IS NOT NULL AND (
  (SELECT count(*) FROM json_each(NEW.publication_json)) != 8 OR
  json_type(NEW.publication_json, '$.artifact_key') IS NOT 'text' OR length(json_extract(NEW.publication_json, '$.artifact_key')) != 64 OR
  json_type(NEW.publication_json, '$.request_id') IS NOT 'text' OR length(json_extract(NEW.publication_json, '$.request_id')) != 64 OR
  json_type(NEW.publication_json, '$.validation_record_id') IS NOT 'text' OR json_type(NEW.publication_json, '$.publication_id') IS NOT 'text' OR
  json_type(NEW.publication_json, '$.loaded_snapshot_id') IS NOT 'text' OR json_type(NEW.publication_json, '$.coverage_record_id') IS NOT 'text' OR
  json_type(NEW.publication_json, '$.loaded_at') IS NOT 'text' OR substr(json_extract(NEW.publication_json, '$.loaded_at'), -1) != 'Z' OR
  json_type(NEW.publication_json, '$.lineage') IS NOT 'array' OR json_array_length(json_extract(NEW.publication_json, '$.lineage')) NOT BETWEEN 1 AND 32 OR
  EXISTS (SELECT 1 FROM json_each(json_extract(NEW.publication_json, '$.lineage')) WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 96)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid publication JSON shape');
END;
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
  response_json TEXT NOT NULL CHECK (length(response_json) BETWEEN 2 AND 65536 AND json_valid(response_json) AND
    json_type(response_json) = 'object' AND
    json_type(response_json, '$.version') IS NOT NULL AND json_type(response_json, '$.version') = 'integer' AND
    json_extract(response_json, '$.version') = 1 AND
    json_type(response_json, '$.kind') IS NOT NULL AND json_type(response_json, '$.kind') = 'text' AND
    json_extract(response_json, '$.kind') IN ('read_result','claim_result','ack_result') AND
    json_type(response_json, '$.payload') IS NOT NULL AND json_type(response_json, '$.payload') = 'object'),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+30 days')),
  PRIMARY KEY (scope_key, operation_type, operation_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_exploration_idempotency_expiry
  ON exploration_job_idempotency(expires_at);
CREATE TRIGGER IF NOT EXISTS exploration_idempotency_response_closed_insert
BEFORE INSERT ON exploration_job_idempotency
WHEN (SELECT count(*) FROM json_each(NEW.response_json)) != 3 OR
  json_type(NEW.response_json, '$.version') IS NOT 'integer' OR
  json_extract(NEW.response_json, '$.version') != 1 OR
  json_type(NEW.response_json, '$.kind') IS NOT 'text' OR
  json_extract(NEW.response_json, '$.kind') NOT IN ('read_result','claim_result','ack_result') OR
  json_type(NEW.response_json, '$.payload') IS NOT 'object'
BEGIN
  SELECT RAISE(ABORT, 'invalid idempotency response shape');
END;
-- Idempotency rows are immutable tombstones. B15-BRIDGE owns the retention job;
-- deletion is permitted only after expiry to preserve replay protection.
CREATE TRIGGER IF NOT EXISTS exploration_idempotency_immutable_update
BEFORE UPDATE ON exploration_job_idempotency
BEGIN
  SELECT RAISE(ABORT, 'idempotency rows are immutable');
END;
CREATE TRIGGER IF NOT EXISTS exploration_idempotency_duplicate_insert
BEFORE INSERT ON exploration_job_idempotency
WHEN EXISTS (
  SELECT 1 FROM exploration_job_idempotency existing
  WHERE existing.scope_key = NEW.scope_key AND existing.operation_type = NEW.operation_type AND
    existing.operation_id = NEW.operation_id
)
BEGIN
  SELECT RAISE(ABORT, 'idempotency operation already recorded');
END;
CREATE TRIGGER IF NOT EXISTS exploration_idempotency_immutable_delete
BEFORE DELETE ON exploration_job_idempotency
WHEN OLD.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
BEGIN
  SELECT RAISE(ABORT, 'idempotency rows retained until expiry');
END;

-- Human history retention is separate from job/tombstone retention. Explicit
-- account-scoped deletion cascades request/result/group/job state.
CREATE TABLE IF NOT EXISTS exploration_request_accounts (
  request_id TEXT PRIMARY KEY REFERENCES exploration_requests(request_id) ON DELETE CASCADE,
  account_sub TEXT NOT NULL CHECK (length(account_sub) BETWEEN 1 AND 512),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+90 days'))
);
CREATE INDEX IF NOT EXISTS idx_exploration_request_accounts_account_recent
  ON exploration_request_accounts(account_sub, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exploration_request_accounts_expiry
  ON exploration_request_accounts(expires_at);
CREATE TRIGGER IF NOT EXISTS exploration_request_accounts_owner_insert
BEFORE INSERT ON exploration_request_accounts
WHEN NOT EXISTS (
  SELECT 1 FROM exploration_requests r
  WHERE r.request_id = NEW.request_id AND r.account_sub = NEW.account_sub
)
BEGIN
  SELECT RAISE(ABORT, 'account link owner must match request owner');
END;
CREATE TRIGGER IF NOT EXISTS exploration_request_accounts_owner_update
BEFORE UPDATE ON exploration_request_accounts
WHEN NOT EXISTS (
  SELECT 1 FROM exploration_requests r
  WHERE r.request_id = NEW.request_id AND r.account_sub = NEW.account_sub
)
BEGIN
  SELECT RAISE(ABORT, 'account link owner must match request owner');
END;
