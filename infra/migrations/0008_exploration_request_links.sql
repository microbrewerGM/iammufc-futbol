-- B15-STORE-FIX4: account-neutral exploration storage (ADR-0009 amendment).
--
-- DESIGN CHOICE: replace, do not patch. 0007 keyed the canonical request to one
-- account (exploration_requests.account_sub, owner-match triggers, cascading
-- account deletion), so a second account asking the same request, or the first
-- account deleting its history, could not share or preserve the job and result.
-- No worker code reads or writes the 0007 tables and the dev tables are empty,
-- confirmed in the repository at redesign HEAD da4d6d4; the lead ruling accepts
-- dropping those legacy objects because no code path writes them yet. This
-- migration drops those legacy objects and creates new account-neutral
-- tables under new names (exploration_shared_*, exploration_bridge_operations,
-- exploration_request_links) that carry every 0007 constraint, trigger and
-- index. 0007 itself is unedited and is no longer applied by deploy.yml or
-- package.json d1:seed; if an older database still has it, this file removes it.
--
-- IDEMPOTENT: the DROPs name only the legacy 0007 names, and every new object is
-- CREATE ... IF NOT EXISTS, so re-applying after success changes nothing and
-- never touches rows in the new tables. Legacy rows are intentionally not
-- backfilled (empty in dev; a conditional copy cannot be written in plain SQL
-- when the legacy tables may be absent).
--
-- ACCOUNT IDENTITY lives only in exploration_request_links (account_sub, with an
-- independent 90-day retention window per account). Request, job, result, group,
-- tombstone and operation tables carry no account column. Account deletion or
-- unlink deletes only that account's link rows. A trigger then removes a shared
-- request (cascading to its job, result and groups) only when no link remains and
-- no live lease is held; the collector statements at the end cover the rest.
-- Admission must insert the shared request and its first link in one D1 batch,
-- because a request with no link is collectable.
--
-- JOB STATE MACHINE: as 0007 (queued->running->failed|published, failed->queued)
-- plus two server-only fields the BridgeStore port needs: lease_owner (a stable
-- non-secret service scope key, never a credential) and revision (every update
-- must increase it, which backs the adapter's compare-and-set).
--
-- Jobs and results expire after 30 days, request links after 90 days per
-- account; the bridge owns time-based deletion of jobs and results.

DROP TABLE IF EXISTS exploration_result_groups;
DROP TABLE IF EXISTS exploration_results;
DROP TABLE IF EXISTS exploration_jobs;
DROP TABLE IF EXISTS exploration_request_accounts;
DROP TABLE IF EXISTS exploration_requests;
DROP TABLE IF EXISTS exploration_job_tombstones;
DROP TABLE IF EXISTS exploration_job_idempotency;

-- Canonical request. No owner column; links own account association and retention.
CREATE TABLE IF NOT EXISTS exploration_shared_requests (
  request_id TEXT PRIMARY KEY CHECK (length(request_id) = 64 AND request_id NOT GLOB '*[^0-9a-f]*'),
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
  created_at TEXT NOT NULL CHECK (length(created_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', created_at) = created_at)
);

CREATE TRIGGER IF NOT EXISTS exploration_shared_requests_closed_insert
BEFORE INSERT ON exploration_shared_requests
WHEN (SELECT count(*) FROM json_each(NEW.request_json)) != 7 OR
  json_type(NEW.request_json, '$.version') IS NULL OR json_type(NEW.request_json, '$.family') IS NULL OR
  json_type(NEW.request_json, '$.as_of') IS NULL OR json_type(NEW.request_json, '$.population') IS NULL OR
  json_type(NEW.request_json, '$.joining_basis') IS NULL OR json_type(NEW.request_json, '$.academy_basis') IS NULL OR
  json_type(NEW.request_json, '$.visualization') IS NULL
BEGIN
  SELECT RAISE(ABORT, 'invalid arrival-manager request shape');
END;
CREATE TRIGGER IF NOT EXISTS exploration_shared_requests_closed_update
BEFORE UPDATE OF request_json ON exploration_shared_requests
WHEN (SELECT count(*) FROM json_each(NEW.request_json)) != 7 OR
  json_type(NEW.request_json, '$.version') IS NULL OR json_type(NEW.request_json, '$.family') IS NULL OR
  json_type(NEW.request_json, '$.as_of') IS NULL OR json_type(NEW.request_json, '$.population') IS NULL OR
  json_type(NEW.request_json, '$.joining_basis') IS NULL OR json_type(NEW.request_json, '$.academy_basis') IS NULL OR
  json_type(NEW.request_json, '$.visualization') IS NULL
BEGIN
  SELECT RAISE(ABORT, 'invalid arrival-manager request shape');
END;

-- Per-account history link. The only table that names an account.
CREATE TABLE IF NOT EXISTS exploration_request_links (
  request_id TEXT NOT NULL REFERENCES exploration_shared_requests(request_id) ON DELETE CASCADE,
  account_sub TEXT NOT NULL CHECK (length(account_sub) BETWEEN 1 AND 512),
  created_at TEXT NOT NULL CHECK (length(created_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', created_at) = created_at),
  expires_at TEXT NOT NULL CHECK (length(expires_at) = 20 AND expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+90 days')),
  PRIMARY KEY (request_id, account_sub)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_exploration_request_links_account_recent
  ON exploration_request_links(account_sub, created_at DESC, request_id);
CREATE INDEX IF NOT EXISTS idx_exploration_request_links_expiry
  ON exploration_request_links(expires_at);
CREATE TRIGGER IF NOT EXISTS exploration_request_links_shared_insert
BEFORE INSERT ON exploration_request_links
WHEN NOT EXISTS (SELECT 1 FROM exploration_shared_requests AS r WHERE r.request_id = NEW.request_id)
BEGIN
  SELECT RAISE(ABORT, 'account link must name an existing shared request');
END;
CREATE TRIGGER IF NOT EXISTS exploration_request_links_identity_update
BEFORE UPDATE ON exploration_request_links
WHEN NEW.request_id IS NOT OLD.request_id OR NEW.account_sub IS NOT OLD.account_sub
BEGIN
  SELECT RAISE(ABORT, 'account link identity is immutable');
END;

-- Derived group rows contain stable contract IDs, finite coverage and lineage;
-- no names or source roster/transfer/tenure payloads. Group artifacts are bounded
-- to 100 assigned/unknown members by the contract and expire after 30 days.
CREATE TABLE IF NOT EXISTS exploration_shared_results (
  request_id TEXT PRIMARY KEY REFERENCES exploration_shared_requests(request_id) ON DELETE CASCADE,
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
  created_at TEXT NOT NULL CHECK (length(created_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', created_at) = created_at),
  expires_at TEXT NOT NULL CHECK (length(expires_at) = 20 AND expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+30 days')),
  CHECK (json_array_length(assigned_json) + json_array_length(unknown_json) = population_count),
  CHECK (feasibility != 'available' OR (coverage != 'missing' AND roster_snapshot_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_exploration_shared_results_expiry ON exploration_shared_results(expires_at);

-- Validate every nested result object against the closed v1 contract.
CREATE TRIGGER IF NOT EXISTS exploration_shared_results_privacy_insert
BEFORE INSERT ON exploration_shared_results
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
CREATE TRIGGER IF NOT EXISTS exploration_shared_results_privacy_update
BEFORE UPDATE OF assigned_json, unknown_json, lineage_json ON exploration_shared_results
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

CREATE TABLE IF NOT EXISTS exploration_shared_result_groups (
  request_id TEXT NOT NULL REFERENCES exploration_shared_results(request_id) ON DELETE CASCADE,
  manager_id TEXT NOT NULL CHECK (length(manager_id) BETWEEN 1 AND 96 AND manager_id NOT GLOB '*[^a-z0-9:_-]*'),
  member_count INTEGER NOT NULL CHECK (typeof(member_count) = 'integer' AND member_count BETWEEN 1 AND 100),
  members_json TEXT NOT NULL CHECK (length(members_json) BETWEEN 2 AND 65536 AND json_valid(members_json) AND json_type(members_json) = 'array' AND json_array_length(members_json) = member_count),
  lineage_json TEXT NOT NULL CHECK (length(lineage_json) BETWEEN 2 AND 4096 AND json_valid(lineage_json) AND json_type(lineage_json) = 'array' AND json_array_length(lineage_json) BETWEEN 1 AND 32),
  PRIMARY KEY (request_id, manager_id)
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS exploration_shared_result_groups_privacy_insert
BEFORE INSERT ON exploration_shared_result_groups
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
CREATE TRIGGER IF NOT EXISTS exploration_shared_result_groups_privacy_update
BEFORE UPDATE OF members_json, lineage_json ON exploration_shared_result_groups
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

CREATE TABLE IF NOT EXISTS exploration_shared_jobs (
  job_id TEXT PRIMARY KEY CHECK (length(job_id) = 64 AND job_id NOT GLOB '*[^0-9a-f]*'),
  request_id TEXT NOT NULL UNIQUE REFERENCES exploration_shared_requests(request_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued','running','failed','published')),
  attempt INTEGER NOT NULL CHECK (typeof(attempt) = 'integer' AND attempt BETWEEN 0 AND 3),
  lease_id TEXT CHECK (lease_id IS NULL OR (length(lease_id) BETWEEN 1 AND 96 AND lease_id NOT GLOB '*[^a-z0-9:_-]*')),
  lease_owner TEXT CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 96),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (typeof(revision) = 'integer' AND revision >= 1),
  lease_expires_at TEXT CHECK (lease_expires_at IS NULL OR (length(lease_expires_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', lease_expires_at) = lease_expires_at)),
  claimed_at TEXT CHECK (claimed_at IS NULL OR (length(claimed_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', claimed_at) = claimed_at)),
  retry_after TEXT CHECK (retry_after IS NULL OR (length(retry_after) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', retry_after) = retry_after)),
  failure TEXT CHECK (failure IS NULL OR failure IN ('source_unavailable','validation_failed','publication_failed','lease_expired','attempts_exhausted')),
  publication_json TEXT CHECK (publication_json IS NULL OR (length(publication_json) BETWEEN 2 AND 16384 AND json_valid(publication_json) AND json_type(publication_json) = 'object')),
  admitted_at TEXT NOT NULL CHECK (length(admitted_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', admitted_at) = admitted_at),
  created_at TEXT NOT NULL CHECK (length(created_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', created_at) = created_at),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', updated_at) = updated_at),
  expires_at TEXT NOT NULL CHECK (expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', admitted_at, '+30 days')),
  CHECK ((status = 'queued' AND lease_id IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL AND failure IS NULL AND publication_json IS NULL) OR
         (status = 'running' AND attempt BETWEEN 1 AND 3 AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_expires_at > claimed_at AND failure IS NULL AND publication_json IS NULL) OR
         (status = 'failed' AND attempt BETWEEN 1 AND 3 AND claimed_at IS NOT NULL AND lease_id IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NULL AND failure IS NOT NULL AND publication_json IS NULL) OR
         (status = 'published' AND attempt BETWEEN 1 AND 3 AND claimed_at IS NOT NULL AND lease_id IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NULL AND retry_after IS NULL AND failure IS NULL AND publication_json IS NOT NULL))
);
-- Opaque deletion markers keep a collected job's IDs from being reset or
-- reinserted for 30 days (the idempotency-row window) while unlink and orphan
-- collection proceed immediately. They carry no account identity.
CREATE TABLE IF NOT EXISTS exploration_shared_job_tombstones (
  job_id TEXT NOT NULL CHECK (length(job_id) = 64 AND job_id NOT GLOB '*[^0-9a-f]*'),
  request_id TEXT NOT NULL CHECK (length(request_id) = 64 AND request_id NOT GLOB '*[^0-9a-f]*'),
  deleted_at TEXT NOT NULL CHECK (length(deleted_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', deleted_at) = deleted_at),
  PRIMARY KEY (job_id, request_id)
);
CREATE TRIGGER IF NOT EXISTS exploration_shared_job_tombstones_immutable
BEFORE UPDATE ON exploration_shared_job_tombstones
BEGIN
  SELECT RAISE(ABORT, 'job tombstones are immutable during retention');
END;
CREATE TRIGGER IF NOT EXISTS exploration_shared_job_tombstones_retention_monotonic
BEFORE INSERT ON exploration_shared_job_tombstones
WHEN EXISTS (
  SELECT 1 FROM exploration_shared_job_tombstones existing
  WHERE existing.job_id = NEW.job_id AND existing.request_id = NEW.request_id AND
    existing.deleted_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-30 days') AND
    NEW.deleted_at < existing.deleted_at
)
BEGIN
  SELECT RAISE(ABORT, 'job tombstone retention cannot be shortened');
END;
CREATE INDEX IF NOT EXISTS idx_exploration_shared_job_tombstones_deleted
  ON exploration_shared_job_tombstones(deleted_at);
CREATE TRIGGER IF NOT EXISTS exploration_shared_job_tombstones_retained
BEFORE DELETE ON exploration_shared_job_tombstones
WHEN OLD.deleted_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-30 days')
BEGIN
  SELECT RAISE(ABORT, 'job tombstones retained for 30 days');
END;
CREATE TRIGGER IF NOT EXISTS exploration_shared_jobs_initial_insert
BEFORE INSERT ON exploration_shared_jobs
WHEN EXISTS (SELECT 1 FROM exploration_shared_job_tombstones
    WHERE (job_id = NEW.job_id OR request_id = NEW.request_id) AND
      deleted_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-30 days')) OR
  NEW.status != 'queued' OR NEW.attempt != 0 OR NEW.lease_id IS NOT NULL OR NEW.lease_owner IS NOT NULL OR
  NEW.lease_expires_at IS NOT NULL OR NEW.claimed_at IS NOT NULL OR NEW.retry_after IS NOT NULL OR
  NEW.failure IS NOT NULL OR NEW.publication_json IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'exploration jobs must start queued and unclaimed');
END;
-- Keep only opaque identifiers after deletion; never block link removal. REPLACE
-- restarts the 30-day window if the same pair is collected again.
CREATE TRIGGER IF NOT EXISTS exploration_shared_jobs_tombstone_delete
AFTER DELETE ON exploration_shared_jobs
BEGIN
  INSERT OR REPLACE INTO exploration_shared_job_tombstones (job_id, request_id, deleted_at)
  VALUES (OLD.job_id, OLD.request_id, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS exploration_shared_jobs_state_machine
BEFORE UPDATE ON exploration_shared_jobs
WHEN NEW.job_id IS NOT OLD.job_id OR NEW.request_id IS NOT OLD.request_id OR
  NEW.admitted_at IS NOT OLD.admitted_at OR NEW.created_at IS NOT OLD.created_at OR
  NEW.expires_at IS NOT OLD.expires_at OR NEW.revision != OLD.revision + 1 OR NOT (
  (OLD.status = 'queued' AND NEW.status = 'running' AND NEW.attempt = OLD.attempt + 1 AND NEW.attempt <= 3 AND
   NEW.claimed_at IS NOT NULL AND NEW.lease_id IS NOT NULL AND NEW.lease_expires_at > NEW.claimed_at AND
   NEW.failure IS NULL AND NEW.publication_json IS NULL) OR
  (OLD.status = 'running' AND NEW.status = 'failed' AND NEW.attempt = OLD.attempt AND
   NEW.claimed_at = OLD.claimed_at AND NEW.lease_id IS OLD.lease_id AND NEW.lease_owner IS OLD.lease_owner AND NEW.lease_expires_at IS NULL AND
   NEW.failure IS NOT NULL AND NEW.publication_json IS NULL AND
   ((NEW.failure = 'attempts_exhausted' AND NEW.retry_after IS NULL) OR
    (NEW.failure IN ('source_unavailable','validation_failed','publication_failed','lease_expired') AND
     NEW.retry_after IS NOT NULL AND NEW.retry_after > NEW.claimed_at AND
     NEW.retry_after <= strftime('%Y-%m-%dT%H:%M:%SZ', NEW.claimed_at, '+1 day')))) OR
  (OLD.status = 'running' AND NEW.status = 'published' AND NEW.attempt = OLD.attempt AND
   NEW.claimed_at = OLD.claimed_at AND NEW.lease_id IS OLD.lease_id AND NEW.lease_owner IS OLD.lease_owner AND NEW.lease_expires_at IS NULL AND
   NEW.failure IS NULL AND NEW.publication_json IS NOT NULL) OR
  (OLD.status = 'failed' AND NEW.status = 'queued' AND NEW.attempt = OLD.attempt AND
   OLD.attempt < 3 AND OLD.failure != 'attempts_exhausted' AND OLD.retry_after IS NOT NULL AND
   NEW.retry_after IS NULL AND
   NEW.lease_id IS NULL AND NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL AND
   NEW.failure IS NULL AND NEW.publication_json IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid exploration job state transition');
END;
-- Any running-job mutation is fenced by the exact prior revision and lease
-- identity; a transition out of running must carry both lease values through
-- the update. Terminal rows retain the lease values as fencing and audit data,
-- while lease_expires_at is cleared so they do not represent a live lease.
CREATE TRIGGER IF NOT EXISTS exploration_shared_jobs_running_lease_fence
BEFORE UPDATE ON exploration_shared_jobs
WHEN OLD.status = 'running' AND (
  NEW.revision != OLD.revision + 1 OR
  NEW.lease_id IS NOT OLD.lease_id OR NEW.lease_owner IS NOT OLD.lease_owner
)
BEGIN
  SELECT RAISE(ABORT, 'running job update must match lease and revision');
END;
CREATE TRIGGER IF NOT EXISTS exploration_shared_jobs_publication_shape_insert
BEFORE INSERT ON exploration_shared_jobs
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
CREATE TRIGGER IF NOT EXISTS exploration_shared_jobs_publication_shape_update
BEFORE UPDATE OF publication_json ON exploration_shared_jobs
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
CREATE INDEX IF NOT EXISTS idx_exploration_shared_jobs_due
  ON exploration_shared_jobs(status, retry_after, admitted_at, job_id);
CREATE INDEX IF NOT EXISTS idx_exploration_shared_jobs_expiry ON exploration_shared_jobs(expires_at);

-- Operation IDs are service-scoped opaque references. `service` is the stable,
-- non-secret BridgeStore service key; `scope_key` is a separate non-secret
-- grouping value. Never persist credentials.
-- Rows are account-neutral and independent of request lifetime, so replay
-- protection survives orphan collection until each row's own expiry.
CREATE TABLE IF NOT EXISTS exploration_bridge_operations (
  service TEXT NOT NULL CHECK (length(service) BETWEEN 1 AND 96),
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
  lease_id TEXT CHECK (lease_id IS NULL OR (length(lease_id) BETWEEN 1 AND 96 AND lease_id NOT GLOB '*[^a-z0-9:_-]*')),
  created_at TEXT NOT NULL CHECK (length(created_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', created_at) = created_at),
  expires_at TEXT NOT NULL CHECK (length(expires_at) = 20 AND expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+30 days')),
  PRIMARY KEY (service, operation_type, operation_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_exploration_bridge_operations_expiry
  ON exploration_bridge_operations(expires_at);
CREATE TRIGGER IF NOT EXISTS exploration_bridge_operations_response_closed_insert
BEFORE INSERT ON exploration_bridge_operations
WHEN (SELECT count(*) FROM json_each(NEW.response_json)) != 3 OR
  json_type(NEW.response_json, '$.version') IS NOT 'integer' OR
  json_extract(NEW.response_json, '$.version') != 1 OR
  json_type(NEW.response_json, '$.kind') IS NOT 'text' OR
  json_extract(NEW.response_json, '$.kind') NOT IN ('read_result','claim_result','ack_result') OR
  json_type(NEW.response_json, '$.payload') IS NOT 'object'
BEGIN
  SELECT RAISE(ABORT, 'invalid idempotency response shape');
END;
-- Operation rows are immutable tombstones; deletion is permitted only after
-- expiry to preserve replay protection.
CREATE TRIGGER IF NOT EXISTS exploration_bridge_operations_immutable_update
BEFORE UPDATE ON exploration_bridge_operations
BEGIN
  SELECT RAISE(ABORT, 'idempotency rows are immutable');
END;
CREATE TRIGGER IF NOT EXISTS exploration_bridge_operations_duplicate_insert
BEFORE INSERT ON exploration_bridge_operations
WHEN EXISTS (
  SELECT 1 FROM exploration_bridge_operations existing
  WHERE existing.service = NEW.service AND existing.operation_type = NEW.operation_type AND
    existing.operation_id = NEW.operation_id
)
BEGIN
  SELECT RAISE(ABORT, 'idempotency operation already recorded');
END;
CREATE TRIGGER IF NOT EXISTS exploration_bridge_operations_immutable_delete
BEFORE DELETE ON exploration_bridge_operations
WHEN OLD.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
BEGIN
  SELECT RAISE(ABORT, 'idempotency rows retained until expiry');
END;

-- Orphan collection. A shared request is collectable only when no account links
-- it and no live lease is held on its job; a running job whose lease has expired
-- is collectable. The trigger collects immediately when the last link goes (an
-- unlink, an account deletion or a retention purge); the collector block below
-- sweeps requests that were held back by a live lease or orphaned another way.
CREATE VIEW IF NOT EXISTS exploration_collectable_requests AS
SELECT r.request_id, r.created_at
FROM exploration_shared_requests AS r
WHERE NOT EXISTS (SELECT 1 FROM exploration_request_links AS l WHERE l.request_id = r.request_id)
  AND NOT EXISTS (
    SELECT 1 FROM exploration_shared_jobs AS j
    WHERE j.request_id = r.request_id AND j.status = 'running' AND
      j.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  );
CREATE TRIGGER IF NOT EXISTS exploration_request_links_orphan_collect
AFTER DELETE ON exploration_request_links
WHEN EXISTS (SELECT 1 FROM exploration_collectable_requests WHERE request_id = OLD.request_id)
BEGIN
  DELETE FROM exploration_shared_requests WHERE request_id = OLD.request_id;
END;
CREATE TRIGGER IF NOT EXISTS exploration_shared_jobs_orphan_collect
AFTER UPDATE ON exploration_shared_jobs
WHEN NOT EXISTS (SELECT 1 FROM exploration_request_links WHERE request_id = NEW.request_id)
  AND NOT (NEW.status = 'running' AND NEW.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
BEGIN
  DELETE FROM exploration_shared_requests WHERE request_id = NEW.request_id;
END;

-- COLLECTOR statements (run on a schedule; the migration test executes exactly
-- the text between the markers, so this block and the tested SQL cannot drift).
-- 1. Purge expired per-account links (bounded); the trigger then collects any
--    request this leaves orphaned.
-- 2. Sweep requests the trigger had to leave in place while a lease was live,
--    after that lease expires.
-- 3. Purge job tombstones older than their 30-day window.
-- COLLECTOR-BEGIN
-- DELETE FROM exploration_request_links WHERE (request_id, account_sub) IN (SELECT request_id, account_sub FROM exploration_request_links WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now') ORDER BY expires_at, request_id, account_sub LIMIT 100);
-- DELETE FROM exploration_shared_requests WHERE request_id IN (SELECT request_id FROM exploration_collectable_requests ORDER BY created_at, request_id LIMIT 100);
-- DELETE FROM exploration_shared_job_tombstones WHERE deleted_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-30 days');
-- COLLECTOR-END
