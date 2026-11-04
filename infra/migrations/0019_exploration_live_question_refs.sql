-- Repair orphan collection without changing stored rows or retention windows.
-- A question can outlive its account link because admission reuses older links.
DROP TRIGGER IF EXISTS exploration_request_links_orphan_collect;
DROP TRIGGER IF EXISTS exploration_shared_jobs_orphan_collect;
DROP VIEW IF EXISTS exploration_collectable_requests;

CREATE VIEW exploration_collectable_requests AS
SELECT r.request_id, r.created_at
FROM exploration_shared_requests AS r
WHERE NOT EXISTS (SELECT 1 FROM exploration_request_links AS l WHERE l.request_id = r.request_id)
  AND NOT EXISTS (
    SELECT 1 FROM question_requests AS q
    WHERE q.exploration_request_id = r.request_id
      AND q.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  )
  AND NOT EXISTS (
    SELECT 1 FROM exploration_shared_jobs AS j
    WHERE j.request_id = r.request_id AND j.status = 'running'
      AND j.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  );

CREATE TRIGGER exploration_request_links_orphan_collect
AFTER DELETE ON exploration_request_links
WHEN EXISTS (SELECT 1 FROM exploration_collectable_requests WHERE request_id = OLD.request_id)
BEGIN
  DELETE FROM exploration_shared_requests WHERE request_id = OLD.request_id;
END;

CREATE TRIGGER exploration_shared_jobs_orphan_collect
AFTER UPDATE ON exploration_shared_jobs
WHEN EXISTS (SELECT 1 FROM exploration_collectable_requests WHERE request_id = NEW.request_id)
BEGIN
  DELETE FROM exploration_shared_requests WHERE request_id = NEW.request_id;
END;

-- Question expiry/deletion fires neither trigger. The bounded collector's view
-- sweep rechecks these orphans on the next protocol-2 retention invocation.
