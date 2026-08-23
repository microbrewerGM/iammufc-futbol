"""Champions League ingest -- football-data.org API v4.

ADR-0005: Premier League is deliberately NOT pulled here. football_data_couk
(PDDL, permanent public domain) already covers PL on strictly better rights
than this source's subscription-contingent grant
(catalog/rights/sources/football-data-org.md, clause 9.1). Champions League
is the one thing this source adds that nothing else in the manifest covers.

Not qualifying for the Champions League in a given season is expected, not
an error -- most Man United seasons in this window did not include it. An
empty `matches` response for a season means "not applicable", not "ingest
failure". A genuine HTTP failure (bad key, API down) still raises: this
distinguishes "nothing to report" from "something went wrong", same
principle as run.py's own IngestError philosophy.
"""

from __future__ import annotations

import hashlib
import json

import pandas as pd
import requests

from pipeline.sources.ratelimit import TokenBucket

API_BASE = "https://api.football-data.org/v4"
TIMEOUT = 60

#: Carried over from the v1 API docs (id stable across versions per
#: football-data.org's own docs), not independently confirmed against v4 --
#: the agent that wrote this never held the key to check. Verified once at
#: runtime instead of trusted silently, see confirm_team() below.
TEAM_ID_MUFC = 66

COMPETITION_CODE = "CL"

SEASON_STATS_COLUMNS = [
    "season",
    "competition",
    "played",
    "won",
    "drawn",
    "lost",
    "goals",
    "goals_against",
]


class FdorgIngestError(Exception):
    """A real failure talking to the API -- never raised for 'United didn't
    qualify this season', which is the expected common case."""


def _get(path: str, api_key: str, bucket: TokenBucket, **params: object) -> dict:
    bucket.acquire()
    resp = requests.get(
        f"{API_BASE}{path}",
        headers={"X-Auth-Token": api_key},
        params=params,
        timeout=TIMEOUT,
    )
    if resp.status_code != 200:
        raise FdorgIngestError(f"{path} returned HTTP {resp.status_code}: {resp.text[:200]}")
    return resp.json()


def confirm_team(api_key: str, bucket: TokenBucket) -> None:
    """TEAM_ID_MUFC is a carried-over public value, not independently
    confirmed. Verify once at runtime rather than trust it silently -- the
    data equivalent of the wrong-resource-name mistake self-review-protocol
    Tier 2 exists to catch for infra."""
    data = _get(f"/teams/{TEAM_ID_MUFC}", api_key, bucket)
    name = data.get("name", "")
    if "Manchester United" not in name:
        raise FdorgIngestError(
            f"team {TEAM_ID_MUFC} resolved to {name!r}, not Manchester United -- "
            f"TEAM_ID_MUFC is wrong, fix it before trusting anything else from this ingest"
        )


def fetch_cl_season(
    season: str, api_key: str, bucket: TokenBucket
) -> tuple[pd.DataFrame | None, str | None]:
    """One season's Champions League record for Manchester United, or
    (None, None) if they didn't qualify -- not an error."""
    year = int(season[:4])
    data = _get(
        f"/teams/{TEAM_ID_MUFC}/matches",
        api_key,
        bucket,
        competitions=COMPETITION_CODE,
        season=year,
    )
    matches = data.get("matches", [])
    finished = [m for m in matches if m.get("status") == "FINISHED"]
    if not finished:
        return None, None

    played = won = drawn = lost = goals_for = goals_against = 0
    for m in finished:
        score = m.get("score", {}).get("fullTime", {})
        home_goals, away_goals = score.get("home"), score.get("away")
        if home_goals is None or away_goals is None:
            # FINISHED with no final score is malformed upstream data.
            # Skip the match rather than fabricate a result for it.
            continue
        is_home = m.get("homeTeam", {}).get("id") == TEAM_ID_MUFC
        us, them = (home_goals, away_goals) if is_home else (away_goals, home_goals)
        played += 1
        goals_for += us
        goals_against += them
        if us > them:
            won += 1
        elif us < them:
            lost += 1
        else:
            drawn += 1

    if played == 0:
        return None, None

    row = pd.DataFrame(
        [
            {
                "season": season,
                "competition": COMPETITION_CODE,
                "played": played,
                "won": won,
                "drawn": drawn,
                "lost": lost,
                "goals": goals_for,
                "goals_against": goals_against,
            }
        ]
    )
    content_hash = hashlib.sha256(
        json.dumps(matches, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()
    return row, content_hash


def fetch_all(seasons: list[str], api_key: str) -> tuple[pd.DataFrame, dict[str, str]]:
    """Champions League season_stats rows for every season United qualified
    in `seasons`. Rate-limited to the free tier's 10 req/min regardless of
    how many seasons are requested."""
    bucket = TokenBucket(rate_per_minute=10)
    confirm_team(api_key, bucket)

    frames: list[pd.DataFrame] = []
    hashes: dict[str, str] = {}
    for season in seasons:
        row, content_hash = fetch_cl_season(season, api_key, bucket)
        if row is None:
            continue
        frames.append(row)
        hashes[f"football_data_org:CL:{season}"] = content_hash  # type: ignore[assignment]

    if not frames:
        return pd.DataFrame(columns=SEASON_STATS_COLUMNS), hashes
    return pd.concat(frames, ignore_index=True), hashes
