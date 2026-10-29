import { describe, expect, it } from "vitest";
// @ts-expect-error Node's built-in module is available in the configured test runtime.
import { readFileSync } from "node:fs";
// @ts-expect-error Node's built-in SQLite module is available in the configured test runtime.
import { DatabaseSync } from "node:sqlite";

type Db = InstanceType<typeof DatabaseSync>;
type Row = Record<string, string | number | null | Uint8Array>;
// Same sequence deploy.yml applies; 0007 is superseded by 0008 and 0002 is the generated seed.
const prior = ["0001_schema.sql", "0003_p16_dot_plot.sql", "0004_cache_slots.sql",
  "0005_account_question_history.sql", "0006_season_splits.sql", "0008_exploration_request_links.sql",
  "0009_manager_era_records.sql"];
const migration = "0010_question_requests.sql";
const sqlOf = (name: string): string => readFileSync(`infra/migrations/${name}`, "utf8");

// Real clock values: the migration bounds written timestamps to within 300 s of
// the database clock, so every fixture time sits inside that window.
const iso = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
const now = iso(Date.now());
const at = (base: string, seconds: number) => iso(Date.parse(base) + seconds * 1000);
const days = (base: string, n: number) => at(base, n * 86_400);
const base = at(now, -200);
const claimedAt = at(now, -120);
const hex = (c: string) => c.repeat(64);
const idOf = (n: number) => n.toString(16).padStart(64, "0");
const bytes = (s: string) => Array.from(new TextEncoder().encode(s));
const reject = (action: () => unknown) => expect(action).toThrow();
const count = (db: Db, where = "1=1", ...args: unknown[]): number =>
  (db.prepare(`SELECT count(*) AS n FROM question_requests WHERE ${where}`).get(...args) as { n: number }).n;
const snapshot = (db: Db) => db.prepare("SELECT * FROM question_requests ORDER BY request_id").all();

function fresh(): Db {
  const db: Db = new DatabaseSync(":memory:");
  for (const name of prior) db.exec(sqlOf(name));
  db.exec(sqlOf(migration));
  return db;
}
/** Historical fixtures only: lift the 300-second clock bound on insert. */
const allowBackdatedInserts = (db: Db) => db.exec("DROP TRIGGER question_requests_clock_insert");

const insertSql = `INSERT INTO question_requests
  (request_id, account_sub, text, locale, text_hash, status, created_at, updated_at, expires_at)
  VALUES ($request_id, $account_sub, $text, $locale, $text_hash, $status, $created_at, $updated_at, $expires_at)`;
const row = (over: Row = {}, created = base): Row => ({
  request_id: hex("a"), account_sub: "access-sub-1", text: "How many goals did United score in 2023-24?",
  locale: "en", text_hash: hex("b"), status: "received", created_at: created, updated_at: created,
  expires_at: days(created, 90), ...over,
});
const insert = (db: Db, over: Row = {}, created = base) =>
  db.prepare(insertSql).run(row(over, created)) as { changes: number | bigint };

/** Every update bumps revision by one, as the compare-and-set writers do. */
function update(db: Db, id: string, set: string, ...args: unknown[]) {
  db.prepare(`UPDATE question_requests SET ${set}, revision = revision + 1 WHERE request_id = ?`).run(...args, id);
}
function claim(db: Db, id = hex("a"), lease = "lease:1", when = claimedAt, owner = "runner:a", ttl = 900) {
  update(db, id, "status='triaging', attempt=attempt+1, claimed_at=?, lease_id=?, lease_owner=?, lease_expires_at=?, retry_after=NULL, updated_at=?",
    when, lease, owner, at(when, ttl), when);
}
function retry(db: Db, id = hex("a"), backoff = 30) {
  update(db, id, "status='received', lease_expires_at=NULL, retry_after=strftime('%Y-%m-%dT%H:%M:%SZ', claimed_at, ?), updated_at=claimed_at",
    `+${backoff} seconds`);
}
const verdict = (over: Record<string, unknown> = {}, id = hex("a")) => JSON.stringify({
  version: 1, request_id: id, relevant: true, junk_reason: null,
  restated_question: "Compare goals and assists in the Premier League for 2022-23 and 2023-24.",
  tables: [{ fields: ["goals", "assists"], filters: { season: ["2022-23", "2023-24"], competition: ["PL"], opponent_id: [], person_id: ["person-0001"] } }],
  visuals: [{ kind: "bar", table_index: 0 }, { kind: "table", table_index: 0 }],
  field_status: [{ field: "goals", status: "available" }, { field: "assists", status: "missing" }],
  families: [], ...over,
});
const junk = (id = hex("a")) => verdict({ relevant: false, junk_reason: "prompt_injection", restated_question: "",
  tables: [], visuals: [], field_status: [], families: [] }, id);
