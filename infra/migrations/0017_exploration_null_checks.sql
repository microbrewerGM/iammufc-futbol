-- Additive repair for 0008: SQLite CHECK accepts NULL comparisons. Use IS NOT
-- so an unparseable date cannot bypass validation. +0 seconds also normalizes
-- calendar overflow and 24:00:00, requiring canonical UTC seconds on disk.
-- No backfill or table rebuild: existing rows and deployed migrations stay intact.

CREATE TRIGGER IF NOT EXISTS exploration_requests_dates_insert
BEFORE INSERT ON exploration_shared_requests
WHEN length(NEW.created_at) IS NOT 20 OR strftime('%Y-%m-%dT%H:%M:%SZ', NEW.created_at, '+0 seconds') IS NOT NEW.created_at
BEGIN SELECT RAISE(ABORT, 'invalid exploration request timestamp'); END;
CREATE TRIGGER IF NOT EXISTS exploration_requests_dates_update
BEFORE UPDATE ON exploration_shared_requests
WHEN length(NEW.created_at) IS NOT 20 OR strftime('%Y-%m-%dT%H:%M:%SZ', NEW.created_at, '+0 seconds') IS NOT NEW.created_at
BEGIN SELECT RAISE(ABORT, 'invalid exploration request timestamp'); END;

CREATE TRIGGER IF NOT EXISTS exploration_links_dates_insert
BEFORE INSERT ON exploration_request_links
WHEN length(NEW.created_at) IS NOT 20 OR strftime('%Y-%m-%dT%H:%M:%SZ', NEW.created_at, '+0 seconds') IS NOT NEW.created_at
  OR NEW.expires_at IS NOT strftime('%Y-%m-%dT%H:%M:%SZ', NEW.created_at, '+90 days')
BEGIN SELECT RAISE(ABORT, 'invalid exploration link timestamps'); END;
CREATE TRIGGER IF NOT EXISTS exploration_links_dates_update
BEFORE UPDATE ON exploration_request_links
WHEN length(NEW.created_at) IS NOT 20 OR strftime('%Y-%m-%dT%H:%M:%SZ', NEW.created_at, '+0 seconds') IS NOT NEW.created_at
  OR NEW.expires_at IS NOT strftime('%Y-%m-%dT%H:%M:%SZ', NEW.created_at, '+90 days')
BEGIN SELECT RAISE(ABORT, 'invalid exploration link timestamps'); END;

CREATE TRIGGER IF NOT EXISTS exploration_results_dates_insert
BEFORE INSERT ON exploration_shared_results
WHEN length(NEW.created_at) IS NOT 20 OR strftime('%Y-%m-%dT%H:%M:%SZ', NEW.created_at, '+0 seconds') IS NOT NEW.created_at
  OR NEW.expires_at IS NOT strftime('%Y-%m-%dT%H:%M:%SZ', NEW.created_at, '+30 days')
BEGIN SELECT RAISE(ABORT, 'invalid exploration result timestamps'); END;
CREATE TRIGGER IF NOT EXISTS exploration_results_dates_update
BEFORE UPDATE ON exploration_shared_results
WHEN length(NEW.created_at) IS NOT 20 OR strftime('%Y-%m-%dT%H:%M:%SZ', NEW.created_at, '+0 seconds') IS NOT NEW.created_at
  OR NEW.expires_at IS NOT strftime('%Y-%m-%dT%H:%M:%SZ', NEW.created_at, '+30 days')
BEGIN SELECT RAISE(ABORT, 'invalid exploration result timestamps'); END;

CREATE TRIGGER IF NOT EXISTS exploration_jobs_dates_insert
BEFORE INSERT ON exploration_shared_jobs
WHEN length(NEW.admitted_at) IS NOT 20 OR strftime('%Y-%m-%dT%H:%M:%SZ', NEW.admitted_at, '+0 seconds') IS NOT NEW.admitted_at
  OR length(NEW.created_at) IS NOT 20 OR strftime('%Y-%m-%dT%H:%M:%SZ', NEW.created_at, '+0 seconds') IS NOT NEW.created_at
  OR length(NEW.updated_at) IS NOT 20 OR strftime('%Y-%m-%dT%H:%M:%SZ', NEW.updated_at, '+0 seconds') IS NOT NEW.updated_at
  OR NEW.expires_at IS NOT strftime('%Y-%m-%dT%H:%M:%SZ', NEW.admitted_at, '+30 days')
  OR (NEW.claimed_at IS NOT NULL AND (length(NEW.claimed_at) IS NOT 20 OR strftime('%Y-%m-%dT%H:%M:%SZ', NEW.claimed_at, '+0 seconds') IS NOT NEW.claimed_at))
  OR (NEW.lease_expires_at IS NOT NULL AND (length(NEW.lease_expires_at) IS NOT 20 OR strftime('%Y-%m-%dT%H:%M:%SZ', NEW.lease_expires_at, '+0 seconds') IS NOT NEW.lease_expires_at))
  OR (NEW.retry_after IS NOT NULL AND (length(NEW.retry_after) IS NOT 20 OR strftime('%Y-%m-%dT%H:%M:%SZ', NEW.retry_after, '+0 seconds') IS NOT NEW.retry_after))
  OR (NEW.status = 'running' AND (NEW.lease_owner IS NULL OR (NEW.lease_expires_at > NEW.claimed_at) IS NOT TRUE))
