import { describe, expect, it } from "vitest";
// @ts-expect-error Node built-ins are provided by the test runtime.
import { readFileSync } from "node:fs";
// @ts-expect-error Node SQLite is provided by the test runtime.
import { DatabaseSync } from "node:sqlite";

type Db = InstanceType<typeof DatabaseSync>;
const sql = (file: string): string => readFileSync(`infra/migrations/${file}`, "utf8");
const migration = sql("0017_exploration_null_checks.sql");
const at = "2026-11-03T12:00:00Z";
const expiry = "2026-12-03T12:00:00Z";
const bad = "2026-99-03T12:00:00Z";
const id = "a".repeat(64);
const request = JSON.stringify({ version: 1, family: "arrival_manager", as_of: "2026-11-03",
  population: "first_team_available", joining_basis: "effective_first_team_spell_entry",
  academy_basis: "documented_first_team_promotion", visualization: "table" });
type Row = Record<string, string | number | null>;
const rows: Record<string, Row> = {
  exploration_shared_requests: { request_id: id, contract_version: 1, request_json: request, created_at: at },
  exploration_request_links: { request_id: id, account_sub: "account:test", created_at: at, expires_at: "2027-02-01T12:00:00Z" },
  exploration_shared_results: { request_id: id, snapshot_id: "snapshot:1", artifact_key: id,
    transform_code_version: "transform:1", renderer_version: "renderer:1", feasibility: "no_data",
    coverage: "missing", population_count: 0, assigned_json: "[]", unknown_json: "[]", lineage_json: "[]",
    created_at: at, expires_at: expiry },
  exploration_shared_jobs: { job_id: id, request_id: id, status: "queued", attempt: 0,
    admitted_at: at, created_at: at, updated_at: at, expires_at: expiry },
  exploration_shared_job_tombstones: { job_id: id, request_id: id, deleted_at: at },
  exploration_bridge_operations: { service: "service:test", scope_key: "scope:test", operation_type: "claim",
    operation_id: "operation:1", body_hash: id, response_json: '{"version":1,"kind":"claim_result","payload":{}}',
    created_at: at, expires_at: expiry },
};
function insert(db: Db, table: string, row: Row) {
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
    .run(...Object.values(row));
}
function fresh(patched: boolean): Db {
  const db: Db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(sql("0008_exploration_request_links.sql"));
  if (patched) db.exec(migration);
  insert(db, "exploration_shared_requests", rows.exploration_shared_requests!);
  insert(db, "exploration_request_links", rows.exploration_request_links!);
  return db;
}
/** Every regression is exercised on real SQLite with and without 0017. */
function regression(action: (db: Db) => void) {
  for (const patched of [false, true]) {
    const db = fresh(patched);
    try {
      if (patched) expect(() => action(db)).toThrow(/invalid exploration/);
      else expect(() => action(db)).not.toThrow();
    } finally { db.close(); }
  }
}

describe("0017 exploration NULL-safe checks", () => {
  for (const [table, row] of Object.entries(rows)) {
    it(`rejects malformed INSERT dates in ${table}`, () => regression((db) => {
      const changed = { ...row };
      for (const key of Object.keys(changed)) if (key.endsWith("_at")) changed[key] = bad;
      if (table === "exploration_shared_requests") changed.request_id = "b".repeat(64);
      if (table === "exploration_request_links") changed.account_sub = "account:bad";
      insert(db, table, changed);
    }));
  }
  for (const table of ["exploration_shared_requests", "exploration_request_links", "exploration_shared_results"]) {
    it(`rejects malformed UPDATE dates in ${table}`, () => regression((db) => {
      if (table === "exploration_shared_results") insert(db, table, rows[table]!);
      db.prepare(`UPDATE ${table} SET created_at = ?`).run(bad);
    }));
  }
  for (const column of ["admitted_at", "created_at", "updated_at"]) {
    it(`rejects malformed job ${column} on INSERT`, () => regression((db) => {
      insert(db, "exploration_shared_jobs", { ...rows.exploration_shared_jobs!, [column]: bad });
    }));
  }
  const claim = (db: Db, overrides: Row = {}) => {
    const fields: Row = { status: "running", attempt: 1, revision: 2, claimed_at: at,
      lease_id: "lease:1", lease_owner: "service:test", lease_expires_at: "2026-11-03T12:15:00Z", ...overrides };
    db.prepare(`UPDATE exploration_shared_jobs SET ${Object.keys(fields).map((key) => `${key} = ?`).join(",")}`)
      .run(...Object.values(fields));
  };
  for (const column of ["updated_at", "claimed_at", "lease_expires_at", "retry_after"]) {
    it(`rejects malformed job ${column} on UPDATE`, () => regression((db) => {
      insert(db, "exploration_shared_jobs", rows.exploration_shared_jobs!);
      claim(db, { [column]: column === "claimed_at" ? "2026-00-03T12:00:00Z" : bad });
    }));
  }
  it("rejects a running lease without an owner", () => regression((db) => {
    insert(db, "exploration_shared_jobs", rows.exploration_shared_jobs!);
    claim(db, { lease_owner: null });
  }));
  it("preserves rejection of NULL lease expiry and claim time", () => {
    for (const patched of [false, true]) {
      for (const column of ["lease_expires_at", "claimed_at"]) {
        const db = fresh(patched);
        try {
          insert(db, "exploration_shared_jobs", rows.exploration_shared_jobs!);
          expect(() => claim(db, { [column]: null })).toThrow();
        } finally { db.close(); }
      }
    }
  });
  it("preserves valid rows, reapplies safely, and permits the job lifecycle", () => {
    const db = fresh(false);
    try {
      for (const table of ["exploration_shared_results", "exploration_shared_jobs", "exploration_bridge_operations",
        "exploration_shared_job_tombstones"]) insert(db, table, rows[table]!);
      const dump = () => Object.keys(rows).map((table) => db.prepare(`SELECT * FROM ${table}`).all());
      const before = dump();
      db.exec(migration);
      db.exec(migration);
      expect(dump()).toEqual(before);
      claim(db);
      db.exec(`UPDATE exploration_shared_jobs SET status='failed', failure='source_unavailable',
        lease_expires_at=NULL, retry_after='2026-11-03T13:00:00Z', revision=3`);
      db.exec(`UPDATE exploration_shared_jobs SET status='queued', failure=NULL, lease_id=NULL,
        lease_owner=NULL, retry_after=NULL, revision=4`);
      expect(db.prepare("SELECT status FROM exploration_shared_jobs").get()).toMatchObject({ status: "queued" });
    } finally { db.close(); }
  });
});
