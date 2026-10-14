"""Execute the runtime cache statement against SQLite, without D1 credentials."""
import re
import sqlite3
from pathlib import Path


def test_cache_write_cannot_reintroduce_retired_snapshot():
    source = (Path(__file__).resolve().parents[1] / "worker/src/core/db.ts").read_text()
    sql = re.search(r"`(INSERT INTO query_result_cache.*?)`", source, re.S).group(1)
    db = sqlite3.connect(":memory:")
    db.executescript("""
        CREATE TABLE snapshots (snapshot_id TEXT PRIMARY KEY, created_at TEXT);
        CREATE TABLE query_result_cache (
            artifact_key TEXT, snapshot_id TEXT, schema_version INTEGER, result_json TEXT,
            PRIMARY KEY (artifact_key, snapshot_id)
        );
    """)

    def write(snapshot, payload):
        # Runtime binds payload then snapshot for the atomic publication guard.
        params = ("key", snapshot, payload)
        if sql.count("?") == 4:
            params += (snapshot,)
        return db.execute(sql, params).rowcount

    db.execute("INSERT INTO snapshots VALUES ('old', '2026-10-01')")
    assert write("old", "first") == 1
    assert write("old", "updated") == 1
    assert db.execute("SELECT result_json FROM query_result_cache").fetchone() == ("updated",)
    db.execute("DELETE FROM snapshots")
    db.execute("INSERT INTO snapshots VALUES ('new', '2026-10-02')")
    db.execute("DELETE FROM query_result_cache WHERE snapshot_id NOT IN (SELECT snapshot_id FROM snapshots)")
    assert write("old", "late") == 0
    assert db.execute("SELECT COUNT(*) FROM query_result_cache").fetchone() == (0,)
    assert write("new", "current") == 1
    # Even if an obsolete row already exists, the guard must refuse its update.
    db.execute("INSERT INTO query_result_cache VALUES ('key', 'old', 1, 'preserved')")
    assert write("old", "late update") == 0
    assert db.execute("SELECT result_json FROM query_result_cache WHERE snapshot_id='old'").fetchone() == ("preserved",)
    db.execute("DELETE FROM snapshots")
    assert write("new", "no publication") == 0
