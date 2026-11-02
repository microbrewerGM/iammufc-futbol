-- Bounded clarification generations. Original question identity/text/hash stay
-- immutable. This private table holds only the latest full replacement question;
-- it is untrusted input with the parent's ownership and original 90-day retention.
-- NFC normalization remains application-enforced, as in0010.
-- New triggers preserve the original predicates. Install them BEFORE dropping
-- the old triggers: a partial application stays restrictive, never unguarded.
CREATE TABLE IF NOT EXISTS question_request_clarifications (
  request_id TEXT NOT NULL PRIMARY KEY REFERENCES question_requests(request_id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND 3),
  parent_revision INTEGER NOT NULL CHECK(typeof(parent_revision)='integer' AND parent_revision>=2),
  text TEXT NOT NULL CHECK(typeof(text)='text' AND length(text) BETWEEN 1 AND 500
    AND length(CAST(text AS BLOB))<=2000 AND instr(CAST(text AS BLOB),x'00')=0
    AND text NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1564) || char(6158) ||
      char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8303) ||
      char(65279) || char(65529) || '-' || char(65531) || char(917504) || '-' || char(917631) || ']*')),
  submitted_at TEXT NOT NULL CHECK(typeof(submitted_at)='text' AND length(submitted_at)=20
    AND strftime('%Y-%m-%dT%H:%M:%SZ',submitted_at) IS submitted_at)
);
CREATE TRIGGER IF NOT EXISTS question_request_clarifications_insert
BEFORE INSERT ON question_request_clarifications
WHEN NEW.generation IS NOT 1
 OR coalesce(NEW.submitted_at NOT BETWEEN strftime('%Y-%m-%dT%H:%M:%SZ','now','-300 seconds') AND strftime('%Y-%m-%dT%H:%M:%SZ','now','+300 seconds'),1)
 OR NOT EXISTS(SELECT 1 FROM question_requests q JOIN question_request_results r ON r.request_id=q.request_id
   WHERE q.request_id=NEW.request_id AND q.status='received' AND q.revision=NEW.parent_revision
   AND q.updated_at=NEW.submitted_at AND q.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now')
   AND r.state='clarification_required' AND r.request_revision+1=q.revision
   AND r.clarification_count+1=NEW.generation AND r.response_deadline>NEW.submitted_at
   AND r.response_deadline>strftime('%Y-%m-%dT%H:%M:%SZ','now'))
BEGIN SELECT RAISE(ABORT,'invalid request clarification'); END;
CREATE TRIGGER IF NOT EXISTS question_request_clarifications_update
BEFORE UPDATE ON question_request_clarifications
WHEN NEW.request_id IS NOT OLD.request_id OR NEW.generation IS NOT OLD.generation+1
 OR NEW.parent_revision<=OLD.parent_revision OR NEW.submitted_at<OLD.submitted_at
 OR coalesce(NEW.submitted_at NOT BETWEEN strftime('%Y-%m-%dT%H:%M:%SZ','now','-300 seconds') AND strftime('%Y-%m-%dT%H:%M:%SZ','now','+300 seconds'),1)
 OR NOT EXISTS(SELECT 1 FROM question_requests q JOIN question_request_results r ON r.request_id=q.request_id
   WHERE q.request_id=NEW.request_id AND q.status='received' AND q.revision=NEW.parent_revision
   AND q.updated_at=NEW.submitted_at AND q.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now')
   AND r.state='clarification_required' AND r.request_revision+1=q.revision
   AND r.clarification_count+1=NEW.generation AND r.response_deadline>NEW.submitted_at
   AND r.response_deadline>strftime('%Y-%m-%dT%H:%M:%SZ','now'))
