"""PoC ingest: FPL box scores + PDDL match results -> gold -> D1 seed SQL.

Deliberately a plain script, not a Workflow. M1 runs on the free tier with no
Containers, no Queues, no R2. The orchestration arrives at M2; the shape of the
output does not change when it does.

Properties that are NOT deferrable, because retrofitting them is what costs:
  * idempotent -- same upstream bytes produce the same snapshot id
  * validated  -- Pandera gates run before anything is written
  * lineage    -- every row carries the snapshot it came from
  * no data in the repo -- the seed is generated and gitignored
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import pandera.errors
import requests

from pipeline.sources.ingest_openfootball_cl import OpenfootballCLError
from pipeline.sources.ingest_openfootball_cl import fetch_all as fetch_cl_all
from pipeline.sources.schemas import validate_players, validate_season_stats

REPO_ROOT = Path(__file__).resolve().parents[2]
SEED_PATH = REPO_ROOT / "infra" / "migrations" / "0002_seed.sql"

SEASONS = [
    "2016-17",
    "2017-18",
    "2018-19",
    "2019-20",
    "2020-21",
    "2021-22",
    "2022-23",
    "2023-24",
    "2024-25",
    "2025-26",
]

#: FPL publishes `expected_goals` from 2022-23 onward only. Earlier seasons get
#: NULL, never 0 -- zero would assert we measured nothing, which is a quiet lie.
#: This is a real coverage gap and the matrix is supposed to show it.
XG_FROM_SEASON = "2022-23"

#: Fixture-side club attribution is possible from 2018-19 onward. The archive
#: has neither fixtures nor row-level team membership for the two earlier
#: seasons, so their player totals cannot be represented as United-only facts.
PLAYER_FROM_SEASON = "2018-19"

#: FPL data via the community archive. The live API carries only the current
#: season; the archive carries changing historical schemas from 2016-17 onward.
FPL_BASE = "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data"

#: Football-Data.co.uk via the datahub mirror, NOT the origin site. The mirror
#: carries an explicit ODC-PDDL dedication; the origin does not. Our own rights
#: snapshot (catalog/rights/sources/football-data-couk.md) requires the mirror.
RESULTS_BASE = "https://raw.githubusercontent.com/datasets/football-datasets/main/datasets/premier-league"

SEASON_TO_MIRROR = {s: s[2:4] + s[5:7] for s in SEASONS}

#: FPL `team_code` is a STABLE club identifier across seasons; Manchester
#: United is 1. Use it rather than joining teams.csv, which does not exist for
#: 2016-17 through 2018-19, and rather than the per-season `team` id, which is
#: a league-position-ordered index that changes every year.
TEAM_CODE_MUFC = 1
TEAM_NAMES_RESULTS = {"Man United", "Manchester United", "Man Utd"}

#: FPL element_type -> position code. Type 5 is MANAGER, introduced in 2024-25.
#: Managers are not players and are excluded rather than mapped: a manager in a
#: "top scorers" chart would be silently wrong, and the site's whole value is
#: not being silently wrong.
POSITION_CODES = {1: "GK", 2: "DF", 3: "MF", 4: "FW"}
NON_PLAYER_ELEMENT_TYPES = {5}

#: Observed archive-wide differences after exact duplicate/reschedule collapse.
#: These are aggregate tolerances, not per-player waivers: any missing or added
#: history changes the season total and fails publication. Re-inventory before
#: changing them; zero is required for every unlisted season/field.
ARCHIVE_AGGREGATE_DELTAS: dict[str, dict[str, int]] = {
    "2018-19": {"minutes": -3},
    "2024-25": {"minutes": -17, "total_points": -1},
}

TIMEOUT = 60
HEADERS = {"User-Agent": "iammufc-poc/0.1 (non-commercial fan project)"}

SOURCE_FPL = "fpl"
SOURCE_PL_RESULTS = "football_data_couk"
SOURCE_CL_RESULTS = "openfootball_cl"


class IngestError(Exception):
    """Fatal. A failed ingest must never publish partial data."""


def fetch(url: str) -> bytes:
    resp = requests.get(url, timeout=TIMEOUT, headers=HEADERS)
    if resp.status_code != 200:
        raise IngestError(f"{url} returned HTTP {resp.status_code}")
    return resp.content


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def utc_now() -> str:
    """UTC timestamp injection point for deterministic publication tests."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Extract
