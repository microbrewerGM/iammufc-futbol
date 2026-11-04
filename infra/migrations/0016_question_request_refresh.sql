-- Source-only storage contract. Do not deploy before 0013-0015 and the
-- clarification route have landed. No request is renewed or approved by migration.
--
-- The server inserts ONE row into question_request_result_refreshes, binding
-- authenticated account, every previously read CAS field and the resolved
-- season-specific player_id. The row is consumed atomically by its trigger.
-- The replacement spec MUST first pass server catalog/coverage/code/hash checks:
-- those authorities live in compiled Worker code, not D1. SQL independently
-- fences parent/generation, current snapshot, exact stable identity and retention.
-- No client-supplied spec or account is an authorization boundary.
--
-- Separate metadata avoids non-replay-safe ALTER ADD COLUMN. Neither replay nor
-- clarification resets this request-wide count.
-- First statement: interrupted installation cannot confirm without history or
-- consume a partially installed refresh API. Readiness must also require this
-- lock to be absent and the refresh apply/history recorder triggers to exist.
CREATE TRIGGER IF NOT EXISTS question_request_results_refresh_upgrade_lock
BEFORE UPDATE ON question_request_results
BEGIN SELECT RAISE(ABORT,'request refresh migration incomplete'); END;

CREATE TABLE IF NOT EXISTS question_request_refresh_counts (
  request_id TEXT NOT NULL PRIMARY KEY REFERENCES question_requests(request_id) ON DELETE CASCADE,
  refresh_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(refresh_count)='integer' AND refresh_count BETWEEN 0 AND 3)
);
CREATE TRIGGER IF NOT EXISTS question_request_refresh_counts_initial
BEFORE INSERT ON question_request_refresh_counts
WHEN NEW.refresh_count IS NOT 0
 OR NOT EXISTS(SELECT 1 FROM question_request_results WHERE request_id=NEW.request_id)
BEGIN SELECT RAISE(ABORT,'invalid initial refresh count'); END;
CREATE TRIGGER IF NOT EXISTS question_request_refresh_counts_no_replace
BEFORE INSERT ON question_request_refresh_counts
WHEN EXISTS(SELECT 1 FROM question_request_refresh_counts WHERE request_id=NEW.request_id)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS question_request_results_refresh_count
AFTER INSERT ON question_request_results
BEGIN INSERT INTO question_request_refresh_counts(request_id) VALUES(NEW.request_id); END;
-- Install the insert hook before backfill, so an interleaved result insert
-- cannot miss both initialization paths.
INSERT OR IGNORE INTO question_request_refresh_counts(request_id)
  SELECT request_id FROM question_request_results;
CREATE TRIGGER IF NOT EXISTS question_request_refresh_counts_retention
BEFORE DELETE ON question_request_refresh_counts
WHEN EXISTS(SELECT 1 FROM question_requests WHERE request_id=OLD.request_id)
BEGIN SELECT RAISE(ABORT,'refresh count retained with parent'); END;

