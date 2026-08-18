"""Negative cases for the Pandera schemas -- structural violations must be
CAUGHT, not silently coerced or dropped. Mirrors the project's broader
"never optimistic" principle: a schema that quietly accepts bad data is worse
than no schema.
"""

from __future__ import annotations

import pandas as pd
import pandera.errors
import pytest

from pipeline.sources.schemas import validate_players, validate_season_stats

VALID_PLAYER = {
    "player_id": "fpl:1:2024-25",
    "fpl_element": 1,
    "season": "2024-25",
    "web_name": "Fernandes",
    "first_name": "Bruno",
    "second_name": "Borges Fernandes",
    "position": "MF",
    "team": "Manchester United",
    "goals": 8,
    "assists": 12,
    "minutes": 3017,
    "points": 174,
    "xg": 9.93,
}

VALID_SEASON = {
    "season": "2024-25",
    "competition": "PL",
    "played": 38,
    "won": 11,
    "drawn": 9,
    "lost": 18,
    "goals": 44,
    "goals_against": 58,
}


def players_df(**overrides) -> pd.DataFrame:
    row = {**VALID_PLAYER, **overrides}
    return pd.DataFrame([row])


def season_df(**overrides) -> pd.DataFrame:
    row = {**VALID_SEASON, **overrides}
    return pd.DataFrame([row])


def test_valid_player_row_passes():
    validate_players(players_df())  # must not raise


def test_valid_season_row_passes():
    validate_season_stats(season_df())  # must not raise


def test_negative_goals_rejected():
    with pytest.raises(pandera.errors.SchemaErrors):
        validate_players(players_df(goals=-1))


def test_unmapped_position_rejected():
    # The exact bug class found in run.py: FPL element_type 5 (manager) once
    # slipped through as an unmapped position before the ingest script
    # excluded managers explicitly. The schema is the second line of defence.
    with pytest.raises(pandera.errors.SchemaErrors):
        validate_players(players_df(position="MANAGER"))


def test_implausible_minutes_rejected():
    with pytest.raises(pandera.errors.SchemaErrors):
        validate_players(players_df(minutes=100_000))


def test_negative_xg_rejected():
    with pytest.raises(pandera.errors.SchemaErrors):
        validate_players(players_df(xg=-0.5))


def test_missing_xg_is_allowed():
    # xG genuinely does not exist before 2022-23 -- nullable, not an error.
    validate_players(players_df(xg=None, season="2016-17"))


def test_wrong_team_rejected():
    # This pipeline exists to serve Manchester United data only. A row for
    # any other club is either an upstream bug or a scope violation, either
    # way it must not silently enter the gold layer.
    with pytest.raises(pandera.errors.SchemaErrors):
        validate_players(players_df(team="Liverpool"))


def test_malformed_season_string_rejected():
    with pytest.raises(pandera.errors.SchemaErrors):
        validate_players(players_df(season="2024/25"))


def test_duplicate_player_id_rejected():
    df = pd.concat([players_df(), players_df()], ignore_index=True)
    with pytest.raises(pandera.errors.SchemaErrors):
        validate_players(df)


def test_played_must_equal_sum_of_results():
    with pytest.raises(pandera.errors.SchemaErrors):
        validate_season_stats(season_df(played=99))


def test_negative_season_goals_rejected():
    with pytest.raises(pandera.errors.SchemaErrors):
        validate_season_stats(season_df(goals=-1))


def test_lazy_validation_reports_multiple_violations_at_once():
    """A human reading a failure on a phone should see every problem in one
    pass, not fix one and re-run to discover the next."""
    bad = players_df(goals=-1, minutes=100_000, position="MANAGER")
    with pytest.raises(pandera.errors.SchemaErrors) as exc_info:
        validate_players(bad)
    failures = exc_info.value.failure_cases
    flagged_columns = set(failures["column"])
    assert {"goals", "minutes", "position"}.issubset(flagged_columns)
