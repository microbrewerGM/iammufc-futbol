-- REQ-D1-TABLE: question_requests, the only table that stores unparsed free text.
--
-- Contract: data-platform/docs/question-requests-spec.md (REQ-SPEC) sections 3 and 4,
-- and contracts/question-triage-verdict.schema.json for verdict_json.
--
-- UNTRUSTED TEXT. `text` is a human's free-text question. It is data only: it is
-- always written and read through bound parameters, never concatenated into SQL,
-- a prompt instruction, a URL, a path or unescaped HTML. The database enforces
-- what SQLite can check: TEXT type, 1-500 code points, at most 2000 bytes, no NUL,
-- no Unicode Cc (U+0001-U+001F, U+007F-U+009F) and no invisible or reordering
-- format characters: U+00AD, U+061C, U+180E, U+200B-U+200F, U+2028-U+202E,
-- U+2060-U+206F, U+FEFF, U+FFF9-U+FFFB and tags U+E0000-U+E007F. The intake route
-- must apply the same set so users get a validation error, not a database error.
-- NFC normalization cannot be checked in SQL; the intake route owns it.
--
-- NULL SAFETY. SQLite passes a CHECK whose expression is NULL and skips a trigger
-- whose WHEN is NULL, so every compound condition here is wrapped in coalesce()
-- and timestamp format checks use `IS` (strftime returns NULL for invalid dates).
--
-- STATE MACHINE (spec section 4). Statuses: received, triaging, triaged, junk,
-- queued, filled, partial, no_data, triage_failed. A BEFORE UPDATE trigger
-- allows only the transitions in the spec table, every update must raise
-- `revision` by exactly 1 (compare-and-set fence, as 0008), identity columns are
-- immutable, and a verdict cannot change once stored. Lease columns mirror
-- exploration_shared_jobs: a settled row keeps lease_id and lease_owner as
-- fencing and audit data and clears lease_expires_at. A lease lasts at most 900 s.
--
-- NO REPLACE. INSERT OR REPLACE / REPLACE INTO would delete a settled row and
-- reinsert it as received, bypassing the state machine. A BEFORE INSERT trigger
-- silently ignores any insert whose request_id or (account_sub, UTC day,
-- text_hash) already exists, so REPLACE and plain INSERT of a duplicate change
-- nothing (changes = 0) and ON CONFLICT DO NOTHING keeps working. Intake must read
-- the existing row's request_id when its insert reports zero changes.
--
-- CLOCK. Writers cannot backdate or forward-date: created_at on insert, and
-- claimed_at or updated_at whenever an update changes them, must be within 300 s
-- of the database clock.
--
-- VERDICT. verdict_json is NULL until ack stores a verdict. When present it is
-- valid JSON, at most 10240 bytes, names this row's request_id, and matches the
-- closed v1 verdict shape (checked by triggers, as the 0008 JSON triggers do).
-- Allowlists (field IDs, competitions, seasons) and uniqueness stay in code.
--
-- RETENTION. Rows expire 90 days after created_at (as exploration_request_links).
-- The PURGE block at the end deletes expired rows; deleting a question never
-- touches exploration_shared_* rows, which follow their own links.
-- exploration_request_id is a plain reference, not a foreign key, for that reason.
--
-- IDEMPOTENT: every object is CREATE ... IF NOT EXISTS; re-applying changes nothing.