CREATE TABLE IF NOT EXISTS question_request_result_refreshes (
  request_id TEXT NOT NULL PRIMARY KEY REFERENCES question_requests(request_id) ON DELETE CASCADE,
  account_sub TEXT NOT NULL,
  expected_revision INTEGER NOT NULL,
  expected_parent_revision INTEGER NOT NULL,
  expected_clarification_count INTEGER NOT NULL,
  expected_spec_json TEXT NOT NULL,
  expected_expires_at TEXT NOT NULL,
  expected_refresh_count INTEGER NOT NULL,
  expected_player_id TEXT NOT NULL,
  next_spec_json TEXT NOT NULL CHECK(coalesce(json_valid(next_spec_json) AND json_type(next_spec_json)='object',0))
);
CREATE TRIGGER IF NOT EXISTS question_request_result_refreshes_validate
BEFORE INSERT ON question_request_result_refreshes
WHEN EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='question_request_results_refresh_upgrade_lock')
 OR NOT EXISTS(
 SELECT 1 FROM question_requests q
 JOIN question_request_results r ON r.request_id=q.request_id
 JOIN question_request_refresh_counts c ON c.request_id=q.request_id
 WHERE q.request_id=NEW.request_id AND q.account_sub=NEW.account_sub
 AND q.revision=NEW.expected_parent_revision AND r.request_revision=q.revision
 AND q.status IN ('filled','partial','no_data')
 AND r.revision=NEW.expected_revision
 AND r.clarification_count=NEW.expected_clarification_count
 AND r.spec_json IS NEW.expected_spec_json
 AND q.expires_at IS NEW.expected_expires_at AND r.expires_at IS q.expires_at
 AND q.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now')
 AND r.updated_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
 AND c.refresh_count=NEW.expected_refresh_count AND c.refresh_count<3
 AND r.state IN ('confirmation_required','building','in_review','released','stale')
 AND typeof(NEW.next_spec_json)='text' AND length(CAST(NEW.next_spec_json AS BLOB))<=16384
 AND json_extract(NEW.next_spec_json,'$.canonical_intent') IS json_extract(r.spec_json,'$.canonical_intent')
 AND json_extract(NEW.next_spec_json,'$.locale') IS json_extract(r.spec_json,'$.locale')
 AND json_extract(NEW.next_spec_json,'$.locale') IS q.locale
 AND json_extract(NEW.next_spec_json,'$.result_path') IS json_extract(r.spec_json,'$.result_path')
 AND json_extract(NEW.next_spec_json,'$.request_id') IS r.request_id
 AND json_extract(NEW.next_spec_json,'$.request_revision') IS r.request_revision
 AND json_extract(NEW.next_spec_json,'$.expected_cell_state') IN ('available','computable_now_queued')
 AND json_extract(NEW.next_spec_json,'$.data_snapshot_id') IS
     (SELECT snapshot_id FROM snapshots ORDER BY created_at DESC LIMIT 1)
 AND (json_extract(NEW.next_spec_json,'$.data_snapshot_id') IS NOT json_extract(r.spec_json,'$.data_snapshot_id')
   OR json_extract(NEW.next_spec_json,'$.catalog_digest') IS NOT json_extract(r.spec_json,'$.catalog_digest')
   OR json_extract(NEW.next_spec_json,'$.transform_code_version') IS NOT json_extract(r.spec_json,'$.transform_code_version')
   OR json_extract(NEW.next_spec_json,'$.renderer_version') IS NOT json_extract(r.spec_json,'$.renderer_version'))
 AND EXISTS(SELECT 1 FROM player_identities i JOIN players p ON p.player_id=i.player_id
   WHERE i.player_id=NEW.expected_player_id AND i.person_id=json_extract(json_extract(r.spec_json,'$.canonical_intent'),'$.entity_id')
   AND i.season=json_extract(json_extract(r.spec_json,'$.canonical_intent'),'$.season')
   AND p.season=i.season AND i.source_id='fpl'
   AND i.person_id='fpl:code:' || i.source_person_code)
)
BEGIN SELECT RAISE(ABORT,'request refresh conflict'); END;
CREATE TRIGGER IF NOT EXISTS question_request_result_refreshes_no_replace
BEFORE INSERT ON question_request_result_refreshes
WHEN EXISTS(SELECT 1 FROM question_request_result_refreshes WHERE request_id=NEW.request_id)
BEGIN SELECT RAISE(ABORT,'request refresh already pending'); END;
CREATE TRIGGER IF NOT EXISTS question_request_result_refreshes_no_update
BEFORE UPDATE ON question_request_result_refreshes
BEGIN SELECT RAISE(ABORT,'immutable refresh command'); END;
CREATE TRIGGER IF NOT EXISTS question_request_refresh_counts_increment
BEFORE UPDATE ON question_request_refresh_counts
WHEN NEW.request_id IS NOT OLD.request_id OR NEW.refresh_count IS NOT OLD.refresh_count+1
 OR NOT EXISTS(SELECT 1 FROM question_request_result_refreshes f
   JOIN question_request_results r ON r.request_id=f.request_id
   WHERE f.request_id=OLD.request_id AND f.expected_refresh_count=OLD.refresh_count
   AND r.revision=f.expected_revision AND r.spec_json IS f.expected_spec_json)
BEGIN SELECT RAISE(ABORT,'invalid refresh count increment'); END;

