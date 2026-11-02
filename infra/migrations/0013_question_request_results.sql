-- Phase 1 persistence foundation. No existing request is changed or requeued.
-- Versioned answer-now ack must settle parent + create sidecar in one D1 batch.
-- A later bridge migration supplies the controlled clarification parent reset.
CREATE TABLE IF NOT EXISTS question_request_results (
  request_id TEXT NOT NULL PRIMARY KEY REFERENCES question_requests(request_id) ON DELETE CASCADE,
  request_revision INTEGER NOT NULL CHECK(typeof(request_revision)='integer' AND request_revision>=1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision>=1),
  state TEXT NOT NULL CHECK(state IN ('triaging','clarification_required','confirmation_required','building','in_review','released','unsupported','unavailable','failed','expired','stale')),
  clarification_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(clarification_count)='integer' AND clarification_count BETWEEN 0 AND 3),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempt)='integer' AND attempt BETWEEN 0 AND 3),
  spec_json TEXT CHECK(spec_json IS NULL OR coalesce(typeof(spec_json)='text' AND length(CAST(spec_json AS BLOB))<=16384 AND json_valid(spec_json) AND json_type(spec_json)='object',0)),
  verified_json TEXT CHECK(verified_json IS NULL OR coalesce(typeof(verified_json)='text' AND length(CAST(verified_json AS BLOB))<=32768 AND json_valid(verified_json) AND json_type(verified_json)='object',0)),
  lease_id TEXT CHECK(lease_id IS NULL OR (typeof(lease_id)='text' AND length(lease_id) BETWEEN 1 AND 96 AND lease_id NOT GLOB '*[^a-z0-9:_-]*')),
  lease_owner TEXT CHECK(lease_owner IS NULL OR (typeof(lease_owner)='text' AND length(lease_owner) BETWEEN 1 AND 96 AND lease_owner NOT GLOB '*[^a-z0-9:_-]*')),
  lease_expires_at TEXT CHECK(lease_expires_at IS NULL OR (typeof(lease_expires_at)='text' AND length(lease_expires_at)=20 AND strftime('%Y-%m-%dT%H:%M:%SZ',lease_expires_at) IS lease_expires_at)),
  created_at TEXT NOT NULL CHECK(typeof(created_at)='text' AND length(created_at)=20 AND strftime('%Y-%m-%dT%H:%M:%SZ',created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK(typeof(updated_at)='text' AND length(updated_at)=20 AND strftime('%Y-%m-%dT%H:%M:%SZ',updated_at) IS updated_at AND updated_at>=created_at),
  response_deadline TEXT NOT NULL CHECK(typeof(response_deadline)='text' AND length(response_deadline)=20 AND strftime('%Y-%m-%dT%H:%M:%SZ',response_deadline) IS response_deadline),
  expires_at TEXT NOT NULL CHECK(typeof(expires_at)='text' AND length(expires_at)=20 AND strftime('%Y-%m-%dT%H:%M:%SZ',expires_at) IS expires_at AND expires_at>created_at AND response_deadline<=expires_at),
  CHECK(state NOT IN ('confirmation_required','building','in_review','released','stale') OR spec_json IS NOT NULL),
  CHECK((state='released' AND verified_json IS NOT NULL) OR (state!='released' AND verified_json IS NULL)),
  CHECK(coalesce((state='in_review' AND attempt BETWEEN 1 AND 3 AND lease_id IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_expires_at>updated_at AND lease_expires_at<=strftime('%Y-%m-%dT%H:%M:%SZ',updated_at,'+900 seconds')) OR (state!='in_review' AND lease_expires_at IS NULL),0))
);
CREATE INDEX IF NOT EXISTS idx_question_request_results_work ON question_request_results(state,updated_at,request_id);

CREATE TRIGGER IF NOT EXISTS question_request_results_no_replace
BEFORE INSERT ON question_request_results
WHEN EXISTS(SELECT 1 FROM question_request_results WHERE request_id=NEW.request_id)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER IF NOT EXISTS question_request_results_initial
BEFORE INSERT ON question_request_results
WHEN NEW.revision IS NOT 1 OR NEW.state NOT IN ('clarification_required','confirmation_required','unsupported','unavailable')
 OR NEW.clarification_count IS NOT 0 OR NEW.attempt IS NOT 0
 OR NEW.lease_id IS NOT NULL OR NEW.lease_owner IS NOT NULL OR NEW.verified_json IS NOT NULL
 OR NEW.updated_at IS NOT NEW.created_at
 OR NEW.response_deadline IS NOT min(NEW.expires_at,strftime('%Y-%m-%dT%H:%M:%SZ',NEW.created_at,'+1 day'))
 OR NOT EXISTS(SELECT 1 FROM question_requests q WHERE q.request_id=NEW.request_id AND q.status IN ('filled','partial','no_data') AND q.revision=NEW.request_revision AND q.expires_at=NEW.expires_at AND q.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now'))
BEGIN SELECT RAISE(ABORT,'invalid initial request result'); END;

CREATE TRIGGER IF NOT EXISTS question_request_results_spec_insert
BEFORE INSERT ON question_request_results WHEN NEW.spec_json IS NOT NULL
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

CREATE TRIGGER IF NOT EXISTS question_request_results_clock_insert
BEFORE INSERT ON question_request_results
WHEN coalesce(NEW.created_at NOT BETWEEN strftime('%Y-%m-%dT%H:%M:%SZ','now','-300 seconds') AND strftime('%Y-%m-%dT%H:%M:%SZ','now','+300 seconds'),1)
BEGIN SELECT RAISE(ABORT,'request result clock bound'); END;

CREATE TRIGGER IF NOT EXISTS question_request_results_clock_update
BEFORE UPDATE ON question_request_results
WHEN coalesce(NEW.updated_at NOT BETWEEN strftime('%Y-%m-%dT%H:%M:%SZ','now','-300 seconds') AND strftime('%Y-%m-%dT%H:%M:%SZ','now','+300 seconds'),1)
BEGIN SELECT RAISE(ABORT,'request result clock bound'); END;

-- A spec is immutable within one generation. Re-triage mapping is introduced
-- only with the controlled parent-requeue implementation and its own tests.
CREATE TRIGGER IF NOT EXISTS question_request_results_transition
BEFORE UPDATE ON question_request_results
WHEN NEW.request_id IS NOT OLD.request_id OR NEW.request_revision IS NOT OLD.request_revision
 OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
 OR NEW.response_deadline IS NOT OLD.response_deadline OR NEW.spec_json IS NOT OLD.spec_json
 OR NEW.clarification_count IS NOT OLD.clarification_count OR NEW.revision IS NOT OLD.revision+1
 OR NEW.updated_at<OLD.updated_at
 OR (NEW.state NOT IN ('expired','failed','stale') AND (NEW.expires_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now') OR NEW.expires_at<=NEW.updated_at))
 OR (NEW.state='building' AND OLD.state='confirmation_required' AND OLD.response_deadline<=strftime('%Y-%m-%dT%H:%M:%SZ','now'))
 OR (NEW.state='released' AND OLD.lease_expires_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now'))
 OR (NEW.lease_expires_at IS NOT NULL AND NEW.lease_expires_at>NEW.expires_at)
 OR NOT EXISTS(SELECT 1 FROM question_requests q WHERE q.request_id=NEW.request_id AND q.revision=NEW.request_revision)
 OR NOT coalesce(
   (OLD.state='confirmation_required' AND NEW.state='building' AND OLD.response_deadline>NEW.updated_at AND NEW.attempt=OLD.attempt AND NEW.lease_id IS OLD.lease_id AND NEW.lease_owner IS OLD.lease_owner)
   OR (OLD.state='building' AND NEW.state='in_review' AND OLD.attempt<3 AND NEW.attempt=OLD.attempt+1 AND NEW.lease_id IS NOT OLD.lease_id)
   OR (OLD.state='in_review' AND NEW.state IN ('released','building','failed') AND NEW.attempt=OLD.attempt AND NEW.lease_id IS OLD.lease_id AND NEW.lease_owner IS OLD.lease_owner
       AND (NEW.state!='released' OR OLD.lease_expires_at>NEW.updated_at)
       AND (NEW.state!='building' OR OLD.lease_expires_at<=NEW.updated_at AND OLD.attempt<3)
       AND (NEW.state!='failed' OR OLD.attempt=3 AND OLD.lease_expires_at<=NEW.updated_at))
   OR (OLD.state IN ('clarification_required','confirmation_required') AND NEW.state='expired' AND OLD.response_deadline<=NEW.updated_at AND NEW.attempt=OLD.attempt AND NEW.lease_id IS OLD.lease_id AND NEW.lease_owner IS OLD.lease_owner)
   OR (OLD.state='released' AND NEW.state='stale' AND NEW.attempt=OLD.attempt AND NEW.lease_id IS OLD.lease_id AND NEW.lease_owner IS OLD.lease_owner),0)
BEGIN SELECT RAISE(ABORT,'invalid request result transition'); END;

CREATE TRIGGER IF NOT EXISTS question_request_results_evidence
BEFORE UPDATE ON question_request_results WHEN NEW.state='released'
BEGIN
 SELECT CASE WHEN NOT coalesce(
   (SELECT count(*)=6 AND count(DISTINCT key)=6 FROM json_each(NEW.verified_json))
   AND NOT EXISTS(SELECT 1 FROM json_each(NEW.verified_json) WHERE key NOT IN ('artifact_key','snapshot_id','entity_id','value','attribution','verified_at'))
   AND json_extract(NEW.verified_json,'$.artifact_key') IS json_extract(NEW.spec_json,'$.artifact_key')
   AND json_extract(NEW.verified_json,'$.snapshot_id') IS json_extract(NEW.spec_json,'$.data_snapshot_id')
   AND json_type(NEW.verified_json,'$.entity_id') IS 'text'
   AND json_extract(NEW.verified_json,'$.entity_id') IS json_extract(json_extract(NEW.spec_json,'$.canonical_intent'),'$.entity_id')
   AND json_type(NEW.verified_json,'$.value') IN ('integer','real') AND abs(json_extract(NEW.verified_json,'$.value'))<=1.7976931348623157e308
   AND json_type(NEW.verified_json,'$.attribution') IS 'text' AND length(trim(json_extract(NEW.verified_json,'$.attribution')))>0
   AND json_extract(NEW.verified_json,'$.verified_at') IS NEW.updated_at,0)
 THEN RAISE(ABORT,'invalid request release evidence') END;
END;

CREATE TRIGGER IF NOT EXISTS question_request_results_retention
BEFORE DELETE ON question_request_results
WHEN EXISTS(SELECT 1 FROM question_requests WHERE request_id=OLD.request_id AND expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now'))
BEGIN SELECT RAISE(ABORT,'request result retained with parent'); END;
