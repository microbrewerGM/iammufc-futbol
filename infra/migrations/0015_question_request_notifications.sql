-- Durable, ID-only delivery state. No GitHub credential or request text belongs here.
-- A ready->pending transition grants create ONCE; pending recovery only reconciles.
CREATE TABLE IF NOT EXISTS question_request_notifications (
  request_id TEXT PRIMARY KEY NOT NULL REFERENCES question_requests(request_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
  desired_revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(desired_revision)='integer' AND desired_revision BETWEEN 1 AND 9007199254740991),
  desired_status TEXT NOT NULL CHECK(desired_status IN ('received','triaging','clarification_required','confirmation_required','building','in_review','released','unsupported','unavailable','failed','expired','junk','stale')),
  desired_result_path TEXT,
  delivered_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(delivered_revision)='integer' AND delivered_revision BETWEEN 0 AND desired_revision),
  create_state TEXT NOT NULL DEFAULT 'ready' CHECK(create_state IN ('ready','pending','bound')),
  issue_number INTEGER UNIQUE CHECK(issue_number IS NULL OR (typeof(issue_number)='integer' AND issue_number BETWEEN 1 AND 9007199254740991)),
  creation_revision INTEGER CHECK(creation_revision IS NULL OR (typeof(creation_revision)='integer' AND creation_revision BETWEEN 1 AND desired_revision)),
  creation_status TEXT,
  creation_result_path TEXT,
  lease_id TEXT CHECK(lease_id IS NULL OR (typeof(lease_id)='text' AND length(lease_id) BETWEEN 1 AND 96 AND lease_id GLOB '[a-z0-9]*' AND lease_id NOT GLOB '*[^a-z0-9:_-]*' AND instr(lease_id,char(0))=0)),
  lease_owner TEXT CHECK(lease_owner IS NULL OR (typeof(lease_owner)='text' AND length(lease_owner) BETWEEN 1 AND 96 AND lease_owner GLOB '[a-z0-9]*' AND lease_owner NOT GLOB '*[^a-z0-9:_-]*' AND instr(lease_owner,char(0))=0)),
  lease_expires_at TEXT,
  inflight_revision INTEGER CHECK(inflight_revision IS NULL OR (typeof(inflight_revision)='integer' AND inflight_revision BETWEEN 1 AND desired_revision)),
  inflight_status TEXT,
  inflight_result_path TEXT,
  created_at TEXT NOT NULL CHECK(typeof(created_at)='text' AND length(created_at)=20 AND strftime('%Y-%m-%dT%H:%M:%SZ',created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK(typeof(updated_at)='text' AND length(updated_at)=20 AND strftime('%Y-%m-%dT%H:%M:%SZ',updated_at) IS updated_at AND updated_at>=created_at),
  expires_at TEXT NOT NULL CHECK(typeof(expires_at)='text' AND length(expires_at)=20 AND strftime('%Y-%m-%dT%H:%M:%SZ',expires_at) IS expires_at AND expires_at>created_at),
  CHECK((desired_status='released' AND typeof(desired_result_path)='text' AND length(desired_result_path) BETWEEN 1 AND 1024 AND instr(desired_result_path,char(0))=0) OR (desired_status!='released' AND desired_result_path IS NULL)),
  CHECK(coalesce((create_state='ready' AND issue_number IS NULL AND delivered_revision=0 AND creation_revision IS NULL AND creation_status IS NULL AND creation_result_path IS NULL AND lease_id IS NULL)
    OR (create_state='pending' AND issue_number IS NULL AND delivered_revision=0 AND creation_revision IS NOT NULL)
    OR (create_state='bound' AND issue_number IS NOT NULL AND creation_revision IS NOT NULL),0)),
  CHECK(creation_revision IS NULL OR coalesce(creation_status IN ('received','triaging','clarification_required','confirmation_required','building','in_review','released','unsupported','unavailable','failed','expired','junk','stale') AND
    ((creation_status='released' AND typeof(creation_result_path)='text' AND length(creation_result_path) BETWEEN 1 AND 1024) OR (creation_status!='released' AND creation_result_path IS NULL)),0)),
  CHECK(coalesce((lease_id IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL AND inflight_revision IS NULL AND inflight_status IS NULL AND inflight_result_path IS NULL)
    OR (lease_id IS NOT NULL AND lease_owner IS NOT NULL AND typeof(lease_expires_at)='text' AND length(lease_expires_at)=20 AND strftime('%Y-%m-%dT%H:%M:%SZ',lease_expires_at) IS lease_expires_at
      AND lease_expires_at>updated_at AND lease_expires_at<=min(expires_at,strftime('%Y-%m-%dT%H:%M:%SZ',updated_at,'+900 seconds'))
      AND inflight_revision IS NOT NULL AND inflight_status IN ('received','triaging','clarification_required','confirmation_required','building','in_review','released','unsupported','unavailable','failed','expired','junk','stale')
      AND ((inflight_status='released' AND typeof(inflight_result_path)='text' AND length(inflight_result_path) BETWEEN 1 AND 1024) OR (inflight_status!='released' AND inflight_result_path IS NULL))),0))
);
CREATE INDEX IF NOT EXISTS idx_question_request_notifications_work ON question_request_notifications(updated_at,request_id);

CREATE TRIGGER IF NOT EXISTS question_request_notifications_no_replace
BEFORE INSERT ON question_request_notifications WHEN EXISTS(SELECT 1 FROM question_request_notifications WHERE request_id=NEW.request_id)
BEGIN SELECT RAISE(IGNORE); END;

-- REPLACE deletes uniqueness conflicts without DELETE triggers when recursive
-- triggers are off. Reject issue conflicts before SQLite reaches that deletion.
CREATE TRIGGER IF NOT EXISTS question_request_notifications_issue_insert
BEFORE INSERT ON question_request_notifications WHEN NEW.issue_number IS NOT NULL AND
 EXISTS(SELECT 1 FROM question_request_notifications n WHERE n.issue_number=NEW.issue_number AND n.request_id!=NEW.request_id)
BEGIN SELECT RAISE(ABORT,'notification issue already bound'); END;
CREATE TRIGGER IF NOT EXISTS question_request_notifications_issue_update
BEFORE UPDATE OF issue_number ON question_request_notifications WHEN NEW.issue_number IS NOT NULL AND
 EXISTS(SELECT 1 FROM question_request_notifications n WHERE n.issue_number=NEW.issue_number AND n.request_id!=NEW.request_id)
BEGIN SELECT RAISE(ABORT,'notification issue already bound'); END;

CREATE TRIGGER IF NOT EXISTS question_request_notifications_initial
BEFORE INSERT ON question_request_notifications
WHEN NEW.revision IS NOT 1 OR NEW.desired_revision IS NOT 1 OR NEW.delivered_revision IS NOT 0 OR NEW.create_state IS NOT 'ready'
 OR NEW.issue_number IS NOT NULL OR NEW.creation_revision IS NOT NULL OR NEW.creation_status IS NOT NULL OR NEW.creation_result_path IS NOT NULL
 OR NEW.lease_id IS NOT NULL OR NEW.updated_at IS NOT NEW.created_at OR NEW.created_at IS NOT strftime('%Y-%m-%dT%H:%M:%SZ','now')
 OR NOT EXISTS(SELECT 1 FROM question_requests q WHERE q.request_id=NEW.request_id AND q.expires_at=NEW.expires_at AND q.expires_at>NEW.created_at
   AND (q.lease_id LIKE 'q2:%' OR EXISTS(SELECT 1 FROM question_request_results r WHERE r.request_id=q.request_id)))
BEGIN SELECT RAISE(ABORT,'invalid initial notification'); END;

CREATE TRIGGER IF NOT EXISTS question_request_notifications_transition
BEFORE UPDATE ON question_request_notifications
BEGIN
  SELECT CASE WHEN NEW.request_id IS NOT OLD.request_id OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
    OR NEW.revision IS NOT OLD.revision+1 OR NEW.updated_at IS NOT max(OLD.updated_at,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    OR NEW.expires_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
    OR NEW.desired_revision IS NOT OLD.desired_revision + CASE WHEN NEW.desired_status IS NOT OLD.desired_status OR NEW.desired_result_path IS NOT OLD.desired_result_path THEN 1 ELSE 0 END
    OR NEW.delivered_revision<OLD.delivered_revision
    THEN RAISE(ABORT,'invalid notification revision') END;
  SELECT CASE WHEN NOT coalesce((
    (OLD.create_state=NEW.create_state AND NEW.issue_number IS OLD.issue_number
      AND NEW.creation_revision IS OLD.creation_revision AND NEW.creation_status IS OLD.creation_status AND NEW.creation_result_path IS OLD.creation_result_path)
    OR (OLD.create_state='ready' AND NEW.create_state='pending' AND OLD.lease_id IS NULL AND NEW.lease_id IS NOT NULL
      AND NEW.issue_number IS NULL AND NEW.creation_revision IS NEW.desired_revision AND NEW.creation_status IS NEW.desired_status AND NEW.creation_result_path IS NEW.desired_result_path)
    OR (OLD.create_state='pending' AND NEW.create_state='bound' AND OLD.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now') AND NEW.lease_id IS NULL
      AND NEW.issue_number IS NOT NULL AND NEW.delivered_revision=0
      AND NEW.creation_revision IS OLD.creation_revision AND NEW.creation_status IS OLD.creation_status AND NEW.creation_result_path IS OLD.creation_result_path)),0)
    THEN RAISE(ABORT,'invalid notification creation transition') END;
  SELECT CASE WHEN OLD.lease_id IS NOT NULL AND NEW.lease_id IS NOT NULL AND
    (NEW.lease_id IS NOT OLD.lease_id OR NEW.lease_owner IS NOT OLD.lease_owner OR NEW.lease_expires_at IS NOT OLD.lease_expires_at
      OR NEW.inflight_revision IS NOT OLD.inflight_revision OR NEW.inflight_status IS NOT OLD.inflight_status OR NEW.inflight_result_path IS NOT OLD.inflight_result_path)
    THEN RAISE(ABORT,'notification inflight payload is immutable') END;
  SELECT CASE WHEN OLD.lease_id IS NULL AND NEW.lease_id IS NOT NULL AND NOT coalesce((
    (NEW.create_state='pending' AND NEW.inflight_revision IS NEW.creation_revision AND NEW.inflight_status IS NEW.creation_status AND NEW.inflight_result_path IS NEW.creation_result_path)
    OR (NEW.create_state='bound' AND NEW.inflight_revision IS NEW.desired_revision AND NEW.inflight_status IS NEW.desired_status AND NEW.inflight_result_path IS NEW.desired_result_path)),0)
    THEN RAISE(ABORT,'invalid notification grant') END;
  SELECT CASE WHEN NEW.delivered_revision>OLD.delivered_revision AND NOT coalesce((
    OLD.create_state='bound' AND NEW.create_state='bound' AND OLD.lease_id IS NOT NULL AND NEW.lease_id IS NULL
    AND OLD.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now') AND NEW.delivered_revision IS OLD.inflight_revision),0)
    THEN RAISE(ABORT,'invalid notification delivery') END;
END;

-- Desired released content and new external sends must match a current stored
-- result; the service additionally verifies catalog/code/lineage before its CAS.
CREATE TRIGGER IF NOT EXISTS question_request_notifications_released_insert
AFTER INSERT ON question_request_notifications WHEN NEW.desired_status='released'
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM question_request_results r JOIN question_requests q USING(request_id)
    WHERE r.request_id=NEW.request_id AND r.state='released' AND r.request_revision=q.revision AND r.verified_json IS NOT NULL
    AND json_extract(r.spec_json,'$.data_snapshot_id') IS (SELECT snapshot_id FROM snapshots ORDER BY created_at DESC LIMIT 1)
    AND NEW.desired_result_path IS json_extract(r.spec_json,'$.result_path')) THEN RAISE(ABORT,'invalid released notification') END;
END;
CREATE TRIGGER IF NOT EXISTS question_request_notifications_released_update
AFTER UPDATE ON question_request_notifications WHEN NEW.desired_status='released' AND
  (NEW.desired_status IS NOT OLD.desired_status OR NEW.desired_result_path IS NOT OLD.desired_result_path
    OR OLD.lease_id IS NULL AND NEW.lease_id IS NOT NULL AND (OLD.create_state='ready' OR NEW.create_state='bound'))
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM question_request_results r JOIN question_requests q USING(request_id)
    WHERE r.request_id=NEW.request_id AND r.state='released' AND r.request_revision=q.revision AND r.verified_json IS NOT NULL
    AND json_extract(r.spec_json,'$.data_snapshot_id') IS (SELECT snapshot_id FROM snapshots ORDER BY created_at DESC LIMIT 1)
    AND NEW.desired_result_path IS json_extract(r.spec_json,'$.result_path')) THEN RAISE(ABORT,'invalid released notification') END;
END;
CREATE TRIGGER IF NOT EXISTS question_request_notifications_no_retained_delete
BEFORE DELETE ON question_request_notifications WHEN EXISTS(SELECT 1 FROM question_requests q WHERE q.request_id=OLD.request_id)
BEGIN SELECT RAISE(ABORT,'retained notification cannot be reset'); END;