-- History records accepted proposals, never execution or inferred legacy approval.
-- A short-lived capture context can be created only while the proposal exists;
-- history can be inserted only AFTER that exact proposal transitions to building.
-- This also prevents manufacturing history for a legacy building/stale row.
CREATE TABLE IF NOT EXISTS question_request_confirmation_context (
  request_id TEXT NOT NULL PRIMARY KEY REFERENCES question_requests(request_id) ON DELETE CASCADE,
  accepted_revision INTEGER NOT NULL,
  spec_json TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS question_request_confirmations (
  request_id TEXT NOT NULL REFERENCES question_requests(request_id) ON DELETE CASCADE,
  accepted_revision INTEGER NOT NULL CHECK(typeof(accepted_revision)='integer' AND accepted_revision>=1),
  spec_json TEXT NOT NULL CHECK(coalesce(json_valid(spec_json) AND json_type(spec_json)='object',0)),
  accepted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(request_id,accepted_revision)
);
CREATE TRIGGER IF NOT EXISTS question_request_confirmation_context_insert
BEFORE INSERT ON question_request_confirmation_context
WHEN EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='question_request_results_refresh_upgrade_lock')
 OR NOT EXISTS(SELECT 1 FROM question_request_results r JOIN question_requests q ON q.request_id=r.request_id
 WHERE r.request_id=NEW.request_id AND r.state='confirmation_required'
 AND r.revision=NEW.accepted_revision AND r.spec_json IS NEW.spec_json
 AND json_extract(r.spec_json,'$.data_snapshot_id')=(SELECT snapshot_id FROM snapshots ORDER BY created_at DESC LIMIT 1)
 AND r.expires_at IS NEW.expires_at AND q.expires_at IS r.expires_at AND q.revision=r.request_revision
 AND NEW.accepted_at IS strftime('%Y-%m-%dT%H:%M:%SZ','now')
 AND r.expires_at>NEW.accepted_at AND r.response_deadline>NEW.accepted_at)
 OR EXISTS(SELECT 1 FROM question_request_confirmation_context WHERE request_id=NEW.request_id)
BEGIN SELECT RAISE(ABORT,'invalid confirmation capture'); END;
CREATE TRIGGER IF NOT EXISTS question_request_confirmation_context_no_update
BEFORE UPDATE ON question_request_confirmation_context
BEGIN SELECT RAISE(ABORT,'immutable confirmation capture'); END;
CREATE TRIGGER IF NOT EXISTS question_request_confirmation_context_retention
BEFORE DELETE ON question_request_confirmation_context
WHEN EXISTS(SELECT 1 FROM question_requests WHERE request_id=OLD.request_id)
 AND NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='question_request_results_refresh_upgrade_lock')
 AND NOT EXISTS(SELECT 1 FROM question_request_confirmations h WHERE h.request_id=OLD.request_id
   AND h.accepted_revision=OLD.accepted_revision AND h.spec_json IS OLD.spec_json
   AND h.accepted_at IS OLD.accepted_at AND h.expires_at IS OLD.expires_at)
BEGIN SELECT RAISE(ABORT,'unfinished confirmation capture'); END;
CREATE TRIGGER IF NOT EXISTS question_request_confirmations_insert
BEFORE INSERT ON question_request_confirmations
WHEN (SELECT count(*) FROM question_request_confirmations WHERE request_id=NEW.request_id)>=7
 OR NOT EXISTS(SELECT 1 FROM question_request_confirmation_context c
   JOIN question_request_results r ON r.request_id=c.request_id
   WHERE c.request_id=NEW.request_id AND c.accepted_revision=NEW.accepted_revision
   AND c.spec_json IS NEW.spec_json AND c.accepted_at IS NEW.accepted_at AND c.expires_at IS NEW.expires_at
   AND r.state='building' AND r.revision=c.accepted_revision+1
   AND r.spec_json IS c.spec_json AND r.expires_at IS c.expires_at
   AND c.accepted_at IS strftime('%Y-%m-%dT%H:%M:%SZ','now'))
 OR EXISTS(SELECT 1 FROM question_request_confirmations WHERE request_id=NEW.request_id AND accepted_revision=NEW.accepted_revision)
BEGIN SELECT RAISE(ABORT,'invalid confirmation history'); END;
CREATE TRIGGER IF NOT EXISTS question_request_confirmations_no_update
BEFORE UPDATE ON question_request_confirmations
BEGIN SELECT RAISE(ABORT,'immutable confirmation history'); END;
CREATE TRIGGER IF NOT EXISTS question_request_confirmations_retention
BEFORE DELETE ON question_request_confirmations
WHEN EXISTS(SELECT 1 FROM question_requests WHERE request_id=OLD.request_id)
BEGIN SELECT RAISE(ABORT,'confirmation history retained with parent'); END;
CREATE TRIGGER IF NOT EXISTS question_request_results_capture_confirmation
BEFORE UPDATE ON question_request_results
WHEN OLD.state='confirmation_required' AND NEW.state='building'
BEGIN
 -- RAISE(ABORT) cannot be suppressed by an outer UPDATE OR IGNORE. A table
 -- CHECK alone could otherwise skip the UPDATE after leaving capture context.
 SELECT CASE WHEN NOT coalesce(NEW.verified_json IS NULL AND NEW.lease_expires_at IS NULL
   AND typeof(NEW.revision)='integer' AND typeof(NEW.updated_at)='text' AND length(NEW.updated_at)=20
   AND strftime('%Y-%m-%dT%H:%M:%SZ',NEW.updated_at) IS NEW.updated_at,0)
   THEN RAISE(ABORT,'invalid confirmation fields') END;
 INSERT INTO question_request_confirmation_context(request_id,accepted_revision,spec_json,accepted_at,expires_at)
 VALUES(OLD.request_id,OLD.revision,OLD.spec_json,strftime('%Y-%m-%dT%H:%M:%SZ','now'),OLD.expires_at);
