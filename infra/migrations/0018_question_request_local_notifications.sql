-- Additive ledger: no parent, result, clarification or legacy delivery rewrite.
-- Payload revision is the existing monotonic desired_revision, not a GitHub issue.
CREATE TABLE IF NOT EXISTS question_request_local_notifications (
 request_id TEXT NOT NULL REFERENCES question_requests(request_id) ON DELETE CASCADE,
 payload_revision INTEGER NOT NULL CHECK(typeof(payload_revision)='integer' AND payload_revision BETWEEN 1 AND 9007199254740991),
 status TEXT NOT NULL CHECK(status IN ('received','triaging','clarification_required','confirmation_required','building','in_review','released','unsupported','unavailable','failed','expired','junk','stale')),
 result_path TEXT,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 lease_id TEXT, lease_owner TEXT, lease_expires_at TEXT,
 receipt TEXT CHECK(receipt IS NULL OR (length(receipt)=64 AND receipt NOT GLOB '*[^0-9a-f]*')),
 receipt_lease_id TEXT, receipt_lease_owner TEXT,
 delivered INTEGER NOT NULL DEFAULT 0 CHECK(delivered IN (0,1)),
 PRIMARY KEY(request_id,payload_revision),
 CHECK((status='released' AND typeof(result_path)='text' AND length(result_path)<=1024 AND
   (result_path GLOB '/en/q?*' OR result_path GLOB '/es/q?*') AND instr(result_path,char(0))=0)
   OR (status!='released' AND result_path IS NULL)),
 CHECK((lease_id IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL) OR
   (typeof(lease_id)='text' AND length(lease_id) BETWEEN 1 AND 96 AND lease_id GLOB '[a-z0-9]*' AND lease_id NOT GLOB '*[^a-z0-9:_-]*'
   AND typeof(lease_owner)='text' AND length(lease_owner) BETWEEN 1 AND 96 AND lease_owner GLOB '[a-z0-9]*' AND lease_owner NOT GLOB '*[^a-z0-9:_-]*'
   AND typeof(lease_expires_at)='text' AND length(lease_expires_at)=20 AND strftime('%Y-%m-%dT%H:%M:%SZ',lease_expires_at) IS lease_expires_at)),
 CHECK((receipt IS NULL AND receipt_lease_id IS NULL AND receipt_lease_owner IS NULL) OR
   (receipt IS NOT NULL AND typeof(receipt_lease_id)='text' AND typeof(receipt_lease_owner)='text')),
 CHECK(delivered=0 OR (receipt IS NOT NULL AND lease_id IS NULL))
);
CREATE TRIGGER IF NOT EXISTS question_request_local_notifications_insert
BEFORE INSERT ON question_request_local_notifications
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM question_request_local_notifications WHERE request_id=NEW.request_id AND payload_revision=NEW.payload_revision)
   THEN RAISE(ABORT,'local delivery key already exists') END;
 SELECT CASE WHEN NEW.revision IS NOT 1 OR NEW.delivered IS NOT 0 OR NEW.receipt IS NOT NULL OR NEW.lease_id IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM question_request_notifications n JOIN question_requests q USING(request_id)
     WHERE n.request_id=NEW.request_id AND n.desired_revision=NEW.payload_revision AND n.desired_status=NEW.status
     AND n.desired_result_path IS NEW.result_path AND q.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now'))
   THEN RAISE(ABORT,'invalid local delivery') END;
END;
CREATE TRIGGER IF NOT EXISTS question_request_local_notifications_update
BEFORE UPDATE ON question_request_local_notifications
BEGIN
 SELECT CASE WHEN NEW.request_id IS NOT OLD.request_id OR NEW.payload_revision IS NOT OLD.payload_revision OR NEW.status IS NOT OLD.status
   OR NEW.result_path IS NOT OLD.result_path OR NEW.revision IS NOT OLD.revision+1 OR NEW.delivered<OLD.delivered
   OR (OLD.receipt IS NOT NULL AND NEW.receipt IS NOT OLD.receipt)
   OR NOT EXISTS(SELECT 1 FROM question_requests WHERE request_id=OLD.request_id AND expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now'))
   THEN RAISE(ABORT,'immutable local delivery') END;
 SELECT CASE WHEN OLD.lease_id IS NOT NULL AND OLD.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now') AND NEW.lease_id IS NOT NULL
   AND (NEW.lease_id IS NOT OLD.lease_id OR NEW.lease_owner IS NOT OLD.lease_owner OR NEW.lease_expires_at IS NOT OLD.lease_expires_at)
   THEN RAISE(ABORT,'immutable local lease') END;
 SELECT CASE WHEN NEW.lease_id IS NOT NULL AND (OLD.lease_id IS NULL OR OLD.lease_expires_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')) AND
   (NEW.lease_expires_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now') OR NEW.lease_expires_at>(SELECT min(expires_at,strftime('%Y-%m-%dT%H:%M:%SZ','now','+900 seconds')) FROM question_requests WHERE request_id=OLD.request_id))
   THEN RAISE(ABORT,'invalid local lease') END;
 SELECT CASE WHEN (NEW.receipt IS NOT OLD.receipt OR NEW.receipt_lease_id IS NOT OLD.receipt_lease_id OR NEW.receipt_lease_owner IS NOT OLD.receipt_lease_owner OR NEW.delivered>OLD.delivered) AND
   (OLD.lease_id IS NULL OR OLD.lease_expires_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')) THEN RAISE(ABORT,'local receipt needs live lease') END;
 SELECT CASE WHEN (NEW.receipt IS NOT OLD.receipt OR NEW.receipt_lease_id IS NOT OLD.receipt_lease_id OR NEW.receipt_lease_owner IS NOT OLD.receipt_lease_owner) AND
   (NEW.receipt_lease_id IS NOT OLD.lease_id OR NEW.receipt_lease_owner IS NOT OLD.lease_owner) THEN RAISE(ABORT,'invalid receipt lease') END;
 SELECT CASE WHEN NEW.delivered>OLD.delivered AND (OLD.receipt IS NULL OR NEW.lease_id IS NOT NULL
   OR OLD.receipt_lease_id IS NOT OLD.lease_id OR OLD.receipt_lease_owner IS NOT OLD.lease_owner)
   THEN RAISE(ABORT,'local delivery needs receipt') END;
END;
CREATE TRIGGER IF NOT EXISTS question_request_local_notifications_delete
BEFORE DELETE ON question_request_local_notifications WHEN EXISTS(SELECT 1 FROM question_requests WHERE request_id=OLD.request_id)
BEGIN SELECT RAISE(ABORT,'retained local delivery cannot be reset'); END;
-- Once the local protocol is installed, answer-now mutations cannot bind issues.
-- Reads and legacy persisted rows remain valid; deployment is a separate lane.
CREATE TRIGGER IF NOT EXISTS question_request_local_notifications_no_issue
BEFORE UPDATE OF issue_number ON question_request_notifications WHEN NEW.issue_number IS NOT OLD.issue_number
BEGIN SELECT RAISE(ABORT,'answer-now delivery is local'); END;