# ---------------------------------------------------------------------------


def _read_archive_csv(payload: bytes) -> pd.DataFrame:
    """Read archive bytes without silently replacing legacy characters."""
    try:
        return pd.read_csv(io.BytesIO(payload))
    except UnicodeDecodeError:
        return pd.read_csv(io.BytesIO(payload), encoding="latin-1")


def _integer_column(frame: pd.DataFrame, column: str, season: str) -> pd.Series:
    try:
        values = pd.to_numeric(frame[column], errors="raise")
    except (KeyError, TypeError, ValueError) as exc:
        raise IngestError(f"{season}: {column} must be numeric") from exc
    if values.isna().any() or (values % 1 != 0).any():
        raise IngestError(f"{season}: {column} must contain finite integers")
    return values.astype(int)


def player_frame_from_payloads(
    season: str,
    players_raw: bytes,
    gameweeks_raw: bytes,
    fixtures_raw: bytes,
) -> pd.DataFrame:
    """Build United-only season totals from fixture-attributed FPL rows."""
    players = _read_archive_csv(players_raw)
    gameweeks = _read_archive_csv(gameweeks_raw).drop_duplicates().reset_index(drop=True)
    fixtures = _read_archive_csv(fixtures_raw)

    player_required = {
        "id", "team", "team_code", "element_type", "web_name", "first_name",
        "second_name", "goals_scored", "assists", "minutes", "total_points",
    }
    gw_required = {
        "element", "fixture", "GW", "was_home", "goals_scored", "assists",
        "minutes", "total_points",
    }
    fixture_required = {"id", "team_h", "team_a"}
    for label, frame, required in [
        ("players_raw.csv", players, player_required),
        ("gws/merged_gw.csv", gameweeks, gw_required),
        ("fixtures.csv", fixtures, fixture_required),
    ]:
        missing = required - set(frame.columns)
        if missing:
            raise IngestError(f"{season}: {label} missing {sorted(missing)}")

    players["id"] = _integer_column(players, "id", season)
    players["team"] = _integer_column(players, "team", season)
    players["team_code"] = _integer_column(players, "team_code", season)
    gameweeks["element"] = _integer_column(gameweeks, "element", season)
    gameweeks["fixture"] = _integer_column(gameweeks, "fixture", season)
    gameweeks["GW"] = _integer_column(gameweeks, "GW", season)
    additive = {
        "goals_scored": "goals",
        "assists": "assists",
        "minutes": "minutes",
        "total_points": "points",
    }
    for column in additive:
        gameweeks[column] = _integer_column(gameweeks, column, season)
    published_columns = list(additive)
    if season >= XG_FROM_SEASON:
        if "expected_goals" not in gameweeks.columns:
            raise IngestError(
                f"{season}: expected_goals is missing but should exist from {XG_FROM_SEASON} onward"
            )
        try:
            gameweeks["expected_goals"] = pd.to_numeric(
                gameweeks["expected_goals"], errors="raise"
            )
        except (TypeError, ValueError) as exc:
            raise IngestError(f"{season}: expected_goals must be numeric") from exc
        finite_xg = gameweeks["expected_goals"].map(
            lambda value: math.isfinite(float(value))
        )
        if not finite_xg.all() or (gameweeks["expected_goals"] < 0).any():
            raise IngestError(f"{season}: expected_goals must be finite and non-negative")
        published_columns.append("expected_goals")
    fixtures["id"] = _integer_column(fixtures, "id", season)
    fixtures["team_h"] = _integer_column(fixtures, "team_h", season)
    fixtures["team_a"] = _integer_column(fixtures, "team_a", season)

    mufc_ids = sorted(players.loc[players["team_code"] == TEAM_CODE_MUFC, "team"].unique())
    if len(mufc_ids) != 1:
        raise IngestError(
            f"{season}: stable United team_code maps to {len(mufc_ids)} season team ids"
        )
    mufc_id = int(mufc_ids[0])

    key = ["element", "fixture", "GW"]
    conflicts = gameweeks[gameweeks.duplicated(key, keep=False)]
    if not conflicts.empty:
        raise IngestError(
            f"{season}: merged gameweeks contain {len(conflicts)} conflicting fixture rows"
        )
    # 2019-20 reschedules retain a zero-valued row at the original GW and the
    # real row at the later GW for the same player/fixture. Collapse only that
    # evidenced shape. Any earlier contribution would be double-counting risk.
    pair_key = ["element", "fixture"]
    repeated = gameweeks[gameweeks.duplicated(pair_key, keep=False)]
    if not repeated.empty:
        latest = repeated.groupby(pair_key)["GW"].idxmax()
        earlier = repeated.drop(index=latest)
        if not earlier[published_columns].eq(0).all().all():
            raise IngestError(f"{season}: repeated fixtures contain earlier contributions")
        gameweeks = gameweeks.drop(index=earlier.index).reset_index(drop=True)
    if gameweeks.duplicated(pair_key).any():
        raise IngestError(f"{season}: repeated fixtures cannot be resolved uniquely")
    if fixtures["id"].duplicated().any():
        raise IngestError(f"{season}: fixtures contain duplicate ids")

    home_raw = gameweeks["was_home"]
    if pd.api.types.is_bool_dtype(home_raw):
        was_home = home_raw.astype(bool)
    else:
        normalized = home_raw.astype(str).str.lower()
        if not normalized.isin({"true", "false"}).all():
            raise IngestError(f"{season}: was_home contains non-boolean values")
        was_home = normalized.eq("true")

    fixture_sides = fixtures[["id", "team_h", "team_a"]].rename(columns={"id": "fixture"})
    try:
        joined = gameweeks.merge(
            fixture_sides, on="fixture", how="left", validate="many_to_one", indicator=True
        )
    except pd.errors.MergeError as exc:
        raise IngestError(f"{season}: fixture join is not many-to-one") from exc
    if not joined["_merge"].eq("both").all():
        raise IngestError(f"{season}: gameweek rows reference missing fixtures")
    joined["fixture_team"] = joined["team_a"].where(~was_home, joined["team_h"])

    if "team" in joined.columns:
        explicit_united = joined["team"].astype(str).eq("Man Utd")
        derived_united = joined["fixture_team"].eq(mufc_id)
        if not explicit_united.eq(derived_united).all():
            raise IngestError(f"{season}: explicit and fixture-derived club attribution disagree")

    united = joined[joined["fixture_team"].eq(mufc_id)].copy()
    if united.empty:
        raise IngestError(f"{season}: no fixture-attributed Manchester United player rows")

    # Reconcile complete all-club history for every player the source associates
    # with United: anyone with a United fixture row plus the final United squad.
    # This covers arrivals and departures without requiring unrelated clubs'
    # historical rows to satisfy our publication contract.
    full_totals = gameweeks.groupby("element", as_index=True)[list(additive)].sum()
    non_players_mask = players["element_type"].isin(NON_PLAYER_ELEMENT_TYPES)
    player_rows = players[~non_players_mask]
    player_ids = player_rows["id"].astype(int)
    aligned_totals = full_totals.reindex(player_ids, fill_value=0)
    for column in additive:
        expected_total = int(_integer_column(player_rows, column, season).sum())
        actual_total = int(aligned_totals[column].sum())
        allowed_delta = ARCHIVE_AGGREGATE_DELTAS.get(season, {}).get(column, 0)
        if actual_total - expected_total != allowed_delta:
            raise IngestError(
                f"{season}: archive-wide {column} aggregate does not reconcile"
            )
    # Goals and assists reconcile archive-wide in every supported season. Keep
    # that broader invariant so a departed United scorer cannot disappear by
    # losing every United-tagged row. Minutes/points have isolated upstream
    # anomalies outside the United cohort, so their stronger reconciliation is
    # scoped below to identities the archive associates with United.
    for _, player in player_rows.iterrows():
        element = int(player["id"])
        for column in ["goals_scored", "assists"]:
            expected = int(_integer_column(pd.DataFrame([player]), column, season).iloc[0])
            actual = int(full_totals.loc[element, column]) if element in full_totals.index else 0
            if actual != expected:
                raise IngestError(f"{season}: archive-wide {column} does not reconcile")
    relevant_elements = set(united["element"].astype(int)) | set(
        players.loc[players["team_code"] == TEAM_CODE_MUFC, "id"].astype(int)
    )
    for _, player in players[
        players["id"].isin(relevant_elements)
        & ~non_players_mask
    ].iterrows():
        expected = {
            column: int(_integer_column(pd.DataFrame([player]), column, season).iloc[0])
            for column in additive
        }
        element = int(player["id"])
        if element not in full_totals.index:
            if any(expected.values()):
                raise IngestError(f"{season}: player snapshot lacks gameweek history")
            continue
        for column, value in expected.items():
            if int(full_totals.loc[element, column]) != value:
                raise IngestError(f"{season}: all-club {column} does not reconcile with snapshot")
    totals = united.groupby("element", as_index=False)[list(additive)].sum().rename(
        columns=additive
    )
    if season >= XG_FROM_SEASON:
        xg = united.groupby("element", as_index=False)["expected_goals"].sum().rename(
            columns={"expected_goals": "xg"}
        )
        totals = totals.merge(xg, on="element", validate="one_to_one")
    else:
        totals["xg"] = None

    if players["id"].duplicated().any():
        raise IngestError(f"{season}: players_raw.csv contains duplicate ids")
    dimensions = players[players["id"].isin(totals["element"])].copy()
    if len(dimensions) != len(totals):
        raise IngestError(f"{season}: fixture-attributed players lack dimension rows")

    non_players = dimensions[dimensions["element_type"].isin(NON_PLAYER_ELEMENT_TYPES)]
    if not non_players.empty:
        print(
            f"    excluding {len(non_players)} non-player entries "
            f"({', '.join(non_players['web_name'].astype(str))})",
            file=sys.stderr,
        )
    dimensions = dimensions[~dimensions["element_type"].isin(NON_PLAYER_ELEMENT_TYPES)]
    unknown = sorted(set(dimensions["element_type"].astype(int)) - set(POSITION_CODES))
    if unknown:
        raise IngestError(
            f"{season}: unmapped FPL element_type(s) {unknown}. Upstream schema changed"
        )

    dimension_columns = [
        "id", "element_type", "web_name", "first_name", "second_name"
    ]
    combined = dimensions[dimension_columns].merge(
        totals, left_on="id", right_on="element", validate="one_to_one"
    )
    out = pd.DataFrame(
        {
            "fpl_element": combined["id"].astype(int),
            "season": season,
            "web_name": combined["web_name"].astype(str),
            "first_name": combined["first_name"].astype(str),
            "second_name": combined["second_name"].astype(str),
            "position": combined["element_type"].astype(int).map(POSITION_CODES),
            "team": "Manchester United",
            "goals": combined["goals"].astype(int),
            "assists": combined["assists"].astype(int),
            "minutes": combined["minutes"].astype(int),
            "points": combined["points"].astype(int),
            "xg": pd.to_numeric(combined["xg"], errors="coerce"),
        }
    )
    out["player_id"] = "fpl:" + out["fpl_element"].astype(str) + ":" + season
    return out