function ack(db: Db, status: string, json: string, id = hex("a")) {
  update(db, id, "status=?, verdict_json=?, lease_expires_at=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ', claimed_at, '+30 seconds')",
    status, json);
}
// Invisible or reordering characters rejected in text and restated_question (beyond Cc).
const formatChars = ["­", "؜", "᠎", "​", "‍", "‏", " ", " ", "‪", "‮",
  "⁠", "⁦", "⁩", "⁯", "﻿", "￹", "￻", "\u{e0001}", "\u{e007f}"];

describe("question_requests migration (0010)", () => {
  it("applies on a fresh schema from all prior migrations and re-applies without change", () => {
    const db = fresh();
    try {
      insert(db);
      claim(db);
      ack(db, "triaged", verdict());
      const dump = () => ({
        schema: db.prepare(`SELECT type, name, sql FROM sqlite_master
          WHERE name LIKE '%question_requests%' AND name NOT LIKE 'sqlite_%' ORDER BY type, name`).all(),
        rows: snapshot(db),
      });
      const once = dump();
      expect((once.schema as unknown[]).length).toBe(11); // table, 3 indexes, 7 triggers
      db.exec(sqlOf(migration));
      expect(dump()).toEqual(once);
    } finally { db.close(); }
  });

  it("round-trips SQL and HTML payload text byte-identical as data (test_inserts_html_and_sql_payloads_round_trip_byte_identical)", () => {
    const db = fresh();
    try {
      const payloads = [
        "'); DROP TABLE question_requests; --",
        "\" OR 1=1; SELECT * FROM exploration_request_links WHERE '' = '",
        "<script>alert(1)</script><img src=x onerror=\"alert('x')\">",
        "Robert'); DELETE FROM question_requests WHERE 1=1; -- ¿Cuántos goles? é ü 😀 \\ % _ ` $1 {x}",
      ];
      payloads.forEach((text, i) => insert(db, { request_id: idOf(i + 1), text_hash: idOf(i + 1), text }));
      payloads.forEach((text, i) => {
        const back = (db.prepare("SELECT text FROM question_requests WHERE request_id = ?").get(idOf(i + 1)) as { text: string }).text;
        expect(back).toBe(text);
        expect(bytes(back)).toEqual(bytes(text));
      });
      expect(count(db)).toBe(payloads.length);
      expect(db.prepare("SELECT count(*) AS n FROM exploration_request_links").get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });

  it("rejects control characters, over 500 chars and bad locale (rejects_control_chars_over_500_and_bad_locale)", () => {
    const db = fresh();
    try {
      insert(db, { text: "x".repeat(500) });
      insert(db, { request_id: hex("c"), text_hash: hex("c"), text: "😀".repeat(500), locale: "es" });
      const bad: Row[] = [
        { text: "x".repeat(501) }, { text: "" }, { text: "a\nb" }, { text: "a\tb" }, { text: "a\u0000b" },
        { text: "a\u001fb" }, { text: "a\u007fb" }, { text: "a\u0085b" }, { text: "a\u009fb" },
        ...formatChars.map((c) => ({ text: `a${c}b` })),
        { locale: "fr" }, { locale: "EN" }, { locale: "" }, { locale: null },
        { request_id: hex("A") }, { request_id: "a".repeat(63) }, { request_id: null }, { text_hash: "z".repeat(64) },
        { account_sub: "" }, { account_sub: "x".repeat(513) }, { account_sub: "a\u0001b" }, { account_sub: "a​b" },
        { status: "triaging" }, { created_at: base.replace("Z", "+00:00") }, { expires_at: days(base, 91) },
        { updated_at: at(base, -1) }, { updated_at: at(base, 5) },
        { created_at: "2026-13-45T10:00:00Z", updated_at: "2026-13-45T10:00:00Z", expires_at: "2027-01-13T10:00:00Z" },
        { expires_at: "garbage-garbage-garb" },
      ];
      for (const [i, over] of bad.entries()) {
        expect(() => insert(db, { request_id: idOf(i + 1), text_hash: idOf(i + 1), ...over }), `case ${i}`).toThrow();
      }
      // A BLOB keeps its storage class under TEXT affinity, so typeof(text) = 'text' rejects it.
      reject(() => insert(db, { request_id: hex("e"), text_hash: hex("e"), text: new TextEncoder().encode("hi") }));
      // Intake cannot pre-set the compare-and-set revision.
      reject(() => db.prepare(insertSql.replace("expires_at)", "expires_at, revision)").replace("$expires_at)", "$expires_at, 2)"))
        .run(row({ request_id: hex("e"), text_hash: hex("e") })));
      expect(count(db)).toBe(2);
    } finally { db.close(); }
  });

  it("bounds written timestamps to 300 seconds of the database clock", () => {
    const db = fresh();
    try {
      reject(() => insert(db, {}, at(now, -400)));
      reject(() => insert(db, {}, at(now, 400)));
      insert(db);
      reject(() => claim(db, hex("a"), "lease:1", at(now, 400)));
      reject(() => update(db, hex("a"), "updated_at=?", at(now, 400))); // not a transition, but the clock trigger fires first
      claim(db);
      reject(() => update(db, hex("a"), "status='received', lease_expires_at=NULL, retry_after=?, updated_at=?",
        at(claimedAt, 30), at(now, -400)));
      expect(snapshot(db)).toMatchObject([{ status: "triaging", revision: 2 }]);
    } finally { db.close(); }
  });

  it("ignores duplicates per account, text hash and UTC day", () => {
    const db = fresh();
    try {
      expect(insert(db).changes).toBe(1);
      expect(insert(db, { request_id: hex("c") }, at(base, 1)).changes).toBe(0);
      expect(insert(db, { request_id: hex("c"), account_sub: "access-sub-2" }).changes).toBe(1);
      allowBackdatedInserts(db);
      expect(insert(db, { request_id: hex("d") }, days(base, 1)).changes).toBe(1);
      expect(count(db)).toBe(3);
    } finally { db.close(); }
  });

  it("REPLACE and INSERT OR REPLACE never reset a settled row", () => {
    const db = fresh();
    try {
      insert(db);
      claim(db);
      ack(db, "junk", junk());
      const before = snapshot(db);
      expect(before).toMatchObject([{ status: "junk", attempt: 1, revision: 3 }]);
      db.prepare(insertSql.replace("INSERT INTO", "REPLACE INTO")).run(row());
      db.prepare(insertSql.replace("INSERT INTO", "INSERT OR REPLACE INTO")).run(row({ request_id: hex("c") }));
      db.prepare(`${insertSql} ON CONFLICT DO NOTHING`).run(row());
      expect(snapshot(db)).toEqual(before);
    } finally { db.close(); }
  });

  it("walks every allowed transition", () => {
    const db = fresh();
    try {
      // received -> triaging -> received (backoff) -> triaging -> triaged -> queued -> partial
      insert(db);
      claim(db);
      retry(db);
      claim(db, hex("a"), "lease:2", at(claimedAt, 30));
      update(db, hex("a"), "status='triaged', verdict_json=?, lease_expires_at=NULL", verdict());
      update(db, hex("a"), "status='queued', exploration_request_id=?", hex("f"));
      update(db, hex("a"), "status='partial'");
      expect(db.prepare("SELECT status, attempt, revision, lease_id FROM question_requests").get())
        .toEqual({ status: "partial", attempt: 2, revision: 7, lease_id: "lease:2" });
      // triaging -> junk; triaged -> no_data; three failed attempts -> triage_failed
      insert(db, { request_id: hex("b"), text_hash: hex("1") });
      claim(db, hex("b"));
      ack(db, "junk", junk(hex("b")), hex("b"));
      insert(db, { request_id: hex("c"), text_hash: hex("2") });
      claim(db, hex("c"));
      ack(db, "triaged", verdict({}, hex("c")), hex("c"));
      update(db, hex("c"), "status='no_data'");
      insert(db, { request_id: hex("d"), text_hash: hex("3") });
      claim(db, hex("d"), "lease:1", claimedAt);
      retry(db, hex("d"));
      claim(db, hex("d"), "lease:2", at(claimedAt, 40));
      retry(db, hex("d"));
      claim(db, hex("d"), "lease:3", at(claimedAt, 80));
      update(db, hex("d"), "status='triage_failed', lease_expires_at=NULL");
      expect(db.prepare("SELECT status FROM question_requests ORDER BY request_id").all())
        .toEqual([{ status: "partial" }, { status: "junk" }, { status: "no_data" }, { status: "triage_failed" }]);
    } finally { db.close(); }
  });

  it("rejects bad status transitions, stale fences and identity changes (rejects_bad_status_transitions)", () => {
    const db = fresh();
    try {
      insert(db);
      for (const status of ["triaged", "junk", "queued", "filled", "partial", "no_data", "triage_failed"]) {
        reject(() => update(db, hex("a"), "status=?", status));
      }
      reject(() => update(db, hex("a"), "text='edited'"));
      reject(() => update(db, hex("a"), "account_sub='other'"));
      reject(() => db.prepare(`UPDATE question_requests SET status='triaging', attempt=1, claimed_at=?, lease_id='l', lease_owner='o',
        lease_expires_at=? WHERE request_id=?`).run(claimedAt, at(claimedAt, 900), hex("a"))); // revision not raised
      reject(() => update(db, hex("a"), "status='triaging', attempt=2, claimed_at=?, lease_id='l', lease_owner='o', lease_expires_at=?",
        claimedAt, at(claimedAt, 900)));
      claim(db);
      reject(() => update(db, hex("a"), "lease_id='lease:stolen', status='received', lease_expires_at=NULL, retry_after=?", at(claimedAt, 300)));
      reject(() => update(db, hex("a"), "status='queued', verdict_json=?, lease_expires_at=NULL, exploration_request_id=?", verdict(), hex("f")));
      reject(() => update(db, hex("a"), "status='triaged', verdict_json=NULL, lease_expires_at=NULL"));
      reject(() => update(db, hex("a"), "status='junk', verdict_json=?, lease_expires_at=NULL", verdict()));
      reject(() => update(db, hex("a"), "status='triaged', verdict_json=?, lease_expires_at=NULL", junk()));
      reject(() => update(db, hex("a"), "status='triage_failed', lease_expires_at=NULL")); // attempt 1 of 3
      retry(db);
      // Claim before the backoff is due, or reusing the previous lease ID.
      reject(() => claim(db, hex("a"), "lease:2", at(claimedAt, 29)));
      reject(() => claim(db, hex("a"), "lease:1", at(claimedAt, 30)));
      claim(db, hex("a"), "lease:2", at(claimedAt, 30));
      ack(db, "triaged", verdict());
      reject(() => update(db, hex("a"), "verdict_json=?", junk()));
      reject(() => update(db, hex("a"), "status='queued'")); // queued needs exploration_request_id
      reject(() => update(db, hex("a"), "status='received', verdict_json=NULL"));
      reject(() => update(db, hex("a"), "status='filled', verdict_json=?", verdict({ restated_question: "Other." })));
      update(db, hex("a"), "status='queued', exploration_request_id=?", hex("f"));
      reject(() => update(db, hex("a"), "status='filled', exploration_request_id=?", hex("e")));
      update(db, hex("a"), "status='filled'");
      for (const status of ["received", "triaging", "queued", "partial"]) reject(() => update(db, hex("a"), "status=?", status));
      expect(db.prepare("SELECT status, revision FROM question_requests").get()).toEqual({ status: "filled", revision: 7 });
    } finally { db.close(); }
  });

  it("rejects NULL leases, over-long leases, bad lease owners and invalid dates", () => {
    const db = fresh();
    try {
      insert(db);
      // A NULL lease expiry makes the comparisons NULL, which a bare CHECK or WHEN would let through.
      reject(() => update(db, hex("a"), `status='triaging', attempt=1, claimed_at=?, lease_id='lease:1', lease_owner='runner:a',
        lease_expires_at=NULL, retry_after=NULL, updated_at=?`, claimedAt, claimedAt));
      reject(() => claim(db, hex("a"), "lease:1", claimedAt, "runner:a", 901));
      reject(() => claim(db, hex("a"), "lease:1", claimedAt, "Runner A"));
      claim(db);
      // retry_after is ordered after claimed_at and within a day, but is not a real time: only the format check catches it.
      const invalid = `${claimedAt.slice(0, 17)}99Z`;
      reject(() => update(db, hex("a"), "status='received', lease_expires_at=NULL, retry_after=?, updated_at=claimed_at", invalid));
      retry(db);
      expect(snapshot(db)).toMatchObject([{ status: "received", attempt: 1, revision: 3, lease_owner: "runner:a" }]);
    } finally { db.close(); }
  });

  it("rejects malformed, foreign, open-shaped or oversized verdict_json", () => {
    const tableWith = (over: Record<string, unknown>) =>
      verdict({ tables: [{ fields: ["goals"], filters: { season: [], competition: [], opponent_id: [], person_id: [] }, ...over }] });
    const filtersWith = (over: Record<string, unknown>) =>
      tableWith({ filters: { season: [], competition: [], opponent_id: [], person_id: [], ...over } });
    const bad = [
      "not json", "[]", "{\"version\":1", "null",
      verdict({ version: 2 }), verdict({}, hex("e")), verdict({ extra: true }),
      verdict().replace(",\"families\":[]", ""), // missing key
      verdict({ relevant: "yes" }), verdict({ junk_reason: "other" }), verdict({ junk_reason: "off_topic" }),
      verdict({ relevant: false, junk_reason: "off_topic" }), // relevant=false with tables present
      verdict({ restated_question: "x".repeat(301) }), verdict({ restated_question: "<b>hi</b>" }),
      verdict({ restated_question: "run `x`" }), verdict({ restated_question: "a\nb" }), verdict({ restated_question: 7 }),
      ...formatChars.map((c) => verdict({ restated_question: `a${c}b` })),
      tableWith({ fields: [] }), tableWith({ fields: ["Goals"] }), tableWith({ x: 1 }),
      filtersWith({ season: ["2023/24"] }), filtersWith({ competition: ["pl"] }), filtersWith({ opponent_id: ["../x"] }),
      filtersWith({ sql: [] }),
      verdict({ visuals: [{ kind: "pie", table_index: 0 }] }), verdict({ visuals: [{ kind: "bar", table_index: 1 }] }),
      verdict({ visuals: [{ kind: "bar", table_index: 0.5 }] }),
      verdict({ field_status: [{ field: "goals", status: "done" }] }), verdict({ families: ["shell"] }),
      verdict({ families: ["arrival_manager", "arrival_manager"] }),
      // Valid shape padded with JSON whitespace past the 10240-byte cap.
      "{" + " ".repeat(10240) + verdict().slice(1),
    ];
    const db = fresh();
    try {
      insert(db);
      claim(db);
      expect(verdict().startsWith("{")).toBe(true);
      const padded = "{" + " ".repeat(10240 - bytes(verdict()).length) + verdict().slice(1);
      expect(bytes(padded).length).toBe(10240);
      for (const [i, json] of bad.entries()) {
        for (const status of ["triaged", "junk"]) expect(() => ack(db, status, json), `case ${i} as ${status}`).toThrow();
      }
      ack(db, "triaged", padded);
      expect(count(db, "status='triaged'")).toBe(1);
    } finally { db.close(); }
  });

  it("purges only expired rows with the documented PURGE statement", () => {
    const block = sqlOf(migration).split("-- PURGE-BEGIN\n")[1]!.split("-- PURGE-END")[0]!;
    const statements = block.split("\n").filter(Boolean).map((line) => line.replace(/^-- /, ""));
    expect(statements).toHaveLength(1);
    const db = fresh();
    try {
      db.prepare("INSERT INTO exploration_shared_requests (request_id, contract_version, request_json, created_at) VALUES (?, 1, ?, ?)")
        .run(hex("f"), JSON.stringify({ version: 1, family: "arrival_manager", as_of: now.slice(0, 10),
          population: "first_team_available", joining_basis: "effective_first_team_spell_entry",
          academy_basis: "documented_first_team_promotion", visualization: "table" }), now);
      allowBackdatedInserts(db);
      insert(db, { request_id: hex("1"), text_hash: hex("1") }, days(now, -91));
      insert(db, { request_id: hex("2"), text_hash: hex("2") }, days(now, -89));
      insert(db, { request_id: hex("3"), text_hash: hex("3") });
      for (const sql of statements) db.exec(sql);
      expect(db.prepare("SELECT request_id FROM question_requests ORDER BY request_id").all())
        .toEqual([{ request_id: hex("2") }, { request_id: hex("3") }]);
      expect(db.prepare("SELECT count(*) AS n FROM exploration_shared_requests").get()).toEqual({ n: 1 });
    } finally { db.close(); }
  });
});