BEGIN SELECT RAISE(ABORT,'invalid request clarification'); END;
CREATE TRIGGER IF NOT EXISTS question_request_clarifications_no_replace
BEFORE INSERT ON question_request_clarifications
WHEN EXISTS(SELECT 1 FROM question_request_clarifications WHERE request_id=NEW.request_id)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS question_request_clarifications_retention
BEFORE DELETE ON question_request_clarifications
WHEN EXISTS(SELECT 1 FROM question_requests WHERE request_id=OLD.request_id AND expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now'))
BEGIN SELECT RAISE(ABORT,'clarification retained with parent'); END;

-- Clearing the old claimed_at is allowed only on the reset path. The state
-- guard below independently requires the complete live clarification predicate.
CREATE TRIGGER IF NOT EXISTS question_requests_clarification_clock_update
BEFORE UPDATE ON question_requests
WHEN (NEW.updated_at IS NOT OLD.updated_at AND coalesce(NEW.updated_at NOT BETWEEN
    strftime('%Y-%m-%dT%H:%M:%SZ','now','-300 seconds') AND strftime('%Y-%m-%dT%H:%M:%SZ','now','+300 seconds'),1))
 OR (NEW.claimed_at IS NOT OLD.claimed_at
   AND NOT (NEW.claimed_at IS NULL AND OLD.status IN ('filled','partial','no_data') AND NEW.status='received' AND NEW.attempt=0)
   AND coalesce(NEW.claimed_at NOT BETWEEN strftime('%Y-%m-%dT%H:%M:%SZ','now','-300 seconds') AND strftime('%Y-%m-%dT%H:%M:%SZ','now','+300 seconds'),1))
BEGIN SELECT RAISE(ABORT,'question request timestamps must be within 300 seconds of now'); END;

CREATE TRIGGER IF NOT EXISTS question_requests_clarification_state_machine
BEFORE UPDATE ON question_requests
WHEN NEW.request_id IS NOT OLD.request_id OR NEW.account_sub IS NOT OLD.account_sub OR
  NEW.text IS NOT OLD.text OR NEW.locale IS NOT OLD.locale OR NEW.text_hash IS NOT OLD.text_hash OR
  NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at OR
  NEW.revision IS NOT OLD.revision + 1 OR coalesce(NEW.updated_at < OLD.updated_at, 1) OR NOT coalesce((
  -- claim: a new lease of at most 900 s, attempt + 1, only once any backoff is due.
  (OLD.status = 'received' AND NEW.status = 'triaging' AND OLD.attempt < 3 AND NEW.attempt = OLD.attempt + 1 AND
   NEW.claimed_at IS NOT NULL AND (OLD.claimed_at IS NULL OR NEW.claimed_at >= OLD.claimed_at) AND
   (OLD.retry_after IS NULL OR OLD.retry_after <= NEW.claimed_at) AND
   NEW.lease_id IS NOT NULL AND NEW.lease_owner IS NOT NULL AND (OLD.lease_id IS NULL OR NEW.lease_id != OLD.lease_id) AND
   NEW.lease_expires_at IS NOT NULL AND NEW.lease_expires_at > NEW.claimed_at AND
   NEW.lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%SZ', NEW.claimed_at, '+900 seconds') AND NEW.retry_after IS NULL AND
   NEW.verdict_json IS NULL AND NEW.exploration_request_id IS NULL) OR
  -- sweep (lease expired) or ack failed with attempts left: back to received with backoff.
  (OLD.status = 'triaging' AND NEW.status = 'received' AND OLD.attempt < 3 AND NEW.attempt = OLD.attempt AND
   NEW.claimed_at IS OLD.claimed_at AND NEW.lease_expires_at IS NULL AND NEW.retry_after IS NOT NULL AND
   NEW.verdict_json IS NULL AND NEW.exploration_request_id IS NULL) OR
  -- sweep or ack failed on the last attempt.
  (OLD.status = 'triaging' AND NEW.status = 'triage_failed' AND OLD.attempt = 3 AND NEW.attempt = 3 AND
   NEW.claimed_at IS OLD.claimed_at AND NEW.lease_expires_at IS NULL AND NEW.retry_after IS NULL AND
   NEW.verdict_json IS NULL AND NEW.exploration_request_id IS NULL) OR
  -- ack with a valid verdict.
  (OLD.status = 'triaging' AND NEW.status IN ('junk','triaged') AND NEW.attempt = OLD.attempt AND
   NEW.claimed_at IS OLD.claimed_at AND NEW.lease_expires_at IS NULL AND NEW.retry_after IS NULL AND
   NEW.verdict_json IS NOT NULL AND NEW.exploration_request_id IS NULL) OR
  -- ack batch (triaged) or sweep (queued) settles; the verdict and lease audit stay fixed.
  (((OLD.status = 'triaged' AND NEW.status IN ('queued','filled','partial','no_data') AND
     (NEW.status = 'queued' OR NEW.exploration_request_id IS NULL)) OR
    (OLD.status = 'queued' AND NEW.status IN ('filled','partial','no_data') AND
     NEW.exploration_request_id IS OLD.exploration_request_id)) AND
   NEW.attempt = OLD.attempt AND NEW.claimed_at IS OLD.claimed_at AND
   NEW.lease_id IS OLD.lease_id AND NEW.lease_owner IS OLD.lease_owner AND
   NEW.lease_expires_at IS NULL AND NEW.retry_after IS NULL AND NEW.verdict_json IS OLD.verdict_json)
 OR
  -- Requeue preserves the original text/hash and requires a live clarification.
  (OLD.status IN ('filled','partial','no_data') AND NEW.status='received'
   AND NEW.attempt=0 AND NEW.verdict_json IS NULL AND NEW.exploration_request_id IS NULL
   AND NEW.lease_id IS NULL AND NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL
   AND NEW.claimed_at IS NULL AND NEW.retry_after IS NULL
   AND NEW.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now')
   AND EXISTS(SELECT 1 FROM question_request_results r WHERE r.request_id=OLD.request_id
     AND r.request_revision=OLD.revision AND r.state='clarification_required'
     AND r.clarification_count<3 AND r.response_deadline>NEW.updated_at
     AND r.response_deadline>strftime('%Y-%m-%dT%H:%M:%SZ','now')))
), 0)
BEGIN
  SELECT RAISE(ABORT, 'invalid question request state transition');
END;

CREATE TRIGGER IF NOT EXISTS question_request_results_spec_update
BEFORE UPDATE ON question_request_results WHEN NEW.spec_json IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT coalesce(
    (SELECT count(*)=12 AND count(DISTINCT key)=12 FROM json_each(NEW.spec_json))
    AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.spec_json) WHERE type='text' AND instr(value,char(0))>0)
    AND NOT EXISTS(SELECT 1 FROM json_each(NEW.spec_json) WHERE key NOT IN ('version','request_id','request_revision','locale','canonical_intent','result_path','data_snapshot_id','catalog_digest','transform_code_version','renderer_version','artifact_key','expected_cell_state'))
    AND json_type(NEW.spec_json,'$.version') IS 'integer' AND json_extract(NEW.spec_json,'$.version') IS 1
    AND json_extract(NEW.spec_json,'$.request_id') IS NEW.request_id
    AND json_type(NEW.spec_json,'$.request_revision') IS 'integer' AND json_extract(NEW.spec_json,'$.request_revision') IS NEW.request_revision
    AND json_extract(NEW.spec_json,'$.locale') IN ('en','es')
    AND json_type(NEW.spec_json,'$.canonical_intent') IS 'text' AND json_valid(json_extract(NEW.spec_json,'$.canonical_intent')) AND json_type(json_extract(NEW.spec_json,'$.canonical_intent')) IS 'object'
    AND NOT EXISTS(SELECT 1 FROM json_tree(json_extract(NEW.spec_json,'$.canonical_intent')) WHERE type='text' AND instr(value,char(0))>0)
    AND (SELECT count(*)=9 AND count(DISTINCT key)=9 FROM json_each(json_extract(NEW.spec_json,'$.canonical_intent')))
    AND NOT EXISTS(SELECT 1 FROM json_each(json_extract(NEW.spec_json,'$.canonical_intent')) WHERE key NOT IN ('metric','entity_type','entity_id','season','competition','dimensions','filters','viz','limit'))
    AND json_extract(NEW.spec_json,'$.canonical_intent') ->> '$.metric' IN ('goals','assists','minutes','points','xg')
    AND json_extract(NEW.spec_json,'$.canonical_intent') ->> '$.entity_type' IS 'player'
    AND json_extract(NEW.spec_json,'$.canonical_intent') ->> '$.entity_id' IS NOT 'all'
    AND json_type(json_extract(NEW.spec_json,'$.canonical_intent'),'$.entity_id') IS 'text'
    AND length(json_extract(NEW.spec_json,'$.canonical_intent') ->> '$.entity_id') BETWEEN 1 AND 64
    AND (json_extract(NEW.spec_json,'$.canonical_intent') ->> '$.entity_id') GLOB '[a-z0-9]*'
    AND (json_extract(NEW.spec_json,'$.canonical_intent') ->> '$.entity_id') NOT GLOB '*[^a-z0-9:_-]*'
    AND json_extract(NEW.spec_json,'$.canonical_intent') ->> '$.season' GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
    AND json_type(json_extract(NEW.spec_json,'$.canonical_intent'),'$.competition') IS 'text'
    AND length(json_extract(NEW.spec_json,'$.canonical_intent') ->> '$.competition') BETWEEN 1 AND 16
    AND (json_extract(NEW.spec_json,'$.canonical_intent') ->> '$.competition') GLOB '[A-Z]*'
    AND (json_extract(NEW.spec_json,'$.canonical_intent') ->> '$.competition') NOT GLOB '*[^A-Z0-9_]*'
    AND json_extract(NEW.spec_json,'$.canonical_intent') ->> '$.viz' IN ('table','bar','dot_plot')
    AND json_type(json_extract(NEW.spec_json,'$.canonical_intent'),'$.limit') IS 'integer' AND json_extract(NEW.spec_json,'$.canonical_intent') ->> '$.limit' IS 1
    AND json_type(json_extract(NEW.spec_json,'$.canonical_intent'),'$.dimensions') IS 'array' AND json_array_length(json_extract(NEW.spec_json,'$.canonical_intent'),'$.dimensions')=0
    AND json_type(json_extract(NEW.spec_json,'$.canonical_intent'),'$.filters') IS 'object' AND (SELECT count(*)=0 FROM json_each(json_extract(NEW.spec_json,'$.canonical_intent'),'$.filters'))
    AND json_extract(NEW.spec_json,'$.canonical_intent') IS json_object(
      'competition',json_extract(NEW.spec_json,'$.canonical_intent') ->> '$.competition',
      'dimensions',json('[]'),'entity_id',json_extract(NEW.spec_json,'$.canonical_intent') ->> '$.entity_id',
      'entity_type','player','filters',json('{}'),'limit',1,
      'metric',json_extract(NEW.spec_json,'$.canonical_intent') ->> '$.metric',
      'season',json_extract(NEW.spec_json,'$.canonical_intent') ->> '$.season',
      'viz',json_extract(NEW.spec_json,'$.canonical_intent') ->> '$.viz')
    AND json_type(NEW.spec_json,'$.result_path') IS 'text' AND substr(json_extract(NEW.spec_json,'$.result_path'),1,6) IN ('/en/q?','/es/q?')
    AND json_extract(NEW.spec_json,'$.result_path') IS '/' || json_extract(NEW.spec_json,'$.locale') || '/q?metric=' || (json_extract(NEW.spec_json,'$.canonical_intent') ->> '$.metric') || '&entity_type=player&entity_id=' || replace((json_extract(NEW.spec_json,'$.canonical_intent') ->> '$.entity_id'),':','%3A') || '&season=' || (json_extract(NEW.spec_json,'$.canonical_intent') ->> '$.season') || '&competition=' || (json_extract(NEW.spec_json,'$.canonical_intent') ->> '$.competition') || '&viz=' || (json_extract(NEW.spec_json,'$.canonical_intent') ->> '$.viz') || '&limit=1'
    AND json_type(NEW.spec_json,'$.data_snapshot_id') IS 'text' AND length(json_extract(NEW.spec_json,'$.data_snapshot_id')) BETWEEN 1 AND 128
    AND json_extract(NEW.spec_json,'$.data_snapshot_id') NOT GLOB '*[^A-Za-z0-9:_-]*'
    AND json_type(NEW.spec_json,'$.catalog_digest') IS 'text' AND length(json_extract(NEW.spec_json,'$.catalog_digest'))=64 AND json_extract(NEW.spec_json,'$.catalog_digest') NOT GLOB '*[^a-f0-9]*'
    AND json_type(NEW.spec_json,'$.artifact_key') IS 'text' AND length(json_extract(NEW.spec_json,'$.artifact_key'))=64 AND json_extract(NEW.spec_json,'$.artifact_key') NOT GLOB '*[^a-f0-9]*'
    AND json_type(NEW.spec_json,'$.transform_code_version') IS 'text' AND length(json_extract(NEW.spec_json,'$.transform_code_version')) BETWEEN 1 AND 128
    AND json_type(NEW.spec_json,'$.renderer_version') IS 'text' AND length(json_extract(NEW.spec_json,'$.renderer_version')) BETWEEN 1 AND 128
    AND json_extract(NEW.spec_json,'$.expected_cell_state') IN ('available','computable_now_queued'),0)
  THEN RAISE(ABORT,'invalid request acceptance spec') END;
END;

CREATE TRIGGER IF NOT EXISTS question_request_results_generation_transition
BEFORE UPDATE ON question_request_results
WHEN NEW.request_id IS NOT OLD.request_id OR NEW.created_at IS NOT OLD.created_at
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
   ),0)
BEGIN SELECT RAISE(ABORT,'invalid request result generation transition'); END;

-- Both replacement guards and UPDATE spec validation now exist. Reapplying0010
-- and0013 may recreate the old guards; this idempotent tail removes them again.
DROP TRIGGER IF EXISTS question_requests_state_machine;
DROP TRIGGER IF EXISTS question_requests_clock_update;
DROP TRIGGER IF EXISTS question_request_results_transition;

