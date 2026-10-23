import { describe, expect, it } from "vitest";
// @ts-expect-error Node's built-in module is available in the configured test runtime.
import { readFileSync } from "node:fs";
// @ts-expect-error Node's built-in SQLite module is available in the configured test runtime.
import { DatabaseSync } from "node:sqlite";

type Db = InstanceType<typeof DatabaseSync>;
const base = ["0001_schema.sql", "0003_p16_dot_plot.sql", "0004_cache_slots.sql",
  "0005_account_question_history.sql", "0006_season_splits.sql"];
const sqlOf = (name: string): string => readFileSync(`infra/migrations/${name}`, "utf8");
const link = "0008_exploration_request_links.sql";
const sharedTables = ["exploration_shared_requests", "exploration_shared_results", "exploration_shared_result_groups",
  "exploration_shared_jobs", "exploration_shared_job_tombstones", "exploration_bridge_operations"];

// Timestamps. Past values are always expired; 2099 values are always live.
const now = "2026-10-20T00:00:00Z";
const plus = (iso: string, days: number) => new Date(Date.parse(iso) + days * 86_400_000).toISOString().replace(".000Z", "Z");
const past = "2020-01-01T00:00:00Z";
const future = "2099-01-01T00:00:00Z";
const rid = (c: string) => c.repeat(64);
const request = JSON.stringify({ version: 1, family: "arrival_manager", as_of: "2026-10-20",
  population: "first_team_available", joining_basis: "effective_first_team_spell_entry",
  academy_basis: "documented_first_team_promotion", visualization: "table" });
const publication = JSON.stringify({ artifact_key: rid("c"), request_id: rid("a"), validation_record_id: "validation:v1",
  publication_id: "publication:v1", loaded_snapshot_id: "snapshot:one", coverage_record_id: "coverage:v1",
  loaded_at: now, lineage: ["source:fpl"] });
const assigned = '[{"member_id":"member:1","person_id":"person:1","spell_id":"spell:1","manager_id":"manager:1","event_id":"event:1","tenure_id":"tenure:1","lineage":["source:fpl"]}]';
const reject = (action: () => unknown) => expect(action).toThrow();
const count = (db: Db, table: string, where = "1=1", ...args: unknown[]): number =>
  (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(...args) as { n: number }).n;

