"""openfootball Champions League parser.

Network is always mocked. The one thing these tests exist to pin is the
distinction between "United were not in this competition" and "United are in
this file under a spelling the parser misses" -- both produce zero rows, and
only the second is a bug. That exact bug shipped once: openfootball writes
"Manchester United FC (ENG)" in some seasons and "Manchester United (ENG)" in
others, and an exact match on one spelling silently dropped a whole group
stage.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from pipeline.sources.ingest_openfootball_cl import (
    OpenfootballCLError,
    fetch_all,
    parse_united_matches,
    season_record,
)

FIXTURE = """= UEFA Champions League 2018/19

▪ Group H
  Wed Oct 3 2018
    21:00  {utd} v Valencia CF (ESP)     0-0
    21:00  Juventus (ITA)          v {utd}  1-2 (0-0)
           FC Porto (POR)          v AS Roma (ITA)         3-1 a.e.t. (2-1, 1-1)
           {utd} v BSC Young Boys (SUI)  1-0 (0-0)
  Wed Feb 12 2019
    21:00  {utd} v Paris Saint-Germain (FRA)  0-2 (0-0)
    21:00  Barcelona (ESP) v {utd}  0-0
"""


def text_for(name: str) -> str:
    return FIXTURE.replace("{utd}", name)


def mock_get(status: int, body: str) -> MagicMock:
    r = MagicMock()
    r.status_code = status
    r.text = body
    return r


class TestParse:
    @pytest.mark.parametrize(
        "name", ["Manchester United (ENG)", "Manchester United FC (ENG)"]
    )
    def test_both_spellings_parse_identically(self, name):
        """The regression. Both spellings appear in real openfootball data."""
        res = parse_united_matches(text_for(name))
        assert len(res) == 5
        assert sum(gf for gf, _ in res) == 3
        assert sum(ga for _, ga in res) == 3

    def test_home_and_away_orientation(self):
        res = parse_united_matches(text_for("Manchester United (ENG)"))
        assert (2, 1) in res, "away win should be recorded from United's side"
        assert (1, 0) in res, "home win should be recorded from United's side"

    def test_ignores_other_clubs_including_extra_time_lines(self):
        res = parse_united_matches(text_for("Manchester United (ENG)"))
        assert (3, 1) not in res and (1, 3) not in res

    def test_absent_from_competition_is_not_an_error(self):
        text = "= UEFA Champions League 2016/17\n    21:00  Real Madrid (ESP) v Juventus (ITA)  4-1 (2-1)\n"
        assert parse_united_matches(text) == []

    def test_unrecognised_spelling_raises_rather_than_returning_zero(self):
        """A future rename must fail loudly, not vanish a season."""
        with pytest.raises(OpenfootballCLError, match="TEAM_ALIASES"):
            parse_united_matches(text_for("Manchester Utd (ENG)"))


class TestSeasonRecord:
    def test_aggregates_into_a_season_row(self):
        with patch(
            "pipeline.sources.ingest_openfootball_cl.requests.get",
            return_value=mock_get(200, text_for("Manchester United FC (ENG)")),
        ):
            row, digest = season_record("2018-19")
        assert row is not None
        r = row.iloc[0]
        assert r["season"] == "2018-19"
        assert r["competition"] == "CL"
        assert r["played"] == 5
        assert r["won"] == 2
        assert r["drawn"] == 2
        assert r["lost"] == 1
        assert r["goals"] == 3
        assert r["goals_against"] == 3
        assert digest

    def test_missing_season_file_returns_none(self):
        with patch(
            "pipeline.sources.ingest_openfootball_cl.requests.get",
            return_value=mock_get(404, ""),
        ):
            assert season_record("2031-32") == (None, None)

    def test_other_http_error_raises(self):
        with patch(
            "pipeline.sources.ingest_openfootball_cl.requests.get",
            return_value=mock_get(500, ""),
        ):
            with pytest.raises(OpenfootballCLError, match="HTTP 500"):
                season_record("2018-19")


class TestFetchAll:
    def test_skips_seasons_united_did_not_play_in(self):
        absent = "= UEFA Champions League\n    21:00  Real Madrid (ESP) v Juventus (ITA)  4-1 (2-1)\n"

        def fake(url, timeout, headers):
            return mock_get(200, text_for("Manchester United (ENG)") if "2018-19" in url else absent)

        with patch("pipeline.sources.ingest_openfootball_cl.requests.get", side_effect=fake):
            df, hashes = fetch_all(["2017-18", "2018-19", "2019-20"])

        assert len(df) == 1
        assert df.iloc[0]["season"] == "2018-19"
        assert list(hashes) == ["openfootball:CL:2018-19"]

    def test_needs_no_api_key(self):
        """The whole point of this source: nothing to leak, rotate, or gate CI on."""
        import inspect

        from pipeline.sources import ingest_openfootball_cl as mod

        assert "api_key" not in inspect.signature(mod.fetch_all).parameters
        assert "X-Auth-Token" not in inspect.getsource(mod)
