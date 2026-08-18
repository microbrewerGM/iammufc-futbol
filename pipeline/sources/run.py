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
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import pandera.errors
import requests

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

#: FPL data via the community archive. The live API carries only the current
#: season; the archive carries 2016-17 onward in the same shape.
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

TIMEOUT = 60
HEADERS = {"User-Agent": "iammufc-poc/0.1 (non-commercial fan project)"}


class IngestError(Exception):
    """Fatal. A failed ingest must never publish partial data."""


def fetch(url: str) -> bytes:
    resp = requests.get(url, timeout=TIMEOUT, headers=HEADERS)
    if resp.status_code != 200:
        raise IngestError(f"{url} returned HTTP {resp.status_code}")
    return resp.content


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


# ---------------------------------------------------------------------------
# Extract
# ---------------------------------------------------------------------------


def load_players(season: str) -> tuple[pd.DataFrame, str]:
    """Manchester United player box scores for one season."""
    players_raw = fetch(f"{FPL_BASE}/{season}/players_raw.csv")
    players = pd.read_csv(io.BytesIO(players_raw))

    if "team_code" not in players.columns:
        raise IngestError(
            f"{season}: players_raw.csv has no team_code column. Upstream schema "
            f"changed -- find another stable club identifier before ingesting."
        )

    mufc = players[players["team_code"] == TEAM_CODE_MUFC].copy()
    if mufc.empty:
        raise IngestError(
            f"{season}: team_code {TEAM_CODE_MUFC} matched no players. Either the "
            f"season is unavailable or the club coding changed."
        )

    # Drop managers. Reported so an upstream schema change is visible in the
    # log rather than discovered as a missing row months later.
    non_players = mufc[mufc["element_type"].isin(NON_PLAYER_ELEMENT_TYPES)]
    if not non_players.empty:
        print(
            f"    excluding {len(non_players)} non-player entries "
            f"({', '.join(non_players['web_name'].astype(str))})",
            file=sys.stderr,
        )
    mufc = mufc[~mufc["element_type"].isin(NON_PLAYER_ELEMENT_TYPES)]

    # An element_type we have never seen is an upstream schema change. Fail
    # loudly: silently emitting a NULL position would push the decision to a
    # database constraint, which is a worse place to discover it.
    unknown = sorted(set(mufc["element_type"].astype(int)) - set(POSITION_CODES))
    if unknown:
        raise IngestError(
            f"{season}: unmapped FPL element_type(s) {unknown}. Upstream schema "
            f"changed -- classify them before ingesting."
        )

    # xG only exists from 2022-23. Absent is null, never zero -- zero would be a
    # claim we did not measure, which is the kind of quiet lie this project
    # exists to avoid.
    if "expected_goals" not in mufc.columns:
        if season >= XG_FROM_SEASON:
            raise IngestError(
                f"{season}: expected_goals is missing but should exist from "
                f"{XG_FROM_SEASON} onward. Upstream schema changed."
            )
        mufc["expected_goals"] = None

    out = pd.DataFrame(
        {
            "fpl_element": mufc["id"].astype(int),
            "season": season,
            "web_name": mufc["web_name"].astype(str),
            "first_name": mufc["first_name"].astype(str),
            "second_name": mufc["second_name"].astype(str),
            "position": mufc["element_type"].astype(int).map(POSITION_CODES),
            "team": "Manchester United",
            "goals": mufc["goals_scored"].astype(int),
            "assists": mufc["assists"].astype(int),
            "minutes": mufc["minutes"].astype(int),
            "points": mufc["total_points"].astype(int),
            "xg": pd.to_numeric(mufc["expected_goals"], errors="coerce"),
        }
    )
    out["player_id"] = "fpl:" + out["fpl_element"].astype(str) + ":" + season
    return out, sha256(players_raw)


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
    if len(seasons) != len(SEASONS):
        errors.append(f"expected {len(SEASONS)} season rows, got {len(seasons)}")

    # Pass 2: cross-frame referential checks.
    if not errors:  # only meaningful once structure is confirmed sound
        for season in SEASONS:
            p_goals = int(players[players["season"] == season]["goals"].sum())
            season_row = seasons[seasons["season"] == season]
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
) -> None:
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
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
        lines.append(
            "INSERT INTO season_stats (season, competition, played, won, drawn, lost, "
            "goals, goals_against, snapshot_id) VALUES ("
            f"{sql_str(r['season'])}, 'PL', {int(r['played'])}, {int(r['won'])}, "
            f"{int(r['drawn'])}, {int(r['lost'])}, {int(r['goals'])}, "
            f"{int(r['goals_against'])}, {sql_str(snapshot_id)});"
        )
    lines.append("")

    SEED_PATH.parent.mkdir(parents=True, exist_ok=True)
    SEED_PATH.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    player_frames, season_frames = [], []
    source_hashes: dict[str, str] = {}

    for season in SEASONS:
        print(f"  fetching {season} ...", file=sys.stderr)
        players, phash = load_players(season)
        results, rhash = load_results(season)
        player_frames.append(players)
        season_frames.append(results)
        source_hashes[f"fpl:{season}"] = phash
        source_hashes[f"football_data_couk:{season}"] = rhash
        print(
            f"    {len(players)} players, {int(results.iloc[0]['played'])} matches",
            file=sys.stderr,
        )

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

    emit_seed(players, seasons, snapshot_id, source_hashes)

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
