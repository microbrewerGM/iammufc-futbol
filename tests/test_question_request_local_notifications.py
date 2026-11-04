"""Actual SQLite chain and populated replay; no remote SQL or disk database."""
from pathlib import Path
import sqlite3

import pytest

MIGRATIONS = Path(__file__).resolve().parents[1] / "infra" / "migrations"
REQUEST = "a" * 64


def replay(db):
    for path in sorted(MIGRATIONS.glob("*.sql")):
        db.executescript(path.read_text())


@pytest.fixture
def db():
    connection = sqlite3.connect(":memory:", isolation_level=None)
    connection.execute("PRAGMA foreign_keys=ON")
    replay(connection)
    connection.execute("""INSERT INTO question_requests(request_id,account_sub,text,locale,text_hash,status,created_at,updated_at,expires_at)
      VALUES(?,'account','private','en',?,'received',strftime('%Y-%m-%dT%H:%M:%SZ','now'),strftime('%Y-%m-%dT%H:%M:%SZ','now'),strftime('%Y-%m-%dT%H:%M:%SZ','now','+90 days'))""", (REQUEST, REQUEST))
    connection.execute("""UPDATE question_requests SET status='triaging',attempt=1,lease_id='q2:test',lease_owner='service',
      lease_expires_at=strftime('%Y-%m-%dT%H:%M:%SZ','now','+900 seconds'),claimed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),revision=revision+1""")
    connection.execute("""INSERT INTO question_request_notifications(request_id,desired_status,created_at,updated_at,expires_at)
      SELECT request_id,'triaging',updated_at,updated_at,expires_at FROM question_requests""")
    connection.execute("INSERT INTO question_request_local_notifications(request_id,payload_revision,status)VALUES(?,1,'triaging')", (REQUEST,))
    yield connection
    connection.close()


def lease(db):
    db.execute("""UPDATE question_request_local_notifications SET lease_id='lease',lease_owner='service',
      lease_expires_at=strftime('%Y-%m-%dT%H:%M:%SZ','now','+900 seconds'),revision=revision+1""")


def test_full_chain_replay_preserves_populated_parent_legacy_and_local_rows(db):
    lease(db)
    db.execute("UPDATE question_request_local_notifications SET receipt=?,receipt_lease_id=lease_id,receipt_lease_owner=lease_owner,revision=revision+1", ("a" * 64,))
    tables = ["question_requests", "question_request_results", "question_request_clarifications", "question_request_notifications", "question_request_local_notifications"]
    before = {table: db.execute(f"SELECT * FROM {table}").fetchall() for table in tables}
    replay(db)
    replay(db)
    assert before == {table: db.execute(f"SELECT * FROM {table}").fetchall() for table in tables}


@pytest.mark.parametrize("assignment", ["status='junk'", "payload_revision=2", "request_id='bad'", "result_path='/en/q?metric=goals'", "revision=revision+2"])
def test_payload_and_cas_are_immutable(db, assignment):
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(f"UPDATE question_request_local_notifications SET revision=revision+1,{assignment}")


def test_replace_and_retained_delete_cannot_erase_delivery_history(db):
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT OR REPLACE INTO question_request_local_notifications(request_id,payload_revision,status)VALUES(?,1,'junk')", (REQUEST,))
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("DELETE FROM question_request_local_notifications")
    db.execute("DELETE FROM question_requests")
    assert db.execute("SELECT count(*) FROM question_request_local_notifications").fetchone() == (0,)


def test_receipt_requires_lease_and_delivery_requires_prior_receipt(db):
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("UPDATE question_request_local_notifications SET receipt=?,revision=revision+1", ("a" * 64,))
    lease(db)
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("UPDATE question_request_local_notifications SET receipt=?,delivered=1,lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,revision=revision+1", ("a" * 64,))
    db.execute("UPDATE question_request_local_notifications SET receipt=?,receipt_lease_id=lease_id,receipt_lease_owner=lease_owner,revision=revision+1", ("a" * 64,))
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("UPDATE question_request_local_notifications SET receipt=?,revision=revision+1", ("b" * 64,))
    db.execute("UPDATE question_request_local_notifications SET delivered=1,lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,revision=revision+1")
    assert db.execute("SELECT delivered FROM question_request_local_notifications").fetchone() == (1,)


def test_fake_issue_binding_fails_without_changing_legacy_rows(db):
    db.execute("""UPDATE question_request_notifications SET create_state='pending',creation_revision=1,creation_status='triaging',
      lease_id='lease',lease_owner='service',lease_expires_at=strftime('%Y-%m-%dT%H:%M:%SZ','now','+900 seconds'),
      inflight_revision=1,inflight_status='triaging',revision=revision+1""")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("""UPDATE question_request_notifications SET create_state='bound',issue_number=1,lease_id=NULL,lease_owner=NULL,
          lease_expires_at=NULL,inflight_revision=NULL,inflight_status=NULL,inflight_result_path=NULL,revision=revision+1""")
    assert db.execute("SELECT issue_number FROM question_request_notifications").fetchone() == (None,)