/** Foreign keys are enforced, as on D1. 0007 is deliberately not part of the sequence. */
function fresh(): Db {
  const db: Db = new DatabaseSync(":memory:");
  for (const name of base) db.exec(sqlOf(name));
  db.exec(sqlOf(link));
  return db;
}
function addRequest(db: Db, id: string, accounts: string[], at = now) {
  db.prepare("INSERT INTO exploration_shared_requests (request_id, contract_version, request_json, created_at) VALUES (?, 1, ?, ?)")
    .run(id, request, at);
  for (const account of accounts) addLink(db, id, account, at);
}
function addLink(db: Db, id: string, account: string, at = now) {
  db.prepare("INSERT INTO exploration_request_links (request_id, account_sub, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(id, account, at, plus(at, 90));
}
function addJob(db: Db, jobId: string, requestId: string, admitted = now) {
  db.prepare(`INSERT INTO exploration_shared_jobs (job_id, request_id, status, attempt, admitted_at, created_at, updated_at, expires_at)
    VALUES (?, ?, 'queued', 0, ?, ?, ?, ?)`).run(jobId, requestId, admitted, admitted, admitted, plus(admitted, 30));
}
/** Every update bumps the revision, as the BridgeStore compare-and-set does. */
function setJob(db: Db, jobId: string, set: string, ...args: unknown[]) {
  db.prepare(`UPDATE exploration_shared_jobs SET ${set}, revision = revision + 1 WHERE job_id = ?`).run(...args, jobId);
}
function claim(db: Db, jobId: string, claimedAt = future, lease = "2099-01-01T00:15:00Z", owner = "runner:a") {
  setJob(db, jobId, "status='running', attempt=attempt+1, claimed_at=?, lease_id='lease:1', lease_owner=?, lease_expires_at=?",
    claimedAt, owner, lease);
}
function addResult(db: Db, id: string) {
  db.prepare(`INSERT INTO exploration_shared_results
    (request_id, snapshot_id, artifact_key, transform_code_version, renderer_version, roster_snapshot_id,
     feasibility, coverage, population_count, assigned_json, unknown_json, lineage_json, created_at, expires_at)
    VALUES (?, 'snapshot:one', ?, 'transform:v1', 'renderer:v1', 'roster:one', 'available', 'complete', 1, ?, '[]', '["source:fpl"]', ?, ?)`)
    .run(id, rid("d"), assigned, now, plus(now, 30));
  db.prepare(`INSERT INTO exploration_shared_result_groups (request_id, manager_id, member_count, members_json, lineage_json)
    VALUES (?, 'manager:1', 1, ?, '["source:fpl"]')`).run(id, assigned);
}
const operation = (db: Db, operationId: string, at = now) => db.prepare(`INSERT INTO exploration_bridge_operations
  (scope_key, operation_type, operation_id, body_hash, response_json, lease_id, created_at, expires_at)
  VALUES ('bridge:v1', 'claim', ?, ?, '{"version":1,"kind":"claim_result","payload":{"outcome":"claimed"}}', 'lease:1', ?, ?)`)
  .run(operationId, rid("e"), at, plus(at, 30));
function dump(db: Db): unknown {
  const schema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  const rows = Object.fromEntries([...sharedTables, "exploration_request_links"].map((table) =>
    [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all()]));
  return { schema, rows };
}
/** The collector statements, taken verbatim from the migration's documented block. */
function collector(): string[] {
  const block = sqlOf(link).split("-- COLLECTOR-BEGIN\n")[1]!.split("-- COLLECTOR-END")[0]!;
  const statements = block.split("\n").filter(Boolean).map((line) => line.replace(/^-- /, ""));
  expect(statements).toHaveLength(3);
  return statements;
}

describe("account-neutral exploration storage (0008)", () => {
  it("re-applies without changing schema or rows, from clean and legacy 0007 databases", () => {
    const db = fresh();
    try {
      addRequest(db, rid("a"), ["account-a", "account-b"]);
      addJob(db, rid("b"), rid("a"));
      claim(db, rid("b"));
      addResult(db, rid("a"));
      operation(db, "op:1");
      addRequest(db, rid("1"), ["account-a"]);
      addJob(db, rid("2"), rid("1"));
      db.prepare("DELETE FROM exploration_request_links WHERE request_id = ?").run(rid("1"));
      expect(count(db, "exploration_shared_job_tombstones")).toBe(1);
      const once = dump(db);
      db.exec(sqlOf(link));
      db.exec(sqlOf(link));
      expect(dump(db)).toEqual(once);
    } finally { db.close(); }

    const legacy: Db = new DatabaseSync(":memory:");
    try {
      for (const name of base) legacy.exec(sqlOf(name));
      legacy.exec(sqlOf("0007_exploration_requests.sql"));
      legacy.prepare(`INSERT INTO exploration_requests (request_id, account_sub, contract_version, request_json, created_at, expires_at)
        VALUES (?, 'account-a', 1, ?, ?, ?)`).run(rid("a"), request, now, plus(now, 90));
      legacy.exec(sqlOf(link));
      const names = (legacy.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'exploration_%' OR name LIKE 'idx_exploration_%'")
        .all() as { name: string }[]).map((row) => row.name);
      for (const gone of ["exploration_requests", "exploration_results", "exploration_result_groups", "exploration_jobs",
        "exploration_job_tombstones", "exploration_job_idempotency", "exploration_request_accounts"]) {
        expect(names).not.toContain(gone);
      }
      expect(names.filter((name) => /^(idx_)?exploration_(requests|results|jobs|idempotency|request_accounts)_/.test(name))).toEqual([]);
      for (const table of sharedTables) expect(names).toContain(table);
      const once = dump(legacy);
      legacy.exec(sqlOf(link));
      expect(dump(legacy)).toEqual(once);
    } finally { legacy.close(); }
  });

  it("keeps account identity out of every shared table, trigger and view", () => {
    const db = fresh();
    try {
      for (const table of sharedTables) {
        const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
        expect(columns.filter((name) => /account|owner_sub|\bsub\b/.test(name)), table).toEqual([]);
      }
      expect((db.prepare("PRAGMA table_info(exploration_request_links)").all() as { name: string }[]).map((c) => c.name))
        .toContain("account_sub");
      const objects = db.prepare(`SELECT name, sql FROM sqlite_master WHERE name LIKE '%exploration%' AND sql IS NOT NULL
        AND name NOT LIKE '%request_links%'`).all() as { name: string; sql: string }[];
      for (const object of objects) expect(object.sql, object.name).not.toMatch(/account_sub/);
    } finally { db.close(); }
  });

  it("shares one request between two accounts and keeps it when one account is removed", () => {
    const db = fresh();
    try {
      addRequest(db, rid("a"), ["account-a"], now);
      addLink(db, rid("a"), "account-b", "2026-10-25T00:00:00Z");
      addJob(db, rid("b"), rid("a"));
      claim(db, rid("b"));
      addResult(db, rid("a"));
      expect(count(db, "exploration_shared_requests")).toBe(1);
      expect(db.prepare("SELECT account_sub, created_at, expires_at FROM exploration_request_links ORDER BY account_sub").all())
        .toEqual([
          { account_sub: "account-a", created_at: now, expires_at: plus(now, 90) },
          { account_sub: "account-b", created_at: "2026-10-25T00:00:00Z", expires_at: plus("2026-10-25T00:00:00Z", 90) },
        ]);
      // Account deletion / unlink removes only that account's links.
      db.prepare("DELETE FROM exploration_request_links WHERE account_sub = 'account-a'").run();
      expect(db.prepare("SELECT account_sub FROM exploration_request_links").all()).toEqual([{ account_sub: "account-b" }]);
      expect(count(db, "exploration_shared_requests")).toBe(1);
      expect(db.prepare("SELECT status, lease_id, lease_owner FROM exploration_shared_jobs").all())
        .toEqual([{ status: "running", lease_id: "lease:1", lease_owner: "runner:a" }]);
      expect(count(db, "exploration_shared_results")).toBe(1);
      expect(count(db, "exploration_shared_result_groups")).toBe(1);
      expect(count(db, "exploration_shared_job_tombstones")).toBe(0);
      // The remaining account is unaffected by re-linking and unlinking the first.
      addLink(db, rid("a"), "account-a", "2026-10-26T00:00:00Z");
      db.prepare("DELETE FROM exploration_request_links WHERE account_sub = 'account-a'").run();
      expect(db.prepare("SELECT account_sub, created_at FROM exploration_request_links").all())
        .toEqual([{ account_sub: "account-b", created_at: "2026-10-25T00:00:00Z" }]);
      expect(count(db, "exploration_shared_requests")).toBe(1);
    } finally { db.close(); }
  });

  it("collects shared rows only after the last link and never under a live lease", () => {
    const db = fresh();
    try {
      // Live lease: the last unlink leaves the request until the lease is released.
      addRequest(db, rid("a"), ["account-a", "account-b"]);
      addJob(db, rid("b"), rid("a"));
      claim(db, rid("b"));
      addResult(db, rid("a"));
      operation(db, "op:1");
      db.prepare("DELETE FROM exploration_request_links WHERE account_sub = 'account-a'").run();
      expect(count(db, "exploration_shared_requests")).toBe(1);
      db.prepare("DELETE FROM exploration_request_links WHERE account_sub = 'account-b'").run();
      expect(count(db, "exploration_request_links")).toBe(0);
      expect(count(db, "exploration_shared_requests")).toBe(1);
      const [, sweep] = collector();
      db.exec(sweep!);
      expect(count(db, "exploration_shared_requests")).toBe(1);
      expect(db.prepare("SELECT request_id FROM exploration_collectable_requests").all()).toEqual([]);
      // Releasing the lease makes the orphan collectable by the sweep statement.
      setJob(db, rid("b"), "status='failed', lease_id=NULL, lease_owner=NULL, lease_expires_at=NULL, failure='source_unavailable', retry_after=?",
        "2099-01-01T00:05:00Z");
      expect(db.prepare("SELECT request_id FROM exploration_collectable_requests").all()).toEqual([{ request_id: rid("a") }]);
      db.exec(sweep!);
      for (const table of ["exploration_shared_requests", "exploration_shared_jobs", "exploration_shared_results",
        "exploration_shared_result_groups"]) expect(count(db, table), table).toBe(0);
      expect(db.prepare("SELECT job_id, request_id FROM exploration_shared_job_tombstones").all())
        .toEqual([{ job_id: rid("b"), request_id: rid("a") }]);
      // Replay records are independent of request lifetime.
      expect(count(db, "exploration_bridge_operations")).toBe(1);

      // Expired lease on the last unlink: collected immediately by the trigger.
      addRequest(db, rid("3"), ["account-c"]);
      addJob(db, rid("4"), rid("3"), past);
      claim(db, rid("4"), past, "2020-01-01T00:15:00Z");
      db.prepare("DELETE FROM exploration_request_links WHERE account_sub = 'account-c'").run();
      expect(count(db, "exploration_shared_requests")).toBe(0);

      // A shared request with a remaining link is never collected, even if swept.
      addRequest(db, rid("5"), ["account-a", "account-b"]);
      db.prepare("DELETE FROM exploration_request_links WHERE account_sub = 'account-a'").run();
      for (const statement of collector()) db.exec(statement);
      expect(count(db, "exploration_shared_requests")).toBe(1);
      expect(count(db, "exploration_request_links")).toBe(1);
    } finally { db.close(); }
  });

  it("runs the documented collector: expired link purge, bounded orphan sweep, tombstone purge", () => {
    const db = fresh();
    try {
      const [purge, sweep, tombstones] = collector();
      // Account A's link is past retention; B's is live. Request survives via B.
      addRequest(db, rid("a"), ["account-a"], past);
      addLink(db, rid("a"), "account-b", future);
      // Request with only an expired link is collected by the purge trigger.
      addRequest(db, rid("1"), ["account-a"], past);
      addJob(db, rid("2"), rid("1"));
      db.exec(purge!);
      expect(db.prepare("SELECT request_id, account_sub FROM exploration_request_links").all())
        .toEqual([{ request_id: rid("a"), account_sub: "account-b" }]);
      expect(db.prepare("SELECT request_id FROM exploration_shared_requests").all()).toEqual([{ request_id: rid("a") }]);
      expect(count(db, "exploration_shared_jobs")).toBe(0);

      // The sweep is bounded to 100 per run.
      for (let i = 0; i < 101; i++) {
        db.prepare("INSERT INTO exploration_shared_requests (request_id, contract_version, request_json, created_at) VALUES (?, 1, ?, ?)")
          .run(i.toString(16).padStart(64, "0"), request, now);
      }
      db.exec(sweep!);
      expect(count(db, "exploration_shared_requests")).toBe(2);
      db.exec(sweep!);
      expect(count(db, "exploration_shared_requests")).toBe(1);

      // Tombstones are retained for 30 days, then purged.
      expect(count(db, "exploration_shared_job_tombstones")).toBe(1);
      reject(() => db.prepare("DELETE FROM exploration_shared_job_tombstones").run());
      db.exec(tombstones!);
      expect(count(db, "exploration_shared_job_tombstones")).toBe(1);
      db.prepare("UPDATE exploration_shared_job_tombstones SET deleted_at = ?").run(past);
      db.exec(tombstones!);
      expect(count(db, "exploration_shared_job_tombstones")).toBe(0);
    } finally { db.close(); }
  });

  it("blocks reinsertion of a collected job for 30 days and allows it afterwards", () => {
    const db = fresh();
    try {
      addRequest(db, rid("a"), ["account-a"]);
      addJob(db, rid("b"), rid("a"));
      db.prepare("DELETE FROM exploration_request_links").run();
      expect(count(db, "exploration_shared_requests")).toBe(0);
      addRequest(db, rid("a"), ["account-b"]);
      reject(() => addJob(db, rid("b"), rid("a")));
      reject(() => addJob(db, rid("9"), rid("a")));
      addRequest(db, rid("8"), ["account-b"]);
      reject(() => addJob(db, rid("b"), rid("8")));
      db.prepare("UPDATE exploration_shared_job_tombstones SET deleted_at = ?").run(past);
      addJob(db, rid("b"), rid("a"));
      expect(count(db, "exploration_shared_jobs")).toBe(1);
    } finally { db.close(); }
  });

  it("enforces the job state machine, lease guards, fencing and publication shape", () => {
    const db = fresh();
    try {
      addRequest(db, rid("a"), ["account-a"]);
      addJob(db, rid("b"), rid("a"));
      // Initial insert rules and one job per request.
      addRequest(db, rid("7"), ["account-a"]);
      reject(() => addJob(db, rid("b"), rid("7")));
      reject(() => addJob(db, rid("6"), rid("a")));
      const initial = (over: Record<string, unknown>) => {
        const row = { job_id: rid("5"), request_id: rid("7"), status: "queued", attempt: 0, admitted_at: now, created_at: now,
          updated_at: now, expires_at: plus(now, 30), ...over };
        const keys = Object.keys(row);
        db.prepare(`INSERT INTO exploration_shared_jobs (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
          .run(...(Object.values(row) as never[]));
      };
      for (const over of [{ status: "running" }, { attempt: 1 }, { lease_id: "lease:x" }, { lease_owner: "runner:a" },
        { failure: "source_unavailable" }, { publication_json: publication }, { retry_after: "2026-10-21T00:00:00Z" },
        { claimed_at: now }, { lease_expires_at: future }, { expires_at: now }]) reject(() => initial(over));
      initial({});
      for (const column of ["lease_id = 'x'", "lease_owner = 'x'", "failure = 'no_data'", "publication_json = '{}'"]) {
        reject(() => db.prepare(`UPDATE exploration_shared_jobs SET ${column}, revision = revision + 1 WHERE job_id = ?`).run(rid("5")));
      }
      // Fencing: no update may leave the revision unchanged or lower it.
      reject(() => db.prepare("UPDATE exploration_shared_jobs SET updated_at = ? WHERE job_id = ?").run(now, rid("b")));
      reject(() => db.prepare("UPDATE exploration_shared_jobs SET status='running', attempt=1, claimed_at=?, lease_id='lease:1', lease_expires_at=? WHERE job_id = ?")
        .run(future, "2099-01-01T00:15:00Z", rid("b")));
      // Claim: queued -> running only, with a lease that outlives the claim.
      reject(() => setJob(db, rid("b"), "status='published', attempt=1, publication_json=?", publication));
      reject(() => claim(db, rid("b"), future, future));
      claim(db, rid("b"));
      expect(db.prepare("SELECT status, attempt, revision FROM exploration_shared_jobs WHERE job_id = ?").get(rid("b")))
        .toEqual({ status: "running", attempt: 1, revision: 2 });
      // A running job cannot be re-claimed, renewed, or reset to queued.
      reject(() => claim(db, rid("b")));
      reject(() => setJob(db, rid("b"), "lease_expires_at='2099-02-01T00:00:00Z'"));
      reject(() => setJob(db, rid("b"), "status='queued', lease_id=NULL, lease_owner=NULL, lease_expires_at=NULL"));
      // Publication: shape-checked and the owner survives, the lease clears.
      reject(() => setJob(db, rid("b"), "status='published', lease_id=NULL, lease_expires_at=NULL, publication_json=?",
        JSON.stringify({ ...JSON.parse(publication), question_text: "raw" })));
      reject(() => setJob(db, rid("b"), "status='published', lease_id=NULL, lease_owner=NULL, lease_expires_at=NULL, publication_json=?", publication));
      reject(() => setJob(db, rid("b"), "status='published', lease_id=NULL, lease_expires_at=NULL, publication_json=NULL"));
      setJob(db, rid("b"), "status='published', lease_id=NULL, lease_expires_at=NULL, publication_json=?", publication);
      expect(db.prepare("SELECT lease_owner FROM exploration_shared_jobs WHERE job_id = ?").get(rid("b"))).toEqual({ lease_owner: "runner:a" });
      for (const to of ["queued", "running", "failed"]) {
        reject(() => setJob(db, rid("b"), `status='${to}'`));
      }
      reject(() => setJob(db, rid("b"), "publication_json=?", JSON.stringify({ ...JSON.parse(publication), extra: "x" })));
      // Identity and admission fields are immutable.
      for (const [column, value] of [["job_id", rid("9")], ["request_id", rid("7")], ["admitted_at", "2026-10-21T00:00:00Z"],
        ["created_at", "2026-10-21T00:00:00Z"], ["expires_at", "2026-12-01T00:00:00Z"]] as const) {
        reject(() => setJob(db, rid("b"), `${column} = ?`, value));
      }
    } finally { db.close(); }
  });

  it("enforces failure envelopes and retry transitions", () => {
    const db = fresh();
    try {
      const failures = ["source_unavailable", "validation_failed", "publication_failed", "lease_expired", "attempts_exhausted"];
      for (const [index, failure] of failures.entries()) {
        const request = ("c" + index).padEnd(64, "c");
        const jobId = ("d" + index).padEnd(64, "d");
        addRequest(db, request, ["account-a"]);
        addJob(db, jobId, request);
        claim(db, jobId, now, "2026-10-20T00:15:00Z");
        const fail = (retry: string | null, owner: string | null = null) => setJob(db, jobId,
          "status='failed', lease_id=NULL, lease_owner=?, lease_expires_at=NULL, failure=?, retry_after=?", owner, failure, retry);
        const exhausted = failure === "attempts_exhausted";
        reject(() => fail(exhausted ? "2026-10-20T00:05:00Z" : null));
        if (!exhausted) {
          reject(() => fail(now));
          reject(() => fail("2026-10-22T00:00:00Z"));
        }
        reject(() => fail(exhausted ? null : "2026-10-20T00:05:00Z", "runner:a"));
        fail(exhausted ? null : "2026-10-20T00:05:00Z");
        // Only a retryable failure returns to queued, never an exhausted one.
        const requeue = () => setJob(db, jobId, "status='queued', retry_after=NULL, failure=NULL");
        if (exhausted) reject(requeue); else requeue();
      }
      // The final attempt cannot be requeued: attempt 3 failure is terminal.
      addRequest(db, rid("e"), ["account-a"]);
      addJob(db, rid("f"), rid("e"));
      for (let attempt = 1; attempt <= 3; attempt++) {
        claim(db, rid("f"), now, "2026-10-20T00:15:00Z");
        setJob(db, rid("f"), "status='failed', lease_id=NULL, lease_owner=NULL, lease_expires_at=NULL, failure='source_unavailable', retry_after=?",
          "2026-10-20T00:05:00Z");
        if (attempt < 3) setJob(db, rid("f"), "status='queued', retry_after=NULL, failure=NULL");
      }
      reject(() => setJob(db, rid("f"), "status='queued', retry_after=NULL, failure=NULL"));
      reject(() => { setJob(db, rid("f"), "status='running', attempt=4, claimed_at=?, lease_id='lease:4', lease_owner='r', lease_expires_at=?", now, "2026-10-20T00:15:00Z"); });
    } finally { db.close(); }
  });

  it("keeps request, link, result, group and operation constraints", () => {
    const db = fresh();
    try {
      const insertRequest = (id: string, json: string) => db.prepare(
        "INSERT INTO exploration_shared_requests (request_id, contract_version, request_json, created_at) VALUES (?, 1, ?, ?)").run(id, json, now);
      reject(() => insertRequest("bad", request));
      reject(() => insertRequest(rid("d"), JSON.stringify({ ...JSON.parse(request), family: "other" })));
      reject(() => insertRequest(rid("d"), JSON.stringify({ ...JSON.parse(request), question_text: "private" })));
      reject(() => db.prepare("INSERT INTO exploration_shared_requests (request_id, contract_version, request_json, created_at) VALUES (?, 2, ?, ?)")
        .run(rid("d"), request, now));
      reject(() => insertRequest(rid("d"), request.replace('"as_of":"2026-10-20"', '"as_of":20261020')));
      insertRequest(rid("a"), request);
      reject(() => insertRequest(rid("a"), request));
      reject(() => db.prepare("UPDATE exploration_shared_requests SET request_json = ? WHERE request_id = ?")
        .run(JSON.stringify({ ...JSON.parse(request), question_text: "x" }), rid("a")));

      // Links: existing request, valid account, 90-day window, immutable identity.
      reject(() => addLink(db, rid("9"), "account-a"));
      reject(() => addLink(db, rid("a"), ""));
      reject(() => addLink(db, rid("a"), "x".repeat(513)));
      reject(() => db.prepare("INSERT INTO exploration_request_links (request_id, account_sub, created_at, expires_at) VALUES (?, 'account-a', ?, ?)")
        .run(rid("a"), now, now));
      addLink(db, rid("a"), "account-a");
      reject(() => addLink(db, rid("a"), "account-a"));
      reject(() => db.prepare("UPDATE exploration_request_links SET account_sub = 'account-b'").run());
      insertRequest(rid("2"), request);
      reject(() => db.prepare("UPDATE exploration_request_links SET request_id = ?").run(rid("2")));

      // Results and groups: closed shape and privacy.
      const insertResult = (id: string, assignedJson: string, population = 1, feasibility = "available", coverage = "complete", roster: string | null = "roster:one") =>
        db.prepare(`INSERT INTO exploration_shared_results
          (request_id, snapshot_id, artifact_key, transform_code_version, renderer_version, roster_snapshot_id,
           feasibility, coverage, population_count, assigned_json, unknown_json, lineage_json, created_at, expires_at)
          VALUES (?, 'snapshot:one', ?, 'transform:v1', 'renderer:v1', ?, ?, ?, ?, ?, '[]', '[]', ?, ?)`)
          .run(id, rid("d"), roster, feasibility, coverage, population, assignedJson, now, plus(now, 30));
      reject(() => insertResult(rid("9"), assigned));
      reject(() => insertResult(rid("a"), assigned.replace('"person_id":"person:1",', '"extra":"x",')));
      reject(() => insertResult(rid("a"), assigned.replace("}]", ',"email":"p@example.test"}]')));
      reject(() => insertResult(rid("a"), assigned, 2));
      reject(() => insertResult(rid("a"), "[]", 0, "available", "missing"));
      reject(() => insertResult(rid("a"), "[]", 0, "available", "complete", null));
      reject(() => insertResult(rid("a"), "[]", 0, "guess", "complete"));
      insertResult(rid("a"), assigned);
      reject(() => db.prepare("UPDATE exploration_shared_results SET assigned_json = ? WHERE request_id = ?")
        .run(assigned.replace("}]", ',"email":"p@example.test"}]'), rid("a")));
      reject(() => db.prepare("UPDATE exploration_shared_results SET expires_at = ? WHERE request_id = ?").run(now, rid("a")));
      const insertGroup = (members: string) => db.prepare(`INSERT INTO exploration_shared_result_groups
        (request_id, manager_id, member_count, members_json, lineage_json) VALUES (?, 'manager:1', 1, ?, '["source:fpl"]')`).run(rid("a"), members);
      reject(() => insertGroup(assigned.replace("}]", ',"email":"p@example.test"}]')));
      insertGroup(assigned);
      reject(() => insertGroup(assigned));
      reject(() => db.prepare("UPDATE exploration_shared_result_groups SET members_json = ? WHERE request_id = ?")
        .run(assigned.replace('"person_id":"person:1",', '"extra":"x",'), rid("a")));

      // Operations: closed response, immutable, unique, retained until expiry.
      const sqlOp = `INSERT INTO exploration_bridge_operations
        (scope_key, operation_type, operation_id, body_hash, response_json, lease_id, created_at, expires_at)
        VALUES ('bridge:v1', 'claim', ?, ?, ?, NULL, ?, ?)`;
      const good = '{"version":1,"kind":"claim_result","payload":{"outcome":"not_found"}}';
      db.prepare(sqlOp).run("op:1", rid("e"), good, past, plus(past, 30));
      reject(() => db.prepare(sqlOp).run("op:1", rid("f"), good, past, plus(past, 30)));
      reject(() => db.prepare(`INSERT OR REPLACE INTO exploration_bridge_operations
        (scope_key, operation_type, operation_id, body_hash, response_json, created_at, expires_at)
        VALUES ('bridge:v1','claim','op:1',?,?,?,?)`).run(rid("f"), good, past, plus(past, 30)));
      for (const bad of ['{"version":1,"kind":"claim_result","payload":{},"extra":"x"}', '{"version":1,"kind":"claim_result","extra":"x"}',
        '{"version":2,"kind":"claim_result","payload":{}}']) {
        reject(() => db.prepare(sqlOp).run("op:2", rid("f"), bad, past, plus(past, 30)));
      }
      reject(() => db.prepare(sqlOp).run("op:3", "short", good, past, plus(past, 30)));
      reject(() => db.prepare(sqlOp).run("op:4", rid("f"), good, past, past));
      reject(() => db.prepare("UPDATE exploration_bridge_operations SET body_hash = ?").run(rid("f")));
      db.prepare(sqlOp).run("op:live", rid("e"), good, future, plus(future, 30));
      reject(() => db.prepare("DELETE FROM exploration_bridge_operations WHERE operation_id = 'op:live'").run());
      db.prepare("DELETE FROM exploration_bridge_operations WHERE operation_id = 'op:1'").run();
      expect(count(db, "exploration_bridge_operations")).toBe(1);
    } finally { db.close(); }
  });
});
