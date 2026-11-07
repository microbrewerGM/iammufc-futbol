-- One-time repair only: never add to the ordinary migration list, which every deploy reruns.
-- D1 limits a GLOB pattern to 50 bytes, and these tables were created with longer CHECK
-- patterns, so no question could ever be stored. SQLite cannot alter a CHECK. This file
-- removes the question tables and every object naming them; the ordinary migration list,
-- which runs next in the same job, recreates them all from the corrected definitions.
-- The first statement aborts, before anything is dropped, if any of these tables has a row.
SELECT CASE WHEN
  (SELECT count(*) FROM question_requests) +
  (SELECT count(*) FROM question_request_results) +
  (SELECT count(*) FROM question_request_clarifications) +
  (SELECT count(*) FROM question_request_notifications) +
  (SELECT count(*) FROM question_request_refresh_counts) +
  (SELECT count(*) FROM question_request_result_refreshes) +
  (SELECT count(*) FROM question_request_confirmation_context) +
  (SELECT count(*) FROM question_request_confirmations) +
  (SELECT count(*) FROM question_request_local_notifications) > 0
THEN abs(-9223372036854775808) END;
DROP TRIGGER exploration_request_links_orphan_collect;
DROP TRIGGER exploration_shared_jobs_orphan_collect;
DROP VIEW exploration_collectable_requests;
DROP TABLE question_request_local_notifications;
DROP TABLE question_request_confirmations;
DROP TABLE question_request_confirmation_context;
DROP TABLE question_request_result_refreshes;
DROP TABLE question_request_refresh_counts;
DROP TABLE question_request_notifications;
DROP TABLE question_request_clarifications;
DROP TABLE question_request_results;
DROP TABLE question_requests;
