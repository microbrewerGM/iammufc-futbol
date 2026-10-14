-- Bound advisory query-cache storage while retaining rollback-safe query
-- behavior for older Workers. The old cache is empty and write-disabled;
-- legacy Workers catch the resulting write error and compute normally.
CREATE TABLE IF NOT EXISTS query_result_cache_slots (
  slot           INTEGER PRIMARY KEY CHECK (typeof(slot) = 'integer' AND slot >= 0 AND slot < 512),
  artifact_key   TEXT NOT NULL CHECK (length(artifact_key) = 64 AND artifact_key NOT GLOB '*[^0-9a-f]*'),
  snapshot_id    TEXT NOT NULL CHECK (length(snapshot_id) = 64 AND snapshot_id NOT GLOB '*[^0-9a-f]*'),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  result_json    TEXT NOT NULL CHECK (length(result_json) BETWEEN 1 AND 100000)
) WITHOUT ROWID;

-- Retain the legacy table so a rollback Worker can execute its reads. Clear
-- only cache contents and prevent old binaries from repopulating it.
DELETE FROM query_result_cache;

CREATE TRIGGER IF NOT EXISTS query_result_cache_disable_insert
BEFORE INSERT ON query_result_cache
BEGIN
  SELECT RAISE(ABORT, 'legacy query cache writes disabled');
END;

CREATE TRIGGER IF NOT EXISTS query_result_cache_disable_update
BEFORE UPDATE ON query_result_cache
BEGIN
  SELECT RAISE(ABORT, 'legacy query cache writes disabled');
END;
