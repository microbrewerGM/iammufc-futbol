-- P16: widen the finite visualization telemetry vocabulary without losing
-- existing counters. SQLite cannot alter a CHECK constraint in place, so the
-- table is rebuilt atomically under the same name. The old Worker remains
-- compatible throughout: every value it can write is still accepted.
DROP TABLE IF EXISTS query_demand_aggregate_p16;
CREATE TABLE query_demand_aggregate_p16 (
  metric            TEXT NOT NULL CHECK (metric IN ('goals', 'assists', 'minutes', 'points', 'xg', 'progressive_passes', 'other')),
  question_family   TEXT NOT NULL CHECK (question_family IN ('player_ranking', 'player_lookup', 'team_season', 'match', 'opponent', 'competition')),
  viz               TEXT NOT NULL CHECK (viz IN ('table', 'bar', 'dot_plot', 'line', 'shot_map', 'pass_map', 'heatmap')),
  feasibility_state TEXT NOT NULL CHECK (feasibility_state IN ('available', 'computable_now_queued', 'computable_but_expensive', 'no_data', 'no_rights')),
  cache_outcome     TEXT NOT NULL CHECK (cache_outcome IN ('hit', 'miss', 'unavailable', 'not_applicable')),
  result_outcome    TEXT NOT NULL CHECK (result_outcome IN ('success', 'refused', 'budget_exceeded')),
  locale            TEXT NOT NULL CHECK (locale IN ('api', 'en', 'es')),
  route_family      TEXT NOT NULL CHECK (route_family IN ('query_api', 'query_page', 'ask_page')),
  request_count     INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  PRIMARY KEY (metric, question_family, viz, feasibility_state, cache_outcome, result_outcome, locale, route_family)
) WITHOUT ROWID;

INSERT INTO query_demand_aggregate_p16
SELECT metric, question_family, viz, feasibility_state, cache_outcome,
       result_outcome, locale, route_family, request_count
  FROM query_demand_aggregate;

DROP TABLE query_demand_aggregate;
ALTER TABLE query_demand_aggregate_p16 RENAME TO query_demand_aggregate;