def load_players(season: str) -> tuple[pd.DataFrame, dict[str, str]]:
    """Manchester United-only player box scores for one attributable season."""
    players_raw = fetch(f"{FPL_BASE}/{season}/players_raw.csv")
    gameweeks_raw = fetch(f"{FPL_BASE}/{season}/gws/merged_gw.csv")
    fixtures_raw = fetch(f"{FPL_BASE}/{season}/fixtures.csv")
    return player_frame_from_payloads(season, players_raw, gameweeks_raw, fixtures_raw), {
        f"fpl_players:{season}": sha256(players_raw),
        f"fpl_gameweeks:{season}": sha256(gameweeks_raw),
        f"fpl_fixtures:{season}": sha256(fixtures_raw),
    }


def load_results(season: str) -> tuple[pd.DataFrame, str]:
    """Manchester United league record for one season, from PDDL match results."""
    raw = fetch(f"{RESULTS_BASE}/season-{SEASON_TO_MIRROR[season]}.csv")
    df = pd.read_csv(io.BytesIO(raw))

    required = {"HomeTeam", "AwayTeam", "FTHG", "FTAG"}
    if not required.issubset(df.columns):
        raise IngestError(f"{season}: results CSV missing {required - set(df.columns)}")

    df = df.dropna(subset=["FTHG", "FTAG"])
    home = df[df["HomeTeam"].isin(TEAM_NAMES_RESULTS)]
    away = df[df["AwayTeam"].isin(TEAM_NAMES_RESULTS)]
    if home.empty and away.empty:
        raise IngestError(
            f"{season}: no Manchester United fixtures found. "
            f"Sample team names: {sorted(set(df['HomeTeam'].head(20)))}"
        )

    gf = int(home["FTHG"].sum() + away["FTAG"].sum())
    ga = int(home["FTAG"].sum() + away["FTHG"].sum())
    won = int((home["FTHG"] > home["FTAG"]).sum() + (away["FTAG"] > away["FTHG"]).sum())
    lost = int((home["FTHG"] < home["FTAG"]).sum() + (away["FTAG"] < away["FTHG"]).sum())
    drawn = int((home["FTHG"] == home["FTAG"]).sum() + (away["FTAG"] == away["FTHG"]).sum())

    row = pd.DataFrame(
        [
            {
                "season": season,
                "competition": "PL",
                "played": won + drawn + lost,
                "won": won,
                "drawn": drawn,
                "lost": lost,
                "goals": gf,
                "goals_against": ga,
            }
        ]
    )
    return row, sha256(raw)


