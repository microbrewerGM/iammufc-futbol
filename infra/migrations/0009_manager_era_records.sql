-- Manager-era aggregates are stored per season so selected seasons can be
-- summed by the site. Attribution renders from bounded lineage source IDs.
CREATE TABLE IF NOT EXISTS manager_era_season_records (
  snapshot_id   TEXT NOT NULL CHECK (length(snapshot_id) = 64 AND snapshot_id NOT GLOB '*[^0-9a-f]*'),
  season        TEXT NOT NULL CHECK (
    length(season) = 7 AND
    season GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND
    CAST(substr(season, 6, 2) AS INTEGER) = (CAST(substr(season, 1, 4) AS INTEGER) + 1) % 100
  ),
  tenure_id     TEXT NOT NULL CHECK (
    length(tenure_id) BETWEEN 8 AND 64 AND tenure_id GLOB 'tenure:*' AND
    tenure_id NOT GLOB '*[^a-z0-9:_-]*'
  ),
  manager_id    TEXT NOT NULL CHECK (
    length(manager_id) BETWEEN 9 AND 64 AND manager_id GLOB 'manager:*' AND
    manager_id NOT GLOB '*[^a-z0-9:_-]*'
  ),
  role          TEXT NOT NULL CHECK (role IN ('manager', 'caretaker')),
  played        INTEGER NOT NULL CHECK (typeof(played) = 'integer' AND played >= 0),
  won           INTEGER NOT NULL CHECK (typeof(won) = 'integer' AND won >= 0),
  drawn         INTEGER NOT NULL CHECK (typeof(drawn) = 'integer' AND drawn >= 0),
  lost          INTEGER NOT NULL CHECK (typeof(lost) = 'integer' AND lost >= 0),
  goals_for     INTEGER NOT NULL CHECK (typeof(goals_for) = 'integer' AND goals_for >= 0),
  goals_against INTEGER NOT NULL CHECK (typeof(goals_against) = 'integer' AND goals_against >= 0),
  lineage_json  TEXT NOT NULL CHECK (
    length(lineage_json) BETWEEN 4 AND 8192 AND json_valid(lineage_json) AND
    json_type(lineage_json) = 'array' AND json_array_length(lineage_json) BETWEEN 1 AND 32
  ),
  CHECK (won + drawn + lost = played),
  PRIMARY KEY (snapshot_id, season, tenure_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS manager_era_season_unassigned (
  snapshot_id   TEXT NOT NULL CHECK (length(snapshot_id) = 64 AND snapshot_id NOT GLOB '*[^0-9a-f]*'),
  season        TEXT NOT NULL CHECK (
    length(season) = 7 AND
    season GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND
    CAST(substr(season, 6, 2) AS INTEGER) = (CAST(substr(season, 1, 4) AS INTEGER) + 1) % 100
  ),
  reason        TEXT NOT NULL CHECK (reason IN ('boundary_unresolved', 'tenure_overlap', 'date_uncertain', 'tenure_missing')),
  played        INTEGER NOT NULL CHECK (typeof(played) = 'integer' AND played >= 0),
  won           INTEGER NOT NULL CHECK (typeof(won) = 'integer' AND won >= 0),
  drawn         INTEGER NOT NULL CHECK (typeof(drawn) = 'integer' AND drawn >= 0),
  lost          INTEGER NOT NULL CHECK (typeof(lost) = 'integer' AND lost >= 0),
  goals_for     INTEGER NOT NULL CHECK (typeof(goals_for) = 'integer' AND goals_for >= 0),
  goals_against INTEGER NOT NULL CHECK (typeof(goals_against) = 'integer' AND goals_against >= 0),
  lineage_json  TEXT NOT NULL CHECK (
    length(lineage_json) BETWEEN 4 AND 8192 AND json_valid(lineage_json) AND
    json_type(lineage_json) = 'array' AND json_array_length(lineage_json) BETWEEN 1 AND 32
  ),
  CHECK (won + drawn + lost = played),
  PRIMARY KEY (snapshot_id, season, reason)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS manager_era_season_coverage (
  snapshot_id TEXT NOT NULL CHECK (length(snapshot_id) = 64 AND snapshot_id NOT GLOB '*[^0-9a-f]*'),
  season      TEXT NOT NULL CHECK (
    length(season) = 7 AND
    season GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND
    CAST(substr(season, 6, 2) AS INTEGER) = (CAST(substr(season, 1, 4) AS INTEGER) + 1) % 100
  ),
  coverage    TEXT NOT NULL CHECK (coverage IN ('complete', 'partial', 'missing')),
  completed   INTEGER NOT NULL CHECK (typeof(completed) = 'integer' AND completed >= 0),
  unfinished  INTEGER NOT NULL CHECK (typeof(unfinished) = 'integer' AND unfinished >= 0),
  ambiguous   INTEGER NOT NULL CHECK (typeof(ambiguous) = 'integer' AND ambiguous >= 0),
  lineage_json TEXT NOT NULL CHECK (
    length(lineage_json) BETWEEN 4 AND 8192 AND json_valid(lineage_json) AND
    json_type(lineage_json) = 'array' AND json_array_length(lineage_json) BETWEEN 1 AND 32
  ),
  PRIMARY KEY (snapshot_id, season)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS manager_era_managers (
  snapshot_id TEXT NOT NULL CHECK (length(snapshot_id) = 64 AND snapshot_id NOT GLOB '*[^0-9a-f]*'),
  manager_id  TEXT NOT NULL CHECK (
    length(manager_id) BETWEEN 9 AND 64 AND manager_id GLOB 'manager:*' AND
    manager_id NOT GLOB '*[^a-z0-9:_-]*'
  ),
  label       TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80 AND label NOT GLOB '*[' || char(1) || '-' || char(31) || ']*'),
  lineage_json TEXT NOT NULL CHECK (
    length(lineage_json) BETWEEN 4 AND 8192 AND json_valid(lineage_json) AND
    json_type(lineage_json) = 'array' AND json_array_length(lineage_json) BETWEEN 1 AND 32
  ),
  PRIMARY KEY (snapshot_id, manager_id)
) WITHOUT ROWID;

-- Validate lineage tuples on insert and update, as SQLite CHECK cannot inspect
-- json_each rows. Repeated for each table to keep writes locally constrained.
CREATE TRIGGER IF NOT EXISTS manager_era_records_lineage_insert
BEFORE INSERT ON manager_era_season_records
WHEN EXISTS (SELECT 1 FROM json_each(NEW.lineage_json) WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 128 OR value GLOB '*[^a-z0-9_]*' OR substr(value, 1, 1) GLOB '[^a-z]')
 OR (SELECT count(*) FROM json_each(NEW.lineage_json)) != (SELECT count(DISTINCT value) FROM json_each(NEW.lineage_json))
BEGIN SELECT RAISE(ABORT, 'invalid manager era lineage'); END;
CREATE TRIGGER IF NOT EXISTS manager_era_records_lineage_update
BEFORE UPDATE OF lineage_json ON manager_era_season_records
WHEN EXISTS (SELECT 1 FROM json_each(NEW.lineage_json) WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 128 OR value GLOB '*[^a-z0-9_]*' OR substr(value, 1, 1) GLOB '[^a-z]')
 OR (SELECT count(*) FROM json_each(NEW.lineage_json)) != (SELECT count(DISTINCT value) FROM json_each(NEW.lineage_json))
BEGIN SELECT RAISE(ABORT, 'invalid manager era lineage'); END;

CREATE TRIGGER IF NOT EXISTS manager_era_unassigned_lineage_insert
BEFORE INSERT ON manager_era_season_unassigned
WHEN EXISTS (SELECT 1 FROM json_each(NEW.lineage_json) WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 128 OR value GLOB '*[^a-z0-9_]*' OR substr(value, 1, 1) GLOB '[^a-z]')
 OR (SELECT count(*) FROM json_each(NEW.lineage_json)) != (SELECT count(DISTINCT value) FROM json_each(NEW.lineage_json))
BEGIN SELECT RAISE(ABORT, 'invalid manager era lineage'); END;
CREATE TRIGGER IF NOT EXISTS manager_era_unassigned_lineage_update
BEFORE UPDATE OF lineage_json ON manager_era_season_unassigned
WHEN EXISTS (SELECT 1 FROM json_each(NEW.lineage_json) WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 128 OR value GLOB '*[^a-z0-9_]*' OR substr(value, 1, 1) GLOB '[^a-z]')
 OR (SELECT count(*) FROM json_each(NEW.lineage_json)) != (SELECT count(DISTINCT value) FROM json_each(NEW.lineage_json))
BEGIN SELECT RAISE(ABORT, 'invalid manager era lineage'); END;

CREATE TRIGGER IF NOT EXISTS manager_era_coverage_lineage_insert
BEFORE INSERT ON manager_era_season_coverage
WHEN EXISTS (SELECT 1 FROM json_each(NEW.lineage_json) WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 128 OR value GLOB '*[^a-z0-9_]*' OR substr(value, 1, 1) GLOB '[^a-z]')
 OR (SELECT count(*) FROM json_each(NEW.lineage_json)) != (SELECT count(DISTINCT value) FROM json_each(NEW.lineage_json))
BEGIN SELECT RAISE(ABORT, 'invalid manager era lineage'); END;
CREATE TRIGGER IF NOT EXISTS manager_era_coverage_lineage_update
BEFORE UPDATE OF lineage_json ON manager_era_season_coverage
WHEN EXISTS (SELECT 1 FROM json_each(NEW.lineage_json) WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 128 OR value GLOB '*[^a-z0-9_]*' OR substr(value, 1, 1) GLOB '[^a-z]')
 OR (SELECT count(*) FROM json_each(NEW.lineage_json)) != (SELECT count(DISTINCT value) FROM json_each(NEW.lineage_json))
BEGIN SELECT RAISE(ABORT, 'invalid manager era lineage'); END;

CREATE TRIGGER IF NOT EXISTS manager_era_managers_lineage_insert
BEFORE INSERT ON manager_era_managers
WHEN EXISTS (SELECT 1 FROM json_each(NEW.lineage_json) WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 128 OR value GLOB '*[^a-z0-9_]*' OR substr(value, 1, 1) GLOB '[^a-z]')
 OR (SELECT count(*) FROM json_each(NEW.lineage_json)) != (SELECT count(DISTINCT value) FROM json_each(NEW.lineage_json))
BEGIN SELECT RAISE(ABORT, 'invalid manager era lineage'); END;
CREATE TRIGGER IF NOT EXISTS manager_era_managers_lineage_update
BEFORE UPDATE OF lineage_json ON manager_era_managers
WHEN EXISTS (SELECT 1 FROM json_each(NEW.lineage_json) WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 128 OR value GLOB '*[^a-z0-9_]*' OR substr(value, 1, 1) GLOB '[^a-z]')
 OR (SELECT count(*) FROM json_each(NEW.lineage_json)) != (SELECT count(DISTINCT value) FROM json_each(NEW.lineage_json))
BEGIN SELECT RAISE(ABORT, 'invalid manager era lineage'); END;
