import json
import re
import shlex
import sqlite3
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / 'infra/migrations'
WORKFLOW = ROOT / '.github/workflows/deploy.yml'
ONCE = MIGRATIONS / 'once/0020_drop_empty_question_tables.sql'
REQUEST = 'a' * 64
OLD = "'*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1564) || char(6158) || char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(917504) || '-' || char(917631) || ']*'"


def chain():
    workflow = yaml.load(WORKFLOW.read_text(), Loader=yaml.BaseLoader)
    commands = [s.get('with', {}).get('command', '') for s in workflow['jobs']['deploy-dev']['steps']]
    return [Path(shlex.split(c)[-1]).name for c in commands if '--file infra/migrations/' in c and '/once/' not in c]


def apply(db, old=False):
    for name in chain():
        sql = (MIGRATIONS / name).read_text()
        if old and name.startswith(('0010_', '0014_')):
            # Reconstruct fixed old expressions from literal, including verdict extras.
            for lhs in ('account_sub', 'text', "json_extract(NEW.verdict_json, '$.restated_question')"):
                op = 'GLOB' if lhs.startswith('json_') else 'NOT GLOB'
                join = 'OR' if op == 'GLOB' else 'AND'
                expr = r'\((?:[^()]|char\(\d+\))*\)'
                pattern = re.escape(lhs) + r'\s+' + op + r'\s*' + expr + r'\s*' + join + r'\s*' + re.escape(lhs) + r'\s+' + op + r'\s*' + expr
                sql = re.sub(pattern, lambda m: lhs + ' ' + op + ' (' + (OLD.replace("']*'", "'< >`]*'".replace(' ', '')) if op == 'GLOB' else OLD) + ')', sql, flags=re.S)
        db.executescript(sql)


def db_new(old=False):
    db = sqlite3.connect(':memory:')
    db.execute('PRAGMA foreign_keys=ON')
    apply(db, old)
    return db


def intake(db):
    source = (ROOT / 'worker/src/core/question-requests.ts').read_text()
    sql = re.search(r'prepare\s*\(`(INSERT INTO question_requests\s+.*?)`\)', source, re.S).group(1)
    now = db.execute("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now')").fetchone()[0]
    db.execute(sql, (REQUEST, 'owner', 'Show goals', 'en', 'b' * 64, now, now, now))
    return now


def clarification(db):
    now = intake(db)
    db.execute("UPDATE question_requests SET status='triaging',attempt=1,lease_id='test-lease',lease_owner='test-service',claimed_at=?,lease_expires_at=strftime('%Y-%m-%dT%H:%M:%SZ',?,'+900 seconds'),updated_at=?,revision=revision+1", (now, now, now))
    verdict = json.dumps(dict(version=1, request_id=REQUEST, relevant=True, junk_reason=None, restated_question='Show goals', tables=[], visuals=[], field_status=[], families=[]))
    db.execute("UPDATE question_requests SET status='triaged',verdict_json=?,lease_expires_at=NULL,updated_at=?,revision=revision+1", (verdict, now))
    db.execute("UPDATE question_requests SET status='no_data',updated_at=?,revision=revision+1", (now,))
    db.execute("INSERT INTO question_request_results(request_id,request_revision,state,created_at,updated_at,response_deadline,expires_at) SELECT request_id,4,'clarification_required',?,?,strftime('%Y-%m-%dT%H:%M:%SZ',?,'+1 day'),expires_at FROM question_requests", (now, now, now))
    db.execute("UPDATE question_requests SET status='received',attempt=0,verdict_json=NULL,lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,claimed_at=NULL,retry_after=NULL,updated_at=?,revision=revision+1", (now,))
    db.execute("INSERT INTO question_request_clarifications(request_id,generation,parent_revision,text,submitted_at) VALUES (?,1,5,'Clarified question',?)", (REQUEST, now))


def test_intake_and_later_steps():
    db = db_new()
    db.setlimit(sqlite3.SQLITE_LIMIT_LIKE_PATTERN_LENGTH, 50)
    clarification(db)
    assert db.execute('SELECT count(*) FROM question_request_clarifications').fetchone() == (1,)