CREATE TABLE IF NOT EXISTS question_requests (
  request_id TEXT NOT NULL PRIMARY KEY CHECK (typeof(request_id) = 'text' AND length(request_id) = 64 AND request_id NOT GLOB '*[^0-9a-f]*'),
  account_sub TEXT NOT NULL CHECK (typeof(account_sub) = 'text' AND length(account_sub) BETWEEN 1 AND 512 AND
    length(CAST(account_sub AS BLOB)) <= 2048 AND instr(CAST(account_sub AS BLOB), x'00') = 0 AND
    account_sub NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1564) || char(6158) ||
      char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8303) ||
      char(65279) || char(65529) || '-' || char(65531) || char(917504) || '-' || char(917631) || ']*')),
  text TEXT NOT NULL CHECK (typeof(text) = 'text' AND length(text) BETWEEN 1 AND 500 AND
    length(CAST(text AS BLOB)) <= 2000 AND instr(CAST(text AS BLOB), x'00') = 0 AND
    text NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1564) || char(6158) ||
      char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8303) ||
      char(65279) || char(65529) || '-' || char(65531) || char(917504) || '-' || char(917631) || ']*')),
  locale TEXT NOT NULL CHECK (locale IN ('en','es')),
  text_hash TEXT NOT NULL CHECK (typeof(text_hash) = 'text' AND length(text_hash) = 64 AND text_hash NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('received','triaging','triaged','junk','queued','filled','partial','no_data','triage_failed')),
  verdict_json TEXT CHECK (verdict_json IS NULL OR coalesce((
    typeof(verdict_json) = 'text' AND length(CAST(verdict_json AS BLOB)) <= 10240 AND
    json_valid(verdict_json) AND json_type(verdict_json) = 'object' AND
    json_type(verdict_json, '$.version') IS 'integer' AND json_extract(verdict_json, '$.version') = 1 AND
    json_type(verdict_json, '$.request_id') IS 'text' AND json_extract(verdict_json, '$.request_id') = request_id AND
    ((json_type(verdict_json, '$.relevant') IS 'true' AND json_type(verdict_json, '$.junk_reason') IS 'null') OR
     (json_type(verdict_json, '$.relevant') IS 'false' AND json_type(verdict_json, '$.junk_reason') IS 'text' AND
      json_array_length(verdict_json, '$.tables') = 0 AND json_array_length(verdict_json, '$.visuals') = 0 AND
      json_array_length(verdict_json, '$.field_status') = 0 AND json_array_length(verdict_json, '$.families') = 0))), 0)),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempt) = 'integer' AND attempt BETWEEN 0 AND 3),
  lease_id TEXT CHECK (lease_id IS NULL OR (length(lease_id) BETWEEN 1 AND 96 AND lease_id NOT GLOB '*[^a-z0-9:_-]*')),
  lease_owner TEXT CHECK (lease_owner IS NULL OR (length(lease_owner) BETWEEN 1 AND 96 AND lease_owner NOT GLOB '*[^a-z0-9:_-]*')),
  lease_expires_at TEXT CHECK (lease_expires_at IS NULL OR (length(lease_expires_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', lease_expires_at) IS lease_expires_at)),
  claimed_at TEXT CHECK (claimed_at IS NULL OR (length(claimed_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', claimed_at) IS claimed_at)),
  retry_after TEXT CHECK (retry_after IS NULL OR (length(retry_after) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', retry_after) IS retry_after)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (typeof(revision) = 'integer' AND revision >= 1),
  exploration_request_id TEXT CHECK (exploration_request_id IS NULL OR (length(exploration_request_id) = 64 AND exploration_request_id NOT GLOB '*[^0-9a-f]*')),
  created_at TEXT NOT NULL CHECK (length(created_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', updated_at) IS updated_at AND coalesce(updated_at >= created_at, 0)),
  expires_at TEXT NOT NULL CHECK (length(expires_at) = 20 AND expires_at IS strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+90 days')),
  CHECK (claimed_at IS NULL OR coalesce(claimed_at >= created_at, 0)),
  -- Column shape per status. "Settled" rows (every status after triaging) keep
  -- the last lease identity, have no live lease and no pending retry.
  CHECK (coalesce((
    (status = 'received' AND lease_expires_at IS NULL AND verdict_json IS NULL AND exploration_request_id IS NULL AND (
      (attempt = 0 AND lease_id IS NULL AND lease_owner IS NULL AND claimed_at IS NULL AND retry_after IS NULL) OR
      (attempt BETWEEN 1 AND 2 AND lease_id IS NOT NULL AND lease_owner IS NOT NULL AND claimed_at IS NOT NULL AND
       retry_after IS NOT NULL AND retry_after > claimed_at AND
       retry_after <= strftime('%Y-%m-%dT%H:%M:%SZ', claimed_at, '+1 day')))) OR
    (status = 'triaging' AND attempt BETWEEN 1 AND 3 AND lease_id IS NOT NULL AND lease_owner IS NOT NULL AND
     claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_expires_at > claimed_at AND
     lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%SZ', claimed_at, '+900 seconds') AND retry_after IS NULL AND
     verdict_json IS NULL AND exploration_request_id IS NULL) OR
    (status IN ('triage_failed','junk','triaged','queued','filled','partial','no_data') AND attempt BETWEEN 1 AND 3 AND
     lease_id IS NOT NULL AND lease_owner IS NOT NULL AND claimed_at IS NOT NULL AND
     lease_expires_at IS NULL AND retry_after IS NULL AND (
      (status = 'triage_failed' AND attempt = 3 AND verdict_json IS NULL AND exploration_request_id IS NULL) OR
      (status = 'junk' AND json_type(verdict_json, '$.relevant') IS 'false' AND exploration_request_id IS NULL) OR
      (status = 'triaged' AND json_type(verdict_json, '$.relevant') IS 'true' AND exploration_request_id IS NULL) OR
      (status = 'queued' AND json_type(verdict_json, '$.relevant') IS 'true' AND exploration_request_id IS NOT NULL) OR
      (status IN ('filled','partial','no_data') AND json_type(verdict_json, '$.relevant') IS 'true')))
  ), 0))
);

-- One question per account, normalized text and UTC day (intake returns the existing ID).
CREATE UNIQUE INDEX IF NOT EXISTS idx_question_requests_account_day_text
  ON question_requests(account_sub, substr(created_at, 1, 10), text_hash);
-- Pending scan for the triage bridge read and claim.
CREATE INDEX IF NOT EXISTS idx_question_requests_pending
  ON question_requests(status, retry_after, created_at, request_id);
CREATE INDEX IF NOT EXISTS idx_question_requests_expiry
  ON question_requests(expires_at);

-- Duplicates are ignored, never replaced (see NO REPLACE above).
CREATE TRIGGER IF NOT EXISTS question_requests_no_replace
BEFORE INSERT ON question_requests
WHEN EXISTS (SELECT 1 FROM question_requests WHERE request_id = NEW.request_id) OR
  EXISTS (SELECT 1 FROM question_requests WHERE account_sub = NEW.account_sub AND
    substr(created_at, 1, 10) = substr(NEW.created_at, 1, 10) AND text_hash = NEW.text_hash)
BEGIN
  SELECT RAISE(IGNORE);
END;

-- Intake inserts only fresh, unclaimed rows.
CREATE TRIGGER IF NOT EXISTS question_requests_initial_insert
BEFORE INSERT ON question_requests
WHEN NEW.status IS NOT 'received' OR NEW.attempt IS NOT 0 OR NEW.revision IS NOT 1 OR
  NEW.lease_id IS NOT NULL OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL OR
  NEW.claimed_at IS NOT NULL OR NEW.retry_after IS NOT NULL OR NEW.verdict_json IS NOT NULL OR
  NEW.exploration_request_id IS NOT NULL OR NEW.updated_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'question requests must start received and unclaimed');
END;

-- Writers cannot backdate or forward-date (see CLOCK above).
CREATE TRIGGER IF NOT EXISTS question_requests_clock_insert
BEFORE INSERT ON question_requests
WHEN coalesce(NEW.created_at NOT BETWEEN strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-300 seconds')
  AND strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+300 seconds'), 1)
BEGIN
  SELECT RAISE(ABORT, 'question request timestamps must be within 300 seconds of now');
END;
CREATE TRIGGER IF NOT EXISTS question_requests_clock_update
BEFORE UPDATE ON question_requests
WHEN (NEW.updated_at IS NOT OLD.updated_at AND coalesce(NEW.updated_at NOT BETWEEN
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-300 seconds') AND strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+300 seconds'), 1)) OR
  (NEW.claimed_at IS NOT OLD.claimed_at AND coalesce(NEW.claimed_at NOT BETWEEN
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-300 seconds') AND strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+300 seconds'), 1))
BEGIN
  SELECT RAISE(ABORT, 'question request timestamps must be within 300 seconds of now');
END;

-- Allowed transitions (spec section 4). Every other update aborts, including any
-- whose condition evaluates to NULL.
CREATE TRIGGER IF NOT EXISTS question_requests_state_machine
BEFORE UPDATE ON question_requests
WHEN NEW.request_id IS NOT OLD.request_id OR NEW.account_sub IS NOT OLD.account_sub OR
  NEW.text IS NOT OLD.text OR NEW.locale IS NOT OLD.locale OR NEW.text_hash IS NOT OLD.text_hash OR
  NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at OR
  NEW.revision IS NOT OLD.revision + 1 OR coalesce(NEW.updated_at < OLD.updated_at, 1) OR NOT coalesce((
  -- claim: a new lease of at most 900 s, attempt + 1, only once any backoff is due.
  (OLD.status = 'received' AND NEW.status = 'triaging' AND OLD.attempt < 3 AND NEW.attempt = OLD.attempt + 1 AND
   NEW.claimed_at IS NOT NULL AND (OLD.claimed_at IS NULL OR NEW.claimed_at >= OLD.claimed_at) AND
   (OLD.retry_after IS NULL OR OLD.retry_after <= NEW.claimed_at) AND
   NEW.lease_id IS NOT NULL AND NEW.lease_owner IS NOT NULL AND (OLD.lease_id IS NULL OR NEW.lease_id != OLD.lease_id) AND
   NEW.lease_expires_at IS NOT NULL AND NEW.lease_expires_at > NEW.claimed_at AND
   NEW.lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%SZ', NEW.claimed_at, '+900 seconds') AND NEW.retry_after IS NULL AND
   NEW.verdict_json IS NULL AND NEW.exploration_request_id IS NULL) OR
  -- sweep (lease expired) or ack failed with attempts left: back to received with backoff.
  (OLD.status = 'triaging' AND NEW.status = 'received' AND OLD.attempt < 3 AND NEW.attempt = OLD.attempt AND
   NEW.claimed_at IS OLD.claimed_at AND NEW.lease_expires_at IS NULL AND NEW.retry_after IS NOT NULL AND
   NEW.verdict_json IS NULL AND NEW.exploration_request_id IS NULL) OR
  -- sweep or ack failed on the last attempt.
  (OLD.status = 'triaging' AND NEW.status = 'triage_failed' AND OLD.attempt = 3 AND NEW.attempt = 3 AND
   NEW.claimed_at IS OLD.claimed_at AND NEW.lease_expires_at IS NULL AND NEW.retry_after IS NULL AND
   NEW.verdict_json IS NULL AND NEW.exploration_request_id IS NULL) OR
  -- ack with a valid verdict.
  (OLD.status = 'triaging' AND NEW.status IN ('junk','triaged') AND NEW.attempt = OLD.attempt AND
   NEW.claimed_at IS OLD.claimed_at AND NEW.lease_expires_at IS NULL AND NEW.retry_after IS NULL AND
   NEW.verdict_json IS NOT NULL AND NEW.exploration_request_id IS NULL) OR
  -- ack batch (triaged) or sweep (queued) settles; the verdict and lease audit stay fixed.
  (((OLD.status = 'triaged' AND NEW.status IN ('queued','filled','partial','no_data') AND
     (NEW.status = 'queued' OR NEW.exploration_request_id IS NULL)) OR
    (OLD.status = 'queued' AND NEW.status IN ('filled','partial','no_data') AND
     NEW.exploration_request_id IS OLD.exploration_request_id)) AND
   NEW.attempt = OLD.attempt AND NEW.claimed_at IS OLD.claimed_at AND
   NEW.lease_id IS OLD.lease_id AND NEW.lease_owner IS OLD.lease_owner AND
   NEW.lease_expires_at IS NULL AND NEW.retry_after IS NULL AND NEW.verdict_json IS OLD.verdict_json)
), 0)
BEGIN
  SELECT RAISE(ABORT, 'invalid question request state transition');
END;

-- Any update of a triaging row is fenced by its lease identity (ack, sweep).
CREATE TRIGGER IF NOT EXISTS question_requests_triaging_lease_fence
BEFORE UPDATE ON question_requests
WHEN OLD.status = 'triaging' AND (NEW.lease_id IS NOT OLD.lease_id OR NEW.lease_owner IS NOT OLD.lease_owner)
BEGIN
  SELECT RAISE(ABORT, 'triaging question update must match lease and revision');
END;

-- Closed v1 verdict shape (contracts/question-triage-verdict.schema.json):
-- exactly the nine keys, closed enums, length and count caps, closed nested
-- objects. Guarded by json_valid so malformed JSON reaches the column CHECK; an
-- unknown (NULL) result counts as a violation.
CREATE TRIGGER IF NOT EXISTS question_requests_verdict_shape
BEFORE UPDATE ON question_requests
WHEN NEW.verdict_json IS NOT NULL AND json_valid(NEW.verdict_json) AND coalesce((
  json_type(NEW.verdict_json) IS NOT 'object' OR
  (SELECT count(*) FROM json_each(NEW.verdict_json)) != 9 OR
  json_type(NEW.verdict_json, '$.version') IS NOT 'integer' OR
  json_type(NEW.verdict_json, '$.request_id') IS NOT 'text' OR
  IFNULL(json_type(NEW.verdict_json, '$.relevant'), '') NOT IN ('true','false') OR
  IFNULL(json_type(NEW.verdict_json, '$.junk_reason'), '') NOT IN ('null','text') OR
  (json_type(NEW.verdict_json, '$.junk_reason') IS 'text' AND json_extract(NEW.verdict_json, '$.junk_reason') NOT IN
    ('off_topic','not_a_question','abusive','prompt_injection','unintelligible','out_of_scope')) OR
  json_type(NEW.verdict_json, '$.restated_question') IS NOT 'text' OR
  length(json_extract(NEW.verdict_json, '$.restated_question')) > 300 OR
  instr(CAST(json_extract(NEW.verdict_json, '$.restated_question') AS BLOB), x'00') != 0 OR
  json_extract(NEW.verdict_json, '$.restated_question') GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1564) || char(6158) ||
    char(8203) || '-' || char(8207) || char(8232) || '-' || char(8238) || char(8288) || '-' || char(8303) ||
    char(65279) || char(65529) || '-' || char(65531) || char(917504) || '-' || char(917631) || '<>`]*') OR
  json_type(NEW.verdict_json, '$.tables') IS NOT 'array' OR json_array_length(NEW.verdict_json, '$.tables') > 3 OR
  json_type(NEW.verdict_json, '$.visuals') IS NOT 'array' OR json_array_length(NEW.verdict_json, '$.visuals') > 4 OR
  json_type(NEW.verdict_json, '$.field_status') IS NOT 'array' OR json_array_length(NEW.verdict_json, '$.field_status') > 24 OR
  json_type(NEW.verdict_json, '$.families') IS NOT 'array' OR json_array_length(NEW.verdict_json, '$.families') > 1 OR
  EXISTS (SELECT 1 FROM json_each(NEW.verdict_json, '$.families') WHERE type != 'text' OR value != 'arrival_manager') OR
  EXISTS (
    SELECT 1 FROM json_each(NEW.verdict_json, '$.tables') AS t
    WHERE t.type != 'object' OR (SELECT count(*) FROM json_each(t.value)) != 2 OR
      json_type(t.value, '$.fields') IS NOT 'array' OR json_array_length(t.value, '$.fields') NOT BETWEEN 1 AND 8 OR
      EXISTS (SELECT 1 FROM json_each(t.value, '$.fields') AS f
        WHERE f.type != 'text' OR length(f.value) NOT BETWEEN 1 AND 64 OR f.value NOT GLOB '[a-z]*' OR f.value GLOB '*[^a-z0-9_]*') OR
      json_type(t.value, '$.filters') IS NOT 'object' OR (SELECT count(*) FROM json_each(t.value, '$.filters')) != 4 OR
      json_type(t.value, '$.filters.season') IS NOT 'array' OR json_array_length(t.value, '$.filters.season') > 20 OR
      EXISTS (SELECT 1 FROM json_each(t.value, '$.filters.season') AS s
        WHERE s.type != 'text' OR length(s.value) != 7 OR s.value NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]') OR
      json_type(t.value, '$.filters.competition') IS NOT 'array' OR json_array_length(t.value, '$.filters.competition') > 4 OR
      EXISTS (SELECT 1 FROM json_each(t.value, '$.filters.competition') AS c
        WHERE c.type != 'text' OR length(c.value) NOT BETWEEN 1 AND 16 OR c.value NOT GLOB '[A-Z]*' OR c.value GLOB '*[^A-Z0-9_]*') OR
      json_type(t.value, '$.filters.opponent_id') IS NOT 'array' OR json_array_length(t.value, '$.filters.opponent_id') > 5 OR
      json_type(t.value, '$.filters.person_id') IS NOT 'array' OR json_array_length(t.value, '$.filters.person_id') > 5 OR
      EXISTS (SELECT 1 FROM json_each(t.value, '$.filters.opponent_id') AS o
        WHERE o.type != 'text' OR length(o.value) NOT BETWEEN 1 AND 64 OR o.value NOT GLOB '[a-z0-9]*' OR o.value GLOB '*[^a-z0-9:_-]*') OR
      EXISTS (SELECT 1 FROM json_each(t.value, '$.filters.person_id') AS p
        WHERE p.type != 'text' OR length(p.value) NOT BETWEEN 1 AND 64 OR p.value NOT GLOB '[a-z0-9]*' OR p.value GLOB '*[^a-z0-9:_-]*')
  ) OR
  EXISTS (
    SELECT 1 FROM json_each(NEW.verdict_json, '$.visuals') AS v
    WHERE v.type != 'object' OR (SELECT count(*) FROM json_each(v.value)) != 2 OR
      json_type(v.value, '$.kind') IS NOT 'text' OR json_extract(v.value, '$.kind') NOT IN ('table','bar','dot_plot','line') OR
      json_type(v.value, '$.table_index') IS NOT 'integer' OR json_extract(v.value, '$.table_index') NOT BETWEEN 0 AND 2 OR
      json_extract(v.value, '$.table_index') >= json_array_length(NEW.verdict_json, '$.tables')
  ) OR
  EXISTS (
    SELECT 1 FROM json_each(NEW.verdict_json, '$.field_status') AS fs
    WHERE fs.type != 'object' OR (SELECT count(*) FROM json_each(fs.value)) != 2 OR
      json_type(fs.value, '$.field') IS NOT 'text' OR length(json_extract(fs.value, '$.field')) NOT BETWEEN 1 AND 64 OR
      json_extract(fs.value, '$.field') NOT GLOB '[a-z]*' OR json_extract(fs.value, '$.field') GLOB '*[^a-z0-9_]*' OR
      json_type(fs.value, '$.status') IS NOT 'text' OR json_extract(fs.value, '$.status') NOT IN ('available','missing','unknown')
  )
), 1)
BEGIN
  SELECT RAISE(ABORT, 'invalid question triage verdict shape');
END;

-- PURGE statement (run on a schedule; the migration test executes exactly the
-- text between the markers, so this block and the tested SQL cannot drift).
-- Deletes expired questions in bounded batches; shared exploration rows are untouched.
-- PURGE-BEGIN
-- DELETE FROM question_requests WHERE request_id IN (SELECT request_id FROM question_requests WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now') ORDER BY expires_at, request_id LIMIT 100);
-- PURGE-END
