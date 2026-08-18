"""Pandera schemas for the ingest DataFrames.

Split from the plain assertions that used to live in run.py's validate():
Pandera owns per-row STRUCTURE (dtype, nullability, value ranges) -- the part
it is naturally good at, and the part every row must independently satisfy.
Cross-DataFrame business rules (player goals vs. league goals, duplicate
player_id across the whole frame) stay as explicit assertions in run.py,
because they compare rows across two DataFrames, which is not what a
column-wise schema validates.

Both halves run BEFORE anything is written. A failed gate fails the run.
"""

from __future__ import annotations

from pandera.pandas import Check, Column, DataFrameSchema

#: Controlled vocabulary, matching worker/src/core/locale.ts POSITION_LABELS.
#: A position outside this set means the FPL element_type mapping in run.py
#: has drifted -- fail loudly rather than let an unmapped code reach the site.
VALID_POSITIONS = {"GK", "DF", "MF", "FW"}

#: A Premier League season is 38 matches; nobody plays more than that many
#: full matches plus a generous margin for extra time in other competitions
#: FPL folds into the same `minutes` field. Catches a unit error (seconds
#: instead of minutes) rather than a real edge case.
MAX_PLAUSIBLE_MINUTES = 38 * 90 + 400

players_schema = DataFrameSchema(
    {
        "player_id": Column(str, Check.str_length(min_value=1), unique=True),
        "fpl_element": Column(int, Check.ge(0)),
        "season": Column(str, Check.str_matches(r"^\d{4}-\d{2}$")),
        "web_name": Column(str, Check.str_length(min_value=1)),
        "first_name": Column(str, nullable=False),
        "second_name": Column(str, Check.str_length(min_value=1)),
        "position": Column(str, Check.isin(VALID_POSITIONS)),
        "team": Column(str, Check.eq("Manchester United")),
        "goals": Column(int, Check.ge(0)),
        "assists": Column(int, Check.ge(0)),
        "minutes": Column(int, Check.in_range(0, MAX_PLAUSIBLE_MINUTES)),
        "points": Column(int, Check.ge(0)),
        # xG is genuinely absent before 2022-23 (FPL coverage gap, not a data
        # error) -- nullable, but never negative when present.
        "xg": Column(float, Check.ge(0), nullable=True),
    },
    strict=False,  # extra columns (e.g. intermediate computation columns) are fine
    coerce=True,
)

season_stats_schema = DataFrameSchema(
    {
        "season": Column(str, Check.str_matches(r"^\d{4}-\d{2}$"), unique=True),
        "competition": Column(str, Check.eq("PL")),
        "played": Column(int, Check.in_range(0, 38)),
        "won": Column(int, Check.ge(0)),
        "drawn": Column(int, Check.ge(0)),
        "lost": Column(int, Check.ge(0)),
        "goals": Column(int, Check.ge(0)),
        "goals_against": Column(int, Check.ge(0)),
    },
    strict=False,
    coerce=True,
    # played must equal won+drawn+lost -- a dataframe-wide check, expressible
    # here because it's within ONE frame (unlike the cross-frame checks that
    # stay in run.py).
    checks=Check(
        lambda df: (df["played"] == df["won"] + df["drawn"] + df["lost"]).all(),
        error="played must equal won + drawn + lost",
    ),
)


def validate_players(df):
    """Raises pandera.errors.SchemaErrors (collected, not fail-fast) with every
    violation listed, not just the first -- matters when this fails in CI and
    a human is reading the log on a phone."""
    return players_schema.validate(df, lazy=True)


def validate_season_stats(df):
    return season_stats_schema.validate(df, lazy=True)