# ---------------------------------------------------------------------------
# Validate -- gates run BEFORE anything is written
# ---------------------------------------------------------------------------


def validate(players: pd.DataFrame, seasons: pd.DataFrame) -> None:
    """Fail the run rather than publish corrupt data.

    Two passes, doing different jobs:
      1. Pandera schemas (pipeline/sources/schemas.py) validate STRUCTURE --
         dtype, nullability, value ranges -- for each DataFrame independently.
      2. Plain assertions here check CROSS-FRAME business rules a column-wise
         schema cannot express: does one source's total roughly agree with the
         other's, is a row count what was requested. FPL and the PDDL results
         feed are independent, so disagreement between them is real signal,
         not a formatting quirk.
    """
    errors: list[str] = []

    # Pass 1: structural validation. lazy=True collects every violation
    # instead of stopping at the first -- matters when this fails in CI and a
    # human is reading the log on a phone.
    try:
        validate_players(players)
    except pandera.errors.SchemaErrors as exc:
        errors.append(f"players schema:\n{exc.failure_cases.to_string(index=False)}")

    try:
        validate_season_stats(seasons)
    except pandera.errors.SchemaErrors as exc:
        errors.append(f"season_stats schema:\n{exc.failure_cases.to_string(index=False)}")

    # Pandera already checks players is non-empty implicitly (empty frames
    # pass schema validation trivially), so an explicit belt-and-braces check
    # here catches the "technically valid, actually useless" empty-run case.
    if players.empty:
        errors.append("no player rows")
    # Exactly one PL row per season is guaranteed (football_data_couk, every
    # season). CL rows are additive and only present for seasons United
    # qualified, so the total row count is >= this, not ==.
    pl_count = len(seasons[seasons["competition"] == "PL"])
    if pl_count != len(SEASONS):
        errors.append(f"expected {len(SEASONS)} PL season rows, got {pl_count}")

    # Pass 2: cross-frame referential checks.
    if not errors:  # only meaningful once structure is confirmed sound
        for season in SEASONS:
            p_goals = int(players[players["season"] == season]["goals"].sum())
            # FPL points/goals are Premier-League-specific -- compare against
            # the PL row only, never CL, even when both exist for a season.
            season_row = seasons[(seasons["season"] == season) & (seasons["competition"] == "PL")]
            if season_row.empty:
                continue  # already reported by the row-count check above
            s_goals = int(season_row["goals"].iloc[0])
            # FPL counts all competitions in some fields; league goals should
            # not exceed the league total by a wide margin. Flag gross
            # divergence only.
            if s_goals > 0 and p_goals > s_goals * 2:
                errors.append(
                    f"{season}: player goals ({p_goals}) more than double league "
                    f"goals ({s_goals}) -- sources disagree"
                )

    if errors:
        raise IngestError("data-quality gate failed:\n  - " + "\n  - ".join(errors))


