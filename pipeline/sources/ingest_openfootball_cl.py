"""Champions League record for Manchester United, from openfootball.

REPLACES the football-data.org path for CL (ADR-0005: prefer the looser-rights
source when coverage overlaps). Two live runs proved football-data.org's free
tier cannot serve this data at all -- `/teams/{id}/matches` and
`/competitions/CL/matches` both return HTTP 403 "restricted... check your
subscription", and the tier that would work is EUR 29/month against a roughly
$5/month budget.

openfootball is better on every axis that matters here:
  * CC0-1.0, public domain -- strictly better than a grant contingent on an
    active subscription, which is exactly the preference ADR-0005 encodes
  * no API key, so nothing to leak, rotate, or gate CI on
  * no rate limit, so no token bucket
  * covers 2011-12 onward, wider than the ten seasons this site holds

Format is openfootball's plain-text fixture notation, one file per season:

    ▪ Group H
      Wed Oct 3 2018
        21:00  Manchester United (ENG) v Valencia CF (ESP)     0-0
        21:00  Juventus (ITA)          v Manchester United (ENG)  1-2 (0-0)
      ...
        21:00  FC Porto (POR)          v AS Roma (ITA)         3-1 a.e.t. (2-1, 1-1)

The first score after ` v ` is the match result: for an a.e.t. line that is
the after-extra-time score, with the parenthesised pair being 90-minute and
half-time. Taking the first pair is therefore correct for both shapes.
"""

from __future__ import annotations

import hashlib
import re

import pandas as pd
import requests

BASE = "https://raw.githubusercontent.com/openfootball/champions-league/master"
TIMEOUT = 60
HEADERS = {"User-Agent": "iammufc-poc/0.1 (non-commercial fan project)"}

COMPETITION_CODE = "CL"

#: openfootball spells the club out in full and tags the country, but NOT
#: consistently across seasons: some files say "Manchester United (ENG)" and
#: others "Manchester United FC (ENG)". Matching one spelling exactly silently
#: dropped an entire group stage -- found 2023-24, where six played matches
#: parsed as zero. Matched on the tagged form so "Manchester United" can never
#: collide with another club whose name contains it.
TEAM_ALIASES = frozenset({
    "Manchester United (ENG)",
    "Manchester United FC (ENG)",
})

#: Used only by the drift guard below, never to match a fixture. Deliberately
#: broader than TEAM_ALIASES: the guard's job is to notice ANY plausible
#: renaming of the club, including abbreviations no current file uses, so the
#: parser fails loudly rather than reporting a season United played in as a
#: season they sat out.
TEAM_SUBSTRINGS = ("Manchester United", "Manchester Utd", "Man United", "Man Utd")

#: `Home (CC) v Away (CC)  H-A` -- the optional leading kickoff time is not
#: always present (openfootball omits it on same-time matches).
MATCH_RE = re.compile(
    r"^\s*(?:\d{1,2}:\d{2}\s+)?"
    r"(?P<home>\S.*?\([A-Z]{3}\))\s+v\s+"
    r"(?P<away>\S.*?\([A-Z]{3}\))\s+"
    r"(?P<hg>\d+)-(?P<ag>\d+)"
)

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


class OpenfootballCLError(Exception):
    """A real failure fetching or parsing. Not raised for "United were not in
    the Champions League that season", which is expected and common."""


def fetch_season_text(season: str) -> str | None:
    """Raw fixture text for one season, or None if openfootball has no file
    for it -- a 404 means "not published", not "broken"."""
    resp = requests.get(f"{BASE}/{season}/cl.txt", timeout=TIMEOUT, headers=HEADERS)
    if resp.status_code == 404:
        return None
    if resp.status_code != 200:
        raise OpenfootballCLError(f"{season}: cl.txt returned HTTP {resp.status_code}")
    return resp.text


def parse_united_matches(text: str) -> list[tuple[int, int]]:
    """(goals_for, goals_against) per played Manchester United match.

    Fixtures with no score yet simply do not match MATCH_RE, so an in-progress
    season yields only the matches actually played -- never a fabricated 0-0.

    Raises if the file clearly names Manchester United under a spelling we do
    not recognise. That distinction matters: "United were not in this
    competition" and "United are here under a name the parser misses" both
    produce zero rows, and only the second is a bug. Without this guard the
    second one is invisible, which is exactly how the 2023-24 group stage went
    missing.
    """
    out: list[tuple[int, int]] = []
    matched_any = False
    for line in text.splitlines():
        m = MATCH_RE.match(line)
        if not m:
            continue
        home, away = m.group("home").strip(), m.group("away").strip()
        hg, ag = int(m.group("hg")), int(m.group("ag"))
        if home in TEAM_ALIASES:
            out.append((hg, ag))
            matched_any = True
        elif away in TEAM_ALIASES:
            out.append((ag, hg))
            matched_any = True

    if not matched_any:
        unknown = sorted({
            name
            for line in text.splitlines()
            if (m := MATCH_RE.match(line))
            for name in (m.group("home").strip(), m.group("away").strip())
            if name not in TEAM_ALIASES
            and any(sub in name for sub in TEAM_SUBSTRINGS)
        })
        if unknown:
            raise OpenfootballCLError(
                f"file names Manchester United as {unknown!r}, which is not in "
                f"TEAM_ALIASES -- add the spelling rather than shipping a season "
                f"of silently missing matches"
            )
    return out


def season_record(season: str) -> tuple[pd.DataFrame | None, str | None]:
    """One season's CL record, or (None, None) if United did not play in it."""
    text = fetch_season_text(season)
    if text is None:
        return None, None

    results = parse_united_matches(text)
    if not results:
        return None, None

    won = sum(1 for gf, ga in results if gf > ga)
    lost = sum(1 for gf, ga in results if gf < ga)
    drawn = sum(1 for gf, ga in results if gf == ga)
    row = pd.DataFrame(
        [
            {
                "season": season,
                "competition": COMPETITION_CODE,
                "played": len(results),
                "won": won,
                "drawn": drawn,
                "lost": lost,
                "goals": sum(gf for gf, _ in results),
                "goals_against": sum(ga for _, ga in results),
            }
        ]
    )
    return row, hashlib.sha256(text.encode("utf-8")).hexdigest()


def fetch_all(seasons: list[str]) -> tuple[pd.DataFrame, dict[str, str]]:
    """CL season_stats rows for every season United actually played in."""
    frames: list[pd.DataFrame] = []
    hashes: dict[str, str] = {}
    for season in seasons:
        row, content_hash = season_record(season)
        if row is None:
            continue
        frames.append(row)
        hashes[f"openfootball:CL:{season}"] = content_hash  # type: ignore[assignment]
    if not frames:
        return pd.DataFrame(columns=SEASON_STATS_COLUMNS), hashes
    return pd.concat(frames, ignore_index=True), hashes
