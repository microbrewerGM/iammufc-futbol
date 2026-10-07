"""Premier League results ingest stays source-specific and reproducible."""

from __future__ import annotations

import hashlib
import io
from unittest.mock import patch

import pandas as pd
import pytest

from pipeline.sources import run


def results_csv() -> bytes:
    rows = []
    rows.extend({"HomeTeam": "Man United", "AwayTeam": f"Win {index}", "FTHG": 2, "FTAG": 0}
                for index in range(14))
    rows.extend({"HomeTeam": "Manchester United", "AwayTeam": f"Win {index}", "FTHG": 2, "FTAG": 1}
                for index in range(5))
    rows.extend({"HomeTeam": "Man Utd", "AwayTeam": f"Draw {index}", "FTHG": 1, "FTAG": 1}
                for index in range(5))
    rows.extend({"HomeTeam": "Man United", "AwayTeam": f"Draw {index}", "FTHG": 0, "FTAG": 0}
                for index in range(4))
    rows.extend({"HomeTeam": f"Loss {index}", "AwayTeam": "Manchester United", "FTHG": 2, "FTAG": 1}
                for index in range(6))
    rows.extend({"HomeTeam": f"Loss {index}", "AwayTeam": "Man Utd", "FTHG": 3, "FTAG": 0}
                for index in range(3))
    rows.append({"HomeTeam": "Loss final", "AwayTeam": "Man United", "FTHG": 4, "FTAG": 0})
    rows.append({"HomeTeam": "Other", "AwayTeam": "Other Two", "FTHG": 3, "FTAG": 2})
    return pd.DataFrame(rows).to_csv(index=False).encode()


def results_2014_15_csv() -> bytes:
    rows = []
    rows.extend({"HomeTeam": "Man United", "AwayTeam": f"Win {index}", "FTHG": 2, "FTAG": 0}
                for index in range(15))
    rows.extend({"HomeTeam": "Manchester United", "AwayTeam": f"Win {index}", "FTHG": 3, "FTAG": 1}
                for index in range(4))
    rows.append({"HomeTeam": "Man Utd", "AwayTeam": "Win final", "FTHG": 5, "FTAG": 1})
    rows.extend({"HomeTeam": "Man United", "AwayTeam": f"Draw {index}", "FTHG": 1, "FTAG": 1}
                for index in range(7))
    rows.extend({"HomeTeam": "Manchester United", "AwayTeam": f"Draw {index}", "FTHG": 0, "FTAG": 0}
                for index in range(3))
    rows.extend({"HomeTeam": f"Loss {index}", "AwayTeam": "Manchester United", "FTHG": 2, "FTAG": 1}
                for index in range(5))
    rows.extend({"HomeTeam": f"Loss {index}", "AwayTeam": "Man Utd", "FTHG": 5, "FTAG": 1}
                for index in range(3))
    return pd.DataFrame(rows).to_csv(index=False).encode()


def test_2014_15_results_reconcile_to_complete_historic_record_with_stable_lineage():
    payload = results_2014_15_csv()
    expected_url = f"{run.RESULTS_BASE}/season-1415.csv"

    with patch.object(run, "fetch", return_value=payload) as fetch:
        first, first_hash = run.load_results("2014-15")
        second, second_hash = run.load_results("2014-15")

    fetch.assert_called_with(expected_url)
    assert first.to_dict("records") == [{
        "season": "2014-15",
        "competition": "PL",
        "played": 38,
        "won": 20,
        "drawn": 10,
        "lost": 8,
        "goals": 62,
        "goals_against": 37,
    }]
    assert second.equals(first)
    assert first_hash == second_hash == hashlib.sha256(payload).hexdigest()


def test_2015_16_results_are_aggregated_with_stable_lineage():
    payload = results_csv()
    expected_url = f"{run.RESULTS_BASE}/season-1516.csv"

    with patch.object(run, "fetch", return_value=payload) as fetch:
        first, first_hash = run.load_results("2015-16")
        second, second_hash = run.load_results("2015-16")

    fetch.assert_called_with(expected_url)
    assert first.to_dict("records") == [{
        "season": "2015-16",
        "competition": "PL",
        "played": 38,
        "won": 19,
        "drawn": 9,
        "lost": 10,
        "goals": 49,
        "goals_against": 35,
    }]
    assert second.equals(first)
    assert first_hash == second_hash == hashlib.sha256(payload).hexdigest()


@pytest.mark.parametrize(
    ("season", "payload"),
    [("2014-15", results_2014_15_csv), ("2015-16", results_csv)],
)
def test_closed_season_refuses_a_plausible_partial_source(season, payload):
    partial = pd.read_csv(io.BytesIO(payload())).iloc[:-2]
    with patch.object(run, "fetch", return_value=partial.to_csv(index=False).encode()):
        with pytest.raises(run.IngestError, match="expected 38 completed"):
            run.load_results(season)


def test_missing_core_results_fail_before_publication(monkeypatch):
    monkeypatch.setattr(run, "SEASONS", ["2015-16"])
    monkeypatch.setattr(
        run,
        "load_results",
        lambda _season: (_ for _ in ()).throw(run.IngestError("source unavailable")),
    )
    emitted = False

    def emit_never(*_args, **_kwargs):
        nonlocal emitted
        emitted = True

    monkeypatch.setattr(run, "emit_seed", emit_never)
    with pytest.raises(run.IngestError, match="source unavailable"):
        run.main()
    assert emitted is False


def test_pl_expansion_does_not_expand_champions_league(monkeypatch, tmp_path):
    monkeypatch.setattr(run, "SEASONS", ["2015-16", "2016-17"])
    monkeypatch.setattr(run, "PLAYER_FROM_SEASON", "9999-99")
    monkeypatch.setattr(run, "load_results", lambda season: (
        pd.DataFrame([{
            "season": season, "competition": "PL", "played": 38,
            "won": 19, "drawn": 9, "lost": 10, "goals": 49,
            "goals_against": 35,
        }]),
        f"hash-{season}",
    ))
    seen: list[str] = []

    def cl_fetch(seasons):
        seen.extend(seasons)
        raise run.OpenfootballCLError("optional source unavailable")

    monkeypatch.setattr(run, "fetch_cl_all", cl_fetch)
    monkeypatch.setattr(run, "SEED_PATH", tmp_path / "seed.sql")
    with pytest.raises(run.IngestError, match="no player seasons"):
        run.main()
    assert seen == ["2016-17"]
