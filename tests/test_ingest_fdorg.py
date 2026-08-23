"""Champions League ingest -- HTTP calls always mocked. The real API needs a
credential this test suite must never hold (hard rule 2), and a live network
call in a test suite is nondeterministic regardless of that.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from pipeline.sources.ingest_fdorg import (
    TEAM_ID_MUFC,
    FdorgIngestError,
    confirm_team,
    fetch_all,
    fetch_cl_season,
)
from pipeline.sources.ratelimit import TokenBucket


def instant_bucket() -> TokenBucket:
    """A bucket that never actually sleeps -- rate-limiting itself is
    covered by test_ratelimit.py, not re-tested here."""
    return TokenBucket(rate_per_minute=10, sleep_fn=lambda _s: None)


def mock_response(status_code: int, json_body: dict) -> MagicMock:
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = json_body
    resp.text = str(json_body)
    return resp


def finished_match(home_id: int, away_id: int, home_goals: int, away_goals: int) -> dict:
    return {
        "status": "FINISHED",
        "homeTeam": {"id": home_id},
        "awayTeam": {"id": away_id},
        "score": {"fullTime": {"home": home_goals, "away": away_goals}},
    }


class TestConfirmTeam:
    def test_accepts_matching_name(self):
        with patch(
            "pipeline.sources.ingest_fdorg.requests.get",
            return_value=mock_response(200, {"id": TEAM_ID_MUFC, "name": "Manchester United FC"}),
        ):
            confirm_team("fake-key", instant_bucket())  # no raise

    def test_rejects_mismatched_name(self):
        with patch(
            "pipeline.sources.ingest_fdorg.requests.get",
            return_value=mock_response(200, {"id": TEAM_ID_MUFC, "name": "Real Betis"}),
        ):
            with pytest.raises(FdorgIngestError, match="not Manchester United"):
                confirm_team("fake-key", instant_bucket())

    def test_raises_on_http_error(self):
        with patch(
            "pipeline.sources.ingest_fdorg.requests.get",
            return_value=mock_response(401, {"message": "invalid token"}),
        ):
            with pytest.raises(FdorgIngestError, match="HTTP 401"):
                confirm_team("fake-key", instant_bucket())


class TestFetchClSeason:
    def test_no_matches_returns_none_not_an_error(self):
        with patch(
            "pipeline.sources.ingest_fdorg.requests.get",
            return_value=mock_response(200, {"matches": []}),
        ):
            row, content_hash = fetch_cl_season("2019-20", "fake-key", instant_bucket())
        assert row is None
        assert content_hash is None

    def test_only_scheduled_matches_returns_none(self):
        matches = {"matches": [{"status": "SCHEDULED", "homeTeam": {"id": TEAM_ID_MUFC}}]}
        with patch("pipeline.sources.ingest_fdorg.requests.get", return_value=mock_response(200, matches)):
            row, _ = fetch_cl_season("2025-26", "fake-key", instant_bucket())
        assert row is None

    def test_aggregates_home_and_away_correctly(self):
        opponent = 999
        matches = {
            "matches": [
                finished_match(TEAM_ID_MUFC, opponent, 3, 1),  # home win
                finished_match(opponent, TEAM_ID_MUFC, 2, 2),  # away draw
                finished_match(opponent, TEAM_ID_MUFC, 4, 0),  # away loss
                {"status": "SCHEDULED", "homeTeam": {"id": TEAM_ID_MUFC}},  # ignored
            ]
        }
        with patch("pipeline.sources.ingest_fdorg.requests.get", return_value=mock_response(200, matches)):
            row, content_hash = fetch_cl_season("2018-19", "fake-key", instant_bucket())

        assert row is not None
        r = row.iloc[0]
        assert r["season"] == "2018-19"
        assert r["competition"] == "CL"
        assert r["played"] == 3
        assert r["won"] == 1
        assert r["drawn"] == 1
        assert r["lost"] == 1
        assert r["goals"] == 3 + 2 + 0  # United's own goals across all 3
        assert r["goals_against"] == 1 + 2 + 4
        assert content_hash is not None

    def test_finished_match_missing_score_is_skipped_not_fabricated(self):
        matches = {
            "matches": [
                {
                    "status": "FINISHED",
                    "homeTeam": {"id": TEAM_ID_MUFC},
                    "awayTeam": {"id": 999},
                    "score": {"fullTime": {"home": None, "away": None}},
                }
            ]
        }
        with patch("pipeline.sources.ingest_fdorg.requests.get", return_value=mock_response(200, matches)):
            row, _ = fetch_cl_season("2020-21", "fake-key", instant_bucket())
        assert row is None  # the one match was unusable, so 0 played -> None

    def test_raises_on_http_error(self):
        with patch(
            "pipeline.sources.ingest_fdorg.requests.get",
            return_value=mock_response(500, {}),
        ):
            with pytest.raises(FdorgIngestError, match="HTTP 500"):
                fetch_cl_season("2018-19", "fake-key", instant_bucket())


class TestFetchAll:
    def test_skips_non_qualifying_seasons_and_confirms_team_once(self):
        team_resp = mock_response(200, {"id": TEAM_ID_MUFC, "name": "Manchester United FC"})
        empty_resp = mock_response(200, {"matches": []})
        cl_resp = mock_response(
            200, {"matches": [finished_match(TEAM_ID_MUFC, 999, 1, 0)]}
        )

        call_log = []

        def fake_get(url, headers, params, timeout):
            call_log.append(url)
            if url.endswith(f"/teams/{TEAM_ID_MUFC}"):
                return team_resp
            if params.get("season") == 2018:
                return cl_resp
            return empty_resp

        with patch("pipeline.sources.ingest_fdorg.requests.get", side_effect=fake_get):
            df, hashes = fetch_all(["2017-18", "2018-19", "2019-20"], "fake-key")

        assert len(df) == 1
        assert df.iloc[0]["season"] == "2018-19"
        assert list(hashes.keys()) == ["football_data_org:CL:2018-19"]
        assert call_log.count(f"{call_log[0].split('/teams')[0]}/teams/{TEAM_ID_MUFC}") == 1

    def test_empty_when_no_season_qualifies(self):
        team_resp = mock_response(200, {"id": TEAM_ID_MUFC, "name": "Manchester United FC"})
        empty_resp = mock_response(200, {"matches": []})

        def fake_get(url, headers, params, timeout):
            return team_resp if url.endswith(f"/teams/{TEAM_ID_MUFC}") else empty_resp

        with patch("pipeline.sources.ingest_fdorg.requests.get", side_effect=fake_get):
            df, hashes = fetch_all(["2019-20", "2020-21"], "fake-key")

        assert df.empty
        assert list(df.columns) == [
            "season",
            "competition",
            "played",
            "won",
            "drawn",
            "lost",
            "goals",
            "goals_against",
        ]
        assert hashes == {}

    def test_bad_team_id_aborts_before_any_season_fetch(self):
        with patch(
            "pipeline.sources.ingest_fdorg.requests.get",
            return_value=mock_response(200, {"id": TEAM_ID_MUFC, "name": "Wrong Team"}),
        ):
            with pytest.raises(FdorgIngestError, match="not Manchester United"):
                fetch_all(["2019-20"], "fake-key")
