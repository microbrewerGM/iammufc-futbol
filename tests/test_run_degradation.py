"""The optional Champions League source must never sink the core ingest.

Regression test for 2026-08-23: a 403 from football-data.org (an additive
bonus source) failed the whole run, which took down the dev deploy along with
every Premier League and player row. The core pipeline's job is PL/FPL data;
CL sits on top of it and must degrade to "absent", never to "everything
fails".
"""

from __future__ import annotations

from unittest.mock import patch

import pandas as pd
import pytest

from pipeline.sources import run as run_mod
from pipeline.sources.ingest_fdorg import FdorgIngestError

SEASON = "2018-19"


def fake_players() -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "player_id": f"fpl:1:{SEASON}",
                "fpl_element": 1,
                "season": SEASON,
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
        ]
    )


def fake_season() -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "season": SEASON,
                "competition": "PL",
                "played": 38,
                "won": 19,
                "drawn": 9,
                "lost": 10,
                "goals": 65,
                "goals_against": 54,
            }
        ]
    )


@pytest.fixture
def core_pipeline_mocked(tmp_path, monkeypatch):
    """Everything except the CL step, stubbed. Seed goes to a temp path so no
    test ever writes into the real migrations directory."""
    monkeypatch.setattr(run_mod, "SEASONS", [SEASON])
    # REPO_ROOT moves with SEED_PATH: main()'s closing log line does
    # SEED_PATH.relative_to(REPO_ROOT), which raises if they diverge.
    monkeypatch.setattr(run_mod, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(run_mod, "SEED_PATH", tmp_path / "0002_seed.sql")
    monkeypatch.setattr(run_mod, "load_players", lambda s: (fake_players(), "phash"))
    monkeypatch.setattr(run_mod, "load_results", lambda s: (fake_season(), "rhash"))
    monkeypatch.setenv("FOOTBALL_DATA_KEY", "fake-key")
    return tmp_path / "0002_seed.sql"


def test_cl_failure_does_not_fail_the_run(core_pipeline_mocked, capsys):
    with patch.object(
        run_mod,
        "fetch_cl_all",
        side_effect=FdorgIngestError("/competitions/CL/matches returned HTTP 403"),
    ):
        assert run_mod.main() == 0

    assert core_pipeline_mocked.exists(), "PL/FPL seed must still be written"
    seed = core_pipeline_mocked.read_text()
    assert "INSERT INTO players" in seed
    assert "'PL'" in seed


def test_cl_failure_warns_loudly_enough_to_notice(core_pipeline_mocked, capsys):
    """A silent skip would hide a revoked key indefinitely. The warning is the
    only signal, so it has to stay greppable."""
    with patch.object(
        run_mod, "fetch_cl_all", side_effect=FdorgIngestError("HTTP 403 restricted")
    ):
        run_mod.main()

    err = capsys.readouterr().err
    assert "WARNING" in err
    assert "Champions League ingest skipped" in err
    assert "HTTP 403 restricted" in err
    assert "unaffected" in err


def test_cl_success_still_adds_its_row(core_pipeline_mocked):
    cl = pd.DataFrame(
        [
            {
                "season": SEASON,
                "competition": "CL",
                "played": 10,
                "won": 4,
                "drawn": 2,
                "lost": 4,
                "goals": 13,
                "goals_against": 15,
            }
        ]
    )
    with patch.object(
        run_mod, "fetch_cl_all", return_value=(cl, {f"football_data_org:CL:{SEASON}": "h"})
    ):
        assert run_mod.main() == 0

    seed = core_pipeline_mocked.read_text()
    assert "'CL'" in seed, "Champions League row must reach the seed when present"