def test_original_limit_and_exact_policy():
    db = sqlite3.connect(':memory:')
    assert len(db.execute('SELECT ' + OLD).fetchone()[0].encode()) == 58
    db.setlimit(sqlite3.SQLITE_LIMIT_LIKE_PATTERN_LENGTH, 50)
    with pytest.raises(sqlite3.OperationalError, match='LIKE or GLOB pattern too complex'):
        db.execute('SELECT ? GLOB (' + OLD + ')', ('hello',)).fetchone()
    db.setlimit(sqlite3.SQLITE_LIMIT_LIKE_PATTERN_LENGTH, 50000)
    boundaries = [1, 31, 127, 159, 173, 1564, 6158, 8203, 8207, 8232, 8238, 8288, 8303, 65279, 65529, 65531, 917504, 917631]
    values = {0, 0x1f600, 60, 62, 96} | {n + d for n in boundaries for d in (-1, 0, 1)}
    # Read the clauses from the migrations themselves, so a changed clause fails here.
    verdict = "json_extract(NEW.verdict_json, '$.restated_question')"
    for name, lhs, suffix in [('0010_question_requests.sql', 'account_sub', ''),
                              ('0010_question_requests.sql', 'text', ''),
                              ('0010_question_requests.sql', verdict, '<>`'),
                              ('0014_question_request_clarifications.sql', 'text', '')]:
        sql = (MIGRATIONS / name).read_text()
        parts = re.findall(re.escape(lhs) + r'\s+(?:NOT\s+)?GLOB\s*\(((?:[^()]|char\(\d+\))*)\)', sql)
        assert len(parts) == 2, (name, lhs)
        old = OLD.replace("']*'", "'" + suffix + "]*'")
        for n in values:
            value = 'x' + chr(n) + 'y'
            expected = db.execute('SELECT ? GLOB (' + old + ')', (value,)).fetchone()[0]
            actual = any(db.execute('SELECT ? GLOB (' + p + ')', (value,)).fetchone()[0] for p in parts)
            assert bool(expected) == actual, (name, lhs, n)


def test_patterns_bounded():
    db = sqlite3.connect(':memory:')
    seen = 0
    for path in sorted(MIGRATIONS.glob('*.sql')):
        for pattern in re.findall(r'\b(?:GLOB|LIKE)\s*(\((?:[^()]|char\(\d+\))*\)|\'[^\']*\')', path.read_text(), re.I):
            seen += 1
            assert len(db.execute('SELECT ' + pattern).fetchone()[0].encode()) <= 50, (path.name, pattern)
    assert seen


def test_old_schema_repair():
    old = db_new(old=True)
    # Prove the fixture really has the failing schema before repairing it.
    old.setlimit(sqlite3.SQLITE_LIMIT_LIKE_PATTERN_LENGTH, 50)
    with pytest.raises(sqlite3.OperationalError, match='LIKE or GLOB pattern too complex'):
        intake(old)
    old.rollback()
    old.setlimit(sqlite3.SQLITE_LIMIT_LIKE_PATTERN_LENGTH, 50000)
    old.executescript(ONCE.read_text())
    apply(old)
    fresh = db_new()
    schema = 'SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name'
    assert old.execute(schema).fetchall() == fresh.execute(schema).fetchall()
    old.setlimit(sqlite3.SQLITE_LIMIT_LIKE_PATTERN_LENGTH, 50)
    intake(old)


def test_interrupted_repair_recovers_by_rerunning_the_ordinary_list():
    # The drop and the recreation are separate workflow steps. A job can stop after any file,
    # and every later deploy or seed load re-runs the whole list. That must restore everything.
    schema = 'SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name'
    expected = db_new().execute(schema).fetchall()
    names = chain()
    for stopped_after in range(len(names) + 1):
        db = db_new()
        db.executescript(ONCE.read_text())
        for name in names[:stopped_after]:
            db.executescript((MIGRATIONS / name).read_text())
        apply(db)
        assert db.execute(schema).fetchall() == expected, names[:stopped_after]
        db.setlimit(sqlite3.SQLITE_LIMIT_LIKE_PATTERN_LENGTH, 50)
        intake(db)


def test_rerunning_the_once_file_after_an_interruption_changes_nothing():
    # With a table missing, its guard fails on the first statement and nothing more runs.
    db = db_new()
    db.executescript(ONCE.read_text())
    schema = 'SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name'
    before = db.execute(schema).fetchall()
    with pytest.raises(sqlite3.OperationalError, match='no such table'):
        db.executescript(ONCE.read_text())
    assert db.execute(schema).fetchall() == before


@pytest.mark.parametrize('with_clarification', [False, True])
def test_guard(with_clarification):
    db = db_new()
    if with_clarification:
        clarification(db)
    else:
        intake(db)
    db.commit()
    before = db.execute('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').fetchall()
    with pytest.raises(sqlite3.OperationalError, match='integer overflow'):
        db.executescript(ONCE.read_text())
    assert db.execute('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').fetchall() == before
    apply(db)
    apply(db)
    assert db.execute('SELECT count(*) FROM question_requests').fetchone() == (1,)
    assert db.execute('SELECT count(*) FROM question_request_clarifications').fetchone() == (int(with_clarification),)


def test_workflow():
    text = WORKFLOW.read_text()
    w = yaml.load(text, Loader=yaml.BaseLoader)
    assert w['on']['workflow_dispatch']['inputs']['drop_empty_question_tables']['default'] == 'false'
    steps = w['jobs']['deploy-dev']['steps']
    index = next(i for i, s in enumerate(steps) if s.get('name') == 'Apply migrations (dev)')
    step = steps[index - 1]
    assert step['if'] == "github.event_name == 'workflow_dispatch' && inputs.drop_empty_question_tables == true"
    assert 'once/0020_drop_empty_question_tables.sql' in step['with']['command']
    assert text.count('once/0020_drop_empty_question_tables.sql') == 1
