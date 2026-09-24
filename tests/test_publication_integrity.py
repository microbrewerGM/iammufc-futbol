"""Local model of publication metadata and all-or-nothing seed execution.

D1 owns the remote import transaction. These SQLite tests prove the generated
SQL is compatible with a transaction; they do not claim a remote recovery drill.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pandas as pd
import pytest

from pipeline.sources import run as run_mod

SCHEMA = Path("infra/migrations/0001_schema.sql").read_text(encoding="utf-8")


def players(snapshot_suffix: str, goals: int) -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "player_id": f"fpl:1:2024-25-{snapshot_suffix}",
                "person_id": "fpl:code:101",
                "source_person_code": 101,
                "fpl_element": 1,
                "season": "2024-25",
                "web_name": "Test",
                "first_name": "Test",
                "second_name": "Player",
                "position": "FW",
                "team": "Manchester United",
                "goals": goals,
                "assists": 1,
                "minutes": 180,
                "points": 20,
                "xg": 1.25,
            }
        ]
    )


def seasons(goals: int) -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "season": "2024-25",
                "competition": "PL",
                "played": 38,
                "won": 20,
                "drawn": 8,
                "lost": 10,
                "goals": goals,
                "goals_against": 40,
            }
        ]
    )


def statuses(when: str) -> dict[str, dict[str, str | None]]:
    return {
        "fpl": {"status": "observed", "coverage_through": "2024-25", "retrieved_at": when},
        "football_data_couk": {
            "status": "observed",
            "coverage_through": "2024-25",
            "retrieved_at": when,
        },
        "openfootball_cl": {"status": "unavailable", "coverage_through": None, "retrieved_at": None},
    }


def emit(monkeypatch: pytest.MonkeyPatch, path: Path, stamp: str, suffix: str, goals: int) -> str:
    monkeypatch.setattr(run_mod, "SEED_PATH", path)
    monkeypatch.setattr(run_mod, "utc_now", lambda: stamp)
    snapshot = f"snapshot-{suffix}"
    run_mod.emit_seed(
        players(suffix, goals),
        seasons(goals + 50),
        snapshot,
        {"fpl:2024-25": f"hash-{suffix}"},
        statuses(stamp),
    )
    return path.read_text(encoding="utf-8")


def execute_atomic(connection: sqlite3.Connection, sql: str) -> None:
    try:
        connection.executescript(f"BEGIN;\n{sql}\nCOMMIT;")
    except sqlite3.Error:
        connection.execute("ROLLBACK")
        raise


def state(connection: sqlite3.Connection) -> tuple[list[tuple], ...]:
    return tuple(
        connection.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall()
        for table in (
            "players",
            "player_identities",
            "player_season_stats",
            "season_stats",
            "snapshots",
            "publication_runs",
        )
    )


def test_schema_is_idempotent_without_changing_existing_data() -> None:
    db = sqlite3.connect(":memory:")
    marker = "-- One append-only record for each seed import"
    assert marker in SCHEMA
    db.executescript(SCHEMA.split(marker)[0])
    db.execute(
        "INSERT INTO snapshots VALUES (?, ?, ?, ?)",
        ("old", "2026-01-01T00:00:00Z", "{}", "{}"),
    )
    before = db.execute("SELECT * FROM snapshots").fetchall()
    db.executescript(SCHEMA)
    db.executescript(SCHEMA)
    assert db.execute("SELECT * FROM snapshots").fetchall() == before
    assert db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='publication_runs'"
    ).fetchone() == ("publication_runs",)
    assert db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='player_identities'"
    ).fetchone() == ("player_identities",)


def test_publication_insert_is_last_and_contains_no_transaction_control(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sql = emit(monkeypatch, tmp_path / "seed.sql", "2026-09-23T12:00:00+00:00", "one", 2)
    assert "BEGIN;" not in sql and "COMMIT;" not in sql
    assert sql.rstrip().splitlines()[-1].startswith("INSERT INTO publication_runs")


def test_failed_final_insert_rolls_back_domain_data_and_history(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = sqlite3.connect(":memory:")
    db.executescript(SCHEMA)
    first = emit(monkeypatch, tmp_path / "first.sql", "2026-09-23T12:00:00+00:00", "one", 2)
    execute_atomic(db, first)
    before = state(db)

    second = emit(monkeypatch, tmp_path / "second.sql", "2026-09-23T13:00:00+00:00", "two", 5)
    corrupt = second.replace("INSERT INTO publication_runs", "INSERT INTO missing_publication_table")
    with pytest.raises(sqlite3.Error):
        execute_atomic(db, corrupt)
    assert state(db) == before

    execute_atomic(db, second)
    assert db.execute("SELECT snapshot_id FROM snapshots").fetchone() == ("snapshot-two",)
    assert db.execute("SELECT snapshot_id FROM publication_runs ORDER BY run_id").fetchall() == [
        ("snapshot-one",),
        ("snapshot-two",),
    ]
    parsed = json.loads(
        db.execute("SELECT source_status_json FROM publication_runs ORDER BY run_id DESC").fetchone()[0]
    )
    assert parsed["openfootball_cl"]["status"] == "unavailable"
