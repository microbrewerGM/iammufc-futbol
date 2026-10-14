"""Execute the runtime cache statement and migrations against in-memory SQLite."""
import re
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT_OLD = "b" * 64
SNAPSHOT_NEW = "c" * 64
KEY_FIRST = "00000001" + "a" * 56
KEY_COLLISION = "00000201" + "d" * 56


def cache_slot(artifact_key: str) -> int:
    return int(artifact_key[:8], 16) % 512


def test_cache_write_is_bounded_direct_mapped_and_snapshot_guarded():
    source = (ROOT / "worker/src/core/db.ts").read_text()
    sql = re.search(
        r"`(INSERT INTO query_result_cache_slots.*?)`", source, re.S
    ).group(1)
    db = sqlite3.connect(":memory:")
    db.executescript((ROOT / "infra/migrations/0001_schema.sql").read_text())
    db.execute(
        "INSERT INTO query_result_cache VALUES (?, ?, 1, ?)",
        ("a" * 64, SNAPSHOT_OLD, "legacy"),
    )
    migration = (ROOT / "infra/migrations/0004_cache_slots.sql").read_text()
    db.executescript(migration)
    db.executescript(migration)  # rerunning the additive migration is safe

    assert db.execute("SELECT COUNT(*) FROM query_result_cache").fetchone() == (0,)
    try:
        db.execute(
            "INSERT INTO query_result_cache VALUES (?, ?, 1, ?)",
            ("e" * 64, SNAPSHOT_OLD, "legacy write"),
        )
    except sqlite3.DatabaseError:
        pass
    else:
        raise AssertionError("rollback Worker cache writes must remain disabled")

    def write(artifact_key: str, snapshot: str, payload: str) -> int:
        slot = cache_slot(artifact_key)
        # Runtime bind order: slot, key, snapshot, payload, active-snapshot guard.
        return db.execute(
            sql,
            (slot, artifact_key, snapshot, payload, snapshot),
        ).rowcount

    db.execute(
        "INSERT INTO snapshots VALUES (?, ?, ?, ?)",
        (SNAPSHOT_OLD, "2026-10-01", "{}", "{}"),
    )
    assert write(KEY_FIRST, SNAPSHOT_OLD, "first") == 1
    assert write(KEY_FIRST, SNAPSHOT_OLD, "updated") == 1
    assert db.execute(
        "SELECT artifact_key, snapshot_id, result_json FROM query_result_cache_slots"
    ).fetchone() == (KEY_FIRST, SNAPSHOT_OLD, "updated")

    db.execute("DELETE FROM snapshots")
    db.execute(
        "INSERT INTO snapshots VALUES (?, ?, ?, ?)",
        (SNAPSHOT_NEW, "2026-10-02", "{}", "{}"),
    )
    assert write(KEY_FIRST, SNAPSHOT_OLD, "late") == 0
    assert db.execute("SELECT COUNT(*) FROM query_result_cache_slots").fetchone() == (1,)
    assert write(KEY_FIRST, SNAPSHOT_NEW, "current") == 1
    assert write(KEY_COLLISION, SNAPSHOT_NEW, "collision overwrite") == 1
    assert cache_slot(KEY_FIRST) == cache_slot(KEY_COLLISION)
    assert db.execute("SELECT COUNT(*) FROM query_result_cache_slots").fetchone() == (1,)
    assert db.execute(
        "SELECT artifact_key, snapshot_id, result_json FROM query_result_cache_slots"
    ).fetchone() == (KEY_COLLISION, SNAPSHOT_NEW, "collision overwrite")

    db.execute("DELETE FROM snapshots")
    assert write(KEY_COLLISION, SNAPSHOT_NEW, "no publication") == 0


def test_slot_table_rejects_non_integer_and_out_of_range_slots():
    db = sqlite3.connect(":memory:")
    db.executescript((ROOT / "infra/migrations/0001_schema.sql").read_text())
    db.executescript((ROOT / "infra/migrations/0004_cache_slots.sql").read_text())
    for slot in range(512):
        db.execute(
            "INSERT INTO query_result_cache_slots VALUES (?, ?, ?, 1, ?)",
            (slot, f"{slot:064x}", SNAPSHOT_OLD, "{}"),
        )
    assert db.execute("SELECT COUNT(*) FROM query_result_cache_slots").fetchone() == (512,)
    for slot in (-1, 512, 0.5):
        try:
            db.execute(
                "INSERT INTO query_result_cache_slots VALUES (?, ?, ?, 1, ?)",
                (slot, "f" * 64, SNAPSHOT_OLD, "{}"),
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError(f"invalid slot {slot!r} must be rejected")
