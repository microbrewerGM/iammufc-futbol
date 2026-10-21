-- B14 season splits: derived aggregates only, one row per producer grain
-- (snapshot, season, PL, venue, opponent). Raw fixtures and events never land
-- here; points, goal difference and rates are derived at query time, so only
-- integer counts are stored. Additive and repeatable: older Workers ignore it.
-- No foreign key to snapshots, matching season_stats, so seed import order and
-- snapshot replacement cannot fail on this table.
CREATE TABLE IF NOT EXISTS season_splits (
  snapshot_id   TEXT NOT NULL CHECK (length(snapshot_id) = 64 AND snapshot_id NOT GLOB '*[^0-9a-f]*'),
  season        TEXT NOT NULL CHECK (
    length(season) = 7 AND
    season GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND
    CAST(substr(season, 6, 2) AS INTEGER) = (CAST(substr(season, 1, 4) AS INTEGER) + 1) % 100
  ),
  competition   TEXT NOT NULL CHECK (competition = 'PL'),
  venue         TEXT NOT NULL CHECK (venue IN ('home', 'away')),
  opponent_id   TEXT NOT NULL CHECK (
    length(opponent_id) BETWEEN 6 AND 23 AND
    opponent_id GLOB 'club:[1-9]*' AND
    substr(opponent_id, 6) NOT GLOB '*[^0-9]*'
  ),
  played        INTEGER NOT NULL CHECK (typeof(played) = 'integer' AND played >= 0),
  won           INTEGER NOT NULL CHECK (typeof(won) = 'integer' AND won >= 0),
  drawn         INTEGER NOT NULL CHECK (typeof(drawn) = 'integer' AND drawn >= 0),
  lost          INTEGER NOT NULL CHECK (typeof(lost) = 'integer' AND lost >= 0),
  goals_for     INTEGER NOT NULL CHECK (typeof(goals_for) = 'integer' AND goals_for >= 0),
  goals_against INTEGER NOT NULL CHECK (typeof(goals_against) = 'integer' AND goals_against >= 0),
  -- Attribution renders from lineage: bounded source IDs matching the catalog
  -- contract ([a-z][a-z0-9_]*), with tuple uniqueness enforced below.
  lineage_json  TEXT NOT NULL CHECK (
    length(lineage_json) BETWEEN 4 AND 8192 AND
    json_valid(lineage_json) AND
    json_type(lineage_json) = 'array' AND
    json_array_length(lineage_json) BETWEEN 1 AND 32
  ),
  CHECK (won + drawn + lost = played),
  PRIMARY KEY (snapshot_id, season, competition, venue, opponent_id)
) WITHOUT ROWID;

-- SQLite CHECK constraints cannot inspect json_each rows. Validate each
-- lineage tuple at write time; json_valid/shape checks above run first.
CREATE TRIGGER IF NOT EXISTS season_splits_lineage_insert
BEFORE INSERT ON season_splits
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.lineage_json)
  WHERE type != 'text'
     OR length(value) NOT BETWEEN 1 AND 128
     OR value GLOB '*[^a-z0-9_]*'
     OR substr(value, 1, 1) GLOB '[^a-z]'
) OR (
  SELECT count(*) FROM json_each(NEW.lineage_json)
) != (
  SELECT count(DISTINCT value) FROM json_each(NEW.lineage_json)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid season_splits lineage');
END;

CREATE TRIGGER IF NOT EXISTS season_splits_lineage_update
BEFORE UPDATE OF lineage_json ON season_splits
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.lineage_json)
  WHERE type != 'text'
     OR length(value) NOT BETWEEN 1 AND 128
     OR value GLOB '*[^a-z0-9_]*'
     OR substr(value, 1, 1) GLOB '[^a-z]'
) OR (
  SELECT count(*) FROM json_each(NEW.lineage_json)
) != (
  SELECT count(DISTINCT value) FROM json_each(NEW.lineage_json)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid season_splits lineage');
END;