END;
CREATE TRIGGER IF NOT EXISTS question_request_results_record_confirmation
AFTER UPDATE ON question_request_results
WHEN OLD.state='confirmation_required' AND NEW.state='building'
BEGIN
 INSERT INTO question_request_confirmations(request_id,accepted_revision,spec_json,accepted_at,expires_at)
 SELECT request_id,accepted_revision,spec_json,accepted_at,expires_at
 FROM question_request_confirmation_context WHERE request_id=NEW.request_id;
 DELETE FROM question_request_confirmation_context WHERE request_id=NEW.request_id;
END;

-- Keep the readiness guard's exact name, with the installation lock held.
DROP TRIGGER IF EXISTS question_request_results_generation_transition;
CREATE TRIGGER question_request_results_generation_transition
BEFORE UPDATE ON question_request_results
WHEN (NEW.request_id IS NOT OLD.request_id OR NEW.created_at IS NOT OLD.created_at
 OR NEW.expires_at IS NOT OLD.expires_at OR NEW.revision IS NOT OLD.revision+1
 OR NEW.updated_at<OLD.updated_at
 OR NOT EXISTS(SELECT 1 FROM question_requests q WHERE q.request_id=NEW.request_id AND q.expires_at=NEW.expires_at)
 OR NOT coalesce(
   -- Exact legacy lifecycle predicate, including spec/generation immutability,
   -- authoritative deadlines, lease bounds and parent revision.
   (NOT coalesce((NEW.request_id IS NOT OLD.request_id OR NEW.request_revision IS NOT OLD.request_revision
 OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
 OR NEW.response_deadline IS NOT OLD.response_deadline OR NEW.spec_json IS NOT OLD.spec_json
 OR NEW.clarification_count IS NOT OLD.clarification_count OR NEW.revision IS NOT OLD.revision+1
 OR NEW.updated_at<OLD.updated_at
 OR (NEW.state NOT IN ('expired','failed','stale') AND (NEW.expires_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now') OR NEW.expires_at<=NEW.updated_at))
 OR (NEW.state='building' AND OLD.state='confirmation_required' AND OLD.response_deadline<=strftime('%Y-%m-%dT%H:%M:%SZ','now'))
 OR (NEW.state='released' AND OLD.lease_expires_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now'))
 OR (NEW.lease_expires_at IS NOT NULL AND NEW.lease_expires_at>NEW.expires_at)
 OR (NEW.state='in_review' AND NEW.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now','+900 seconds'))
 OR (NEW.state='in_review' AND NEW.lease_expires_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now'))
 OR NOT EXISTS(SELECT 1 FROM question_requests q WHERE q.request_id=NEW.request_id AND q.revision=NEW.request_revision)
 OR NOT coalesce(
   (OLD.state='confirmation_required' AND NEW.state='building' AND OLD.response_deadline>NEW.updated_at AND NEW.attempt=OLD.attempt AND NEW.lease_id IS OLD.lease_id AND NEW.lease_owner IS OLD.lease_owner)
   OR (OLD.state='building' AND NEW.state='in_review' AND OLD.attempt<3 AND NEW.attempt=OLD.attempt+1 AND NEW.lease_id IS NOT OLD.lease_id)
   OR (OLD.state='in_review' AND NEW.state IN ('released','building','failed') AND NEW.attempt=OLD.attempt AND NEW.lease_id IS OLD.lease_id AND NEW.lease_owner IS OLD.lease_owner
       AND (NEW.state!='released' OR OLD.lease_expires_at>NEW.updated_at)
       AND (NEW.state!='building' OR OLD.lease_expires_at<=NEW.updated_at AND OLD.lease_expires_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now') AND OLD.attempt<3)
       AND (NEW.state!='failed' OR OLD.attempt=3 AND OLD.lease_expires_at<=NEW.updated_at AND OLD.lease_expires_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')))
   OR (OLD.state IN ('clarification_required','confirmation_required') AND NEW.state='expired' AND OLD.response_deadline<=NEW.updated_at AND OLD.response_deadline<=strftime('%Y-%m-%dT%H:%M:%SZ','now') AND NEW.attempt=OLD.attempt AND NEW.lease_id IS OLD.lease_id AND NEW.lease_owner IS OLD.lease_owner)
   OR (OLD.state IN ('building','in_review') AND NEW.state='expired' AND OLD.expires_at<=NEW.updated_at AND OLD.expires_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now') AND NEW.attempt=OLD.attempt AND NEW.lease_id IS OLD.lease_id AND NEW.lease_owner IS OLD.lease_owner)
   OR (OLD.state='released' AND NEW.state='stale' AND NEW.attempt=OLD.attempt AND NEW.lease_id IS OLD.lease_id AND NEW.lease_owner IS OLD.lease_owner),0)),1))
   OR (
     OLD.state='clarification_required' AND NEW.state='triaging'
     AND NEW.request_revision=OLD.request_revision+1
     AND OLD.clarification_count<3 AND NEW.clarification_count=OLD.clarification_count+1
     AND OLD.response_deadline>NEW.updated_at AND OLD.response_deadline>strftime('%Y-%m-%dT%H:%M:%SZ','now')
     AND NEW.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now')
     AND NEW.spec_json IS NULL AND NEW.verified_json IS NULL AND NEW.attempt=0
     AND NEW.lease_id IS NULL AND NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL
     AND NEW.response_deadline IS min(NEW.expires_at,strftime('%Y-%m-%dT%H:%M:%SZ',NEW.updated_at,'+1 day'))
     AND EXISTS(SELECT 1 FROM question_requests q JOIN question_request_clarifications c ON c.request_id=q.request_id
       WHERE q.request_id=NEW.request_id AND q.status='received' AND q.attempt=0
       AND q.revision=NEW.request_revision AND q.updated_at=NEW.updated_at
       AND c.generation=NEW.clarification_count AND c.parent_revision=q.revision AND c.submitted_at=NEW.updated_at)
   )
   OR (
     OLD.state='triaging' AND NEW.state IN ('clarification_required','confirmation_required','unsupported','unavailable','failed')
     AND NEW.request_revision>OLD.request_revision
     AND NEW.clarification_count=OLD.clarification_count AND NEW.clarification_count BETWEEN 1 AND 3
     AND (NEW.state!='clarification_required' OR NEW.clarification_count<3)
     AND OLD.response_deadline>NEW.updated_at AND OLD.response_deadline>strftime('%Y-%m-%dT%H:%M:%SZ','now')
     AND NEW.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now')
     AND NEW.attempt=0 AND NEW.verified_json IS NULL
     AND NEW.lease_id IS NULL AND NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL
     AND ((NEW.state='confirmation_required' AND NEW.spec_json IS NOT NULL) OR (NEW.state!='confirmation_required' AND NEW.spec_json IS NULL))
     AND NEW.response_deadline IS min(NEW.expires_at,strftime('%Y-%m-%dT%H:%M:%SZ',NEW.updated_at,'+1 day'))
     AND EXISTS(SELECT 1 FROM question_requests q JOIN question_request_clarifications c ON c.request_id=q.request_id
       WHERE q.request_id=NEW.request_id AND q.revision=NEW.request_revision
       AND c.generation=NEW.clarification_count AND c.parent_revision=OLD.request_revision
       AND ((q.status IN ('filled','partial','no_data') AND NEW.state!='failed')
         OR (q.status='junk' AND NEW.state='unsupported') OR (q.status='triage_failed' AND NEW.state='failed')))
   )
   OR (
     OLD.state='triaging' AND NEW.state='expired'
     AND (OLD.response_deadline<=strftime('%Y-%m-%dT%H:%M:%SZ','now') AND OLD.response_deadline<=NEW.updated_at
       OR OLD.expires_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now') AND OLD.expires_at<=NEW.updated_at)
     AND NEW.request_revision IS OLD.request_revision AND NEW.clarification_count IS OLD.clarification_count
     AND NEW.spec_json IS OLD.spec_json AND NEW.response_deadline IS OLD.response_deadline
     AND NEW.attempt IS OLD.attempt AND NEW.lease_id IS OLD.lease_id AND NEW.lease_owner IS OLD.lease_owner
     AND NEW.lease_expires_at IS NULL AND NEW.verified_json IS NULL
   )
   OR (
     OLD.state IN ('confirmation_required','building','in_review','released') AND NEW.state='stale'
     AND NEW.request_revision IS OLD.request_revision AND NEW.clarification_count IS OLD.clarification_count
     AND NEW.spec_json IS OLD.spec_json AND NEW.response_deadline IS OLD.response_deadline
     AND NEW.attempt IS OLD.attempt AND NEW.lease_id IS OLD.lease_id AND NEW.lease_owner IS OLD.lease_owner
     AND NEW.lease_expires_at IS NULL AND NEW.verified_json IS NULL
   ),0))
 AND NOT coalesce((NEW.request_id IS OLD.request_id AND NEW.created_at IS OLD.created_at
 AND NEW.expires_at IS OLD.expires_at AND NEW.request_revision IS OLD.request_revision
 AND NEW.clarification_count IS OLD.clarification_count AND NEW.revision IS OLD.revision+1
 AND NEW.updated_at IS strftime('%Y-%m-%dT%H:%M:%SZ','now') AND NEW.updated_at>=OLD.updated_at
 AND OLD.expires_at>NEW.updated_at
 AND OLD.state IN ('confirmation_required','building','in_review','released','stale')
 AND NEW.state='confirmation_required' AND NEW.attempt IS 0
 AND NEW.verified_json IS NULL AND NEW.lease_id IS NULL AND NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL
 AND NEW.response_deadline IS min(OLD.expires_at,strftime('%Y-%m-%dT%H:%M:%SZ','now','+1 day'))
 AND EXISTS(SELECT 1 FROM question_request_result_refreshes f
   JOIN question_request_refresh_counts c ON c.request_id=f.request_id
   JOIN question_requests q ON q.request_id=f.request_id
   WHERE f.request_id=OLD.request_id AND f.expected_revision=OLD.revision
   AND f.expected_parent_revision=OLD.request_revision AND q.revision=OLD.request_revision
   AND f.expected_clarification_count=OLD.clarification_count AND f.expected_spec_json IS OLD.spec_json
   AND f.expected_expires_at IS OLD.expires_at AND q.expires_at IS OLD.expires_at
   AND q.account_sub=f.account_sub AND q.status IN ('filled','partial','no_data')
   AND c.refresh_count=f.expected_refresh_count+1 AND c.refresh_count BETWEEN 1 AND 3
   AND NEW.spec_json IS f.next_spec_json
   AND json_extract(NEW.spec_json,'$.data_snapshot_id') IS
     (SELECT snapshot_id FROM snapshots ORDER BY created_at DESC LIMIT 1))),0)
BEGIN SELECT RAISE(ABORT,'invalid request result generation transition'); END;

CREATE TRIGGER IF NOT EXISTS question_request_result_refreshes_apply
AFTER INSERT ON question_request_result_refreshes
BEGIN
 UPDATE question_request_refresh_counts SET refresh_count=refresh_count+1 WHERE request_id=NEW.request_id;
 UPDATE question_request_results SET state='confirmation_required',spec_json=NEW.next_spec_json,
   revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),
   response_deadline=min(expires_at,strftime('%Y-%m-%dT%H:%M:%SZ','now','+1 day')),
   attempt=0,verified_json=NULL,lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL
 WHERE request_id=NEW.request_id AND revision=NEW.expected_revision;
 -- Conflict policy on the caller's INSERT can propagate into trigger writes.
 -- Assert the entire result, so OR IGNORE cannot commit a count-only refresh.
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM question_request_results r
   JOIN question_request_refresh_counts c ON c.request_id=r.request_id
   WHERE r.request_id=NEW.request_id AND r.revision=NEW.expected_revision+1
   AND r.state='confirmation_required' AND r.spec_json IS NEW.next_spec_json
   AND c.refresh_count=NEW.expected_refresh_count+1)
   THEN RAISE(ABORT,'incomplete request refresh') END;
 DELETE FROM question_request_result_refreshes WHERE request_id=NEW.request_id;
END;
-- Normal operations consume these rows in the SAME statement. Anything retained
-- from an interrupted install is uncommitted validation, never reusable authority.
DELETE FROM question_request_result_refreshes;
DELETE FROM question_request_confirmation_context;
DROP TRIGGER IF EXISTS question_request_results_refresh_upgrade_lock;