# ---------------------------------------------------------------------------
# Load
# ---------------------------------------------------------------------------


def sql_str(value) -> str:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return "NULL"
    if isinstance(value, (int,)):
        return str(value)
    if isinstance(value, float):
        return f"{value:.4f}"
    return "'" + str(value).replace("'", "''") + "'"


def emit_seed(
    players: pd.DataFrame,
    seasons: pd.DataFrame,
    snapshot_id: str,
    source_hashes: dict[str, str],
    source_statuses: dict[str, dict[str, str | None]],
) -> None:
    now = utc_now()
    counts = {"players": len(players), "season_stats": len(seasons)}

    lines = [
        "-- GENERATED FILE -- DO NOT COMMIT (gitignored).",
        "-- Regenerate: npm run ingest",
        f"-- snapshot: {snapshot_id}",
        f"-- generated: {now}",
        "",
        "DELETE FROM player_season_stats;",
        "DELETE FROM players;",
        "DELETE FROM season_stats;",
        "DELETE FROM snapshots;",
        "",
        "INSERT INTO snapshots (snapshot_id, created_at, sources_json, row_counts) VALUES ("
        f"{sql_str(snapshot_id)}, {sql_str(now)}, "
        f"{sql_str(json.dumps(source_hashes, sort_keys=True))}, "
        f"{sql_str(json.dumps(counts, sort_keys=True))});",
        "",
    ]

    for _, r in players.iterrows():
        lines.append(
            "INSERT INTO players (player_id, fpl_element, season, web_name, "
            "first_name, second_name, position, team) VALUES ("
            f"{sql_str(r['player_id'])}, {int(r['fpl_element'])}, {sql_str(r['season'])}, "
            f"{sql_str(r['web_name'])}, {sql_str(r['first_name'])}, "
            f"{sql_str(r['second_name'])}, {sql_str(r['position'])}, {sql_str(r['team'])});"
        )
    lines.append("")

    for _, r in players.iterrows():
        lines.append(
            "INSERT INTO player_season_stats (player_id, season, competition, goals, "
            "assists, minutes, points, xg, snapshot_id) VALUES ("
            f"{sql_str(r['player_id'])}, {sql_str(r['season'])}, 'PL', "
            f"{int(r['goals'])}, {int(r['assists'])}, {int(r['minutes'])}, "
            f"{int(r['points'])}, {sql_str(r['xg'])}, {sql_str(snapshot_id)});"
        )
    lines.append("")

    for _, r in seasons.iterrows():
        # r['competition'] is PL for every season (football_data_couk) and
        # additionally CL for seasons United qualified (football_data_org,
        # ADR-0005) -- no longer hardcoded now that both exist in the frame.
        lines.append(
            "INSERT INTO season_stats (season, competition, played, won, drawn, lost, "
            "goals, goals_against, snapshot_id) VALUES ("
            f"{sql_str(r['season'])}, {sql_str(r['competition'])}, {int(r['played'])}, "
            f"{int(r['won'])}, {int(r['drawn'])}, {int(r['lost'])}, {int(r['goals'])}, "
            f"{int(r['goals_against'])}, {sql_str(snapshot_id)});"
        )
    lines.append("")

    # Must remain the final statement: its presence proves every preceding data
    # statement in this seed completed. D1 owns the remote import transaction;
    # do not add BEGIN/COMMIT to this generated file.
    lines.append(
        "INSERT INTO publication_runs "
        "(snapshot_id, prepared_at, source_status_json) VALUES ("
        f"{sql_str(snapshot_id)}, {sql_str(now)}, "
        f"{sql_str(json.dumps(source_statuses, sort_keys=True))});"
    )
    lines.append("")

    SEED_PATH.parent.mkdir(parents=True, exist_ok=True)
    SEED_PATH.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    player_frames, season_frames = [], []
    source_hashes: dict[str, str] = {}

    for season in SEASONS:
        print(f"  fetching {season} ...", file=sys.stderr)
        results, rhash = load_results(season)
        season_frames.append(results)
        source_hashes[f"football_data_couk:{season}"] = rhash
        if season >= PLAYER_FROM_SEASON:
            players, player_hashes = load_players(season)
            player_frames.append(players)
            source_hashes.update(player_hashes)
            player_count = len(players)
        else:
            player_count = 0
        print(
            f"    {player_count} attributable players, {int(results.iloc[0]['played'])} matches",
            file=sys.stderr,
        )

    # Champions League, ADR-0005: additive on top of the PL rows above, only
    # for seasons United qualified. Source is openfootball (CC0, public
    # domain), NOT football-data.org, whose free tier returns 403 for CL match
    # data on every endpoint that carries it. Public domain also beats a
    # subscription-contingent grant on rights, which is what ADR-0005 asks for.
    # No API key, so nothing to gate this on and no credential to leak.
    print("  fetching Champions League (openfootball) ...", file=sys.stderr)
    try:
        cl_frame, cl_hashes = fetch_cl_all(SEASONS)
    except OpenfootballCLError as exc:
        # Not fatal, for the same reason as before: this is an additive bonus
        # source and the site's core is PL/FPL data. A loud warning is the only
        # signal that upstream changed shape, so it has to stay greppable.
        print(
            f"  WARNING: Champions League ingest skipped -- {exc}\n"
            f"  Premier League and player data are unaffected.",
            file=sys.stderr,
        )
        cl_frame, cl_hashes = pd.DataFrame(), {}
        cl_status = "unavailable"
    else:
        cl_status = "observed" if not cl_frame.empty else "unavailable"
        if cl_frame.empty:
            print(
                "  WARNING: Champions League ingest returned no United coverage; "
                "optional data is unavailable, not zero.",
                file=sys.stderr,
            )
    if not cl_frame.empty:
        season_frames.append(cl_frame)
        source_hashes.update(cl_hashes)
    print(f"    {len(cl_frame)} Champions League season(s) found", file=sys.stderr)

    if not player_frames:
        raise IngestError("no player seasons have fixture-level club attribution")
    players = pd.concat(player_frames, ignore_index=True)
    seasons = pd.concat(season_frames, ignore_index=True)

    validate(players, seasons)

    # Snapshot id is a pure function of the upstream bytes. Same inputs -> same
    # id -> same artifact keys -> cache hits. Different inputs -> new id ->
    # every dependent artifact invalidated, which is how retroactive football
    # corrections propagate without anyone remembering to purge.
    snapshot_id = sha256(
        json.dumps(source_hashes, sort_keys=True).encode("utf-8")
    )

    observed_at = utc_now()
    source_statuses: dict[str, dict[str, str | None]] = {
        SOURCE_FPL: {
            "status": "observed",
            "coverage_through": max(season for season in SEASONS if season >= PLAYER_FROM_SEASON),
            "retrieved_at": observed_at,
        },
        SOURCE_PL_RESULTS: {
            "status": "observed",
            "coverage_through": max(SEASONS),
            "retrieved_at": observed_at,
        },
        SOURCE_CL_RESULTS: {
            "status": cl_status,
            "coverage_through": max(cl_frame["season"]) if not cl_frame.empty else None,
            "retrieved_at": observed_at if cl_status == "observed" else None,
        },
    }

    emit_seed(players, seasons, snapshot_id, source_hashes, source_statuses)

    print(
        f"ingest OK: {len(players)} player-seasons, {len(seasons)} seasons\n"
        f"  snapshot: {snapshot_id}\n"
        f"  seed:     {SEED_PATH.relative_to(REPO_ROOT)} (gitignored)"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except IngestError as exc:
        print(f"INGEST FAILED: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