BEGIN SELECT RAISE(ABORT, 'invalid exploration job timestamps or lease'); END;
CREATE TRIGGER IF NOT EXISTS exploration_jobs_dates_update
BEFORE UPDATE ON exploration_shared_jobs
WHEN length(NEW.admitted_at) IS NOT 20 OR strftime('%Y-%m-%dT%H:%M:%SZ', NEW.admitted_at, '+0 seconds') IS NOT NEW.admitted_at
  OR length(NEW.created_at) IS NOT 20 OR strftime('%Y-%m-%dT%H:%M:%SZ', NEW.created_at, '+0 seconds') IS NOT NEW.created_at
  OR length(NEW.updated_at) IS NOT 20 OR strftime('%Y-%m-%dT%H:%M:%SZ', NEW.updated_at, '+0 seconds') IS NOT NEW.updated_at
  OR NEW.expires_at IS NOT strftime('%Y-%m-%dT%H:%M:%SZ', NEW.admitted_at, '+30 days')
  OR (NEW.claimed_at IS NOT NULL AND (length(NEW.claimed_at) IS NOT 20 OR strftime('%Y-%m-%dT%H:%M:%SZ', NEW.claimed_at, '+0 seconds') IS NOT NEW.claimed_at))
  OR (NEW.lease_expires_at IS NOT NULL AND (length(NEW.lease_expires_at) IS NOT 20 OR strftime('%Y-%m-%dT%H:%M:%SZ', NEW.lease_expires_at, '+0 seconds') IS NOT NEW.lease_expires_at))
  OR (NEW.retry_after IS NOT NULL AND (length(NEW.retry_after) IS NOT 20 OR strftime('%Y-%m-%dT%H:%M:%SZ', NEW.retry_after, '+0 seconds') IS NOT NEW.retry_after))
  OR (NEW.status = 'running' AND (NEW.lease_owner IS NULL OR (NEW.lease_expires_at > NEW.claimed_at) IS NOT TRUE))
BEGIN SELECT RAISE(ABORT, 'invalid exploration job timestamps or lease'); END;

CREATE TRIGGER IF NOT EXISTS exploration_tombstones_dates_insert
BEFORE INSERT ON exploration_shared_job_tombstones
WHEN length(NEW.deleted_at) IS NOT 20 OR strftime('%Y-%m-%dT%H:%M:%SZ', NEW.deleted_at, '+0 seconds') IS NOT NEW.deleted_at
BEGIN SELECT RAISE(ABORT, 'invalid exploration tombstone timestamp'); END;
CREATE TRIGGER IF NOT EXISTS exploration_tombstones_dates_update
BEFORE UPDATE ON exploration_shared_job_tombstones
WHEN length(NEW.deleted_at) IS NOT 20 OR strftime('%Y-%m-%dT%H:%M:%SZ', NEW.deleted_at, '+0 seconds') IS NOT NEW.deleted_at
BEGIN SELECT RAISE(ABORT, 'invalid exploration tombstone timestamp'); END;

CREATE TRIGGER IF NOT EXISTS exploration_operations_dates_insert
BEFORE INSERT ON exploration_bridge_operations
WHEN length(NEW.created_at) IS NOT 20 OR strftime('%Y-%m-%dT%H:%M:%SZ', NEW.created_at, '+0 seconds') IS NOT NEW.created_at
  OR NEW.expires_at IS NOT strftime('%Y-%m-%dT%H:%M:%SZ', NEW.created_at, '+30 days')
BEGIN SELECT RAISE(ABORT, 'invalid exploration operation timestamps'); END;
CREATE TRIGGER IF NOT EXISTS exploration_operations_dates_update
BEFORE UPDATE ON exploration_bridge_operations
WHEN length(NEW.created_at) IS NOT 20 OR strftime('%Y-%m-%dT%H:%M:%SZ', NEW.created_at, '+0 seconds') IS NOT NEW.created_at
  OR NEW.expires_at IS NOT strftime('%Y-%m-%dT%H:%M:%SZ', NEW.created_at, '+30 days')
BEGIN SELECT RAISE(ABORT, 'invalid exploration operation timestamps'); END;
