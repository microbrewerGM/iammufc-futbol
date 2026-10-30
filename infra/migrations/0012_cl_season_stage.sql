-- Champions League stage reached per published snapshot and season.
CREATE TABLE IF NOT EXISTS cl_season_stage (
  snapshot_id TEXT NOT NULL,
  season TEXT NOT NULL,
  stage_reached TEXT NOT NULL CHECK (stage_reached IN (
    'group_stage', 'league_phase', 'knockout_playoff', 'round_of_16',
    'quarter_final', 'semi_final', 'final', 'winner'
  )),
  PRIMARY KEY (snapshot_id, season)
) WITHOUT ROWID;
