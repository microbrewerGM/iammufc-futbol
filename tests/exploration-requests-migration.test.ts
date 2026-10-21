import { describe, expect, it } from "vitest";
// @ts-expect-error Node's built-in module is available in the configured test runtime.
import { readFileSync } from "node:fs";
// @ts-expect-error Node's built-in SQLite module is available in the configured test runtime.
import { DatabaseSync } from "node:sqlite";

const migrations = ["0001_schema.sql", "0003_p16_dot_plot.sql", "0004_cache_slots.sql",
  "0005_account_question_history.sql", "0006_season_splits.sql", "0007_exploration_requests.sql"];
const requestId = "a".repeat(64);
const jobId = "b".repeat(64);
const now = "2026-10-20T00:00:00Z";
const jobExpires = "2026-11-19T00:00:00Z";
const requestExpires = "2027-01-18T00:00:00Z";
const request = JSON.stringify({ version: 1, family: "arrival_manager", as_of: "2026-10-20",
  population: "first_team_available", joining_basis: "effective_first_team_spell_entry",
  academy_basis: "documented_first_team_promotion", visualization: "table" });
const publication = JSON.stringify({ artifact_key: "c".repeat(64), request_id: requestId,
  validation_record_id: "validation:v1", publication_id: "publication:v1", loaded_snapshot_id: "snapshot:one",
  coverage_record_id: "coverage:v1", loaded_at: now, lineage: ["source:fpl"] });
function applyMigrations(db: InstanceType<typeof DatabaseSync>) {
  for (const migration of migrations) db.exec(readFileSync(`infra/migrations/${migration}`, "utf8"));
}
function reject(action: () => unknown) { expect(action).toThrow(); }
const insertRequest = `INSERT INTO exploration_requests
  (request_id, account_sub, contract_version, request_json, created_at, expires_at)
  VALUES ($request_id, $account_sub, 1, $request_json, $created_at, $expires_at)`;
const validRequest = { request_id: requestId, account_sub: "human-subject-a", request_json: request,
  created_at: now, expires_at: requestExpires };
const insertJob = `INSERT INTO exploration_jobs
  (job_id, request_id, status, attempt, admitted_at, updated_at, expires_at)
  VALUES (?, ?, 'queued', 0, ?, ?, ?)`;

describe("exploration request storage migration", () => {
  it("enforces closed storage, job transitions, retention and idempotency, and safely replays", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrations(db);
      db.exec(readFileSync("infra/migrations/0007_exploration_requests.sql", "utf8"));
      db.prepare(insertRequest).run(validRequest);
      const resultInsert = db.prepare(`INSERT INTO exploration_results
        (request_id, snapshot_id, artifact_key, transform_code_version, renderer_version, roster_snapshot_id,
         feasibility, coverage, population_count, assigned_json, unknown_json, lineage_json, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const assigned = '[{"member_id":"member:1","person_id":"person:1","spell_id":"spell:1","manager_id":"manager:1","event_id":"event:1","tenure_id":"tenure:1","lineage":["source:fpl"]}]';
      resultInsert.run(requestId, "snapshot:one", "c".repeat(64), "transform:v1", "renderer:v1", "roster:one",
        "available", "complete", 1, assigned, "[]", '["source:fpl"]', now, jobExpires);
      db.prepare(insertJob).run(jobId, requestId, now, now, jobExpires);
      expect(db.prepare("SELECT status FROM exploration_jobs WHERE job_id = ?").get(jobId)).toEqual({ status: "queued" });

      const rejectedRequests = [
        { ...validRequest, request_id: "bad" },
        { ...validRequest, request_id: "d".repeat(64), request_json: JSON.stringify({ ...JSON.parse(request), family: "other" }) },
        { ...validRequest, request_id: "e".repeat(64), account_sub: "" },
        { ...validRequest, request_id: "f".repeat(64), expires_at: now },
        { ...validRequest, request_id: "1".repeat(64), request_json: JSON.stringify({ ...JSON.parse(request), question_text: "private text" }) },
      ];
      for (const row of rejectedRequests) reject(() => db.prepare(insertRequest).run(row));
      reject(() => resultInsert.run("2".repeat(64), "snapshot:two", "c".repeat(64), "transform:v1", "renderer:v1", null,
        "available", "missing", 0, "[]", "[]", "[]", now, jobExpires));
      reject(() => db.prepare(`UPDATE exploration_results SET assigned_json = ? WHERE request_id = ?`)
        .run(assigned.replace("}]", ',"email":"private@example.test"}]'), requestId));
      db.prepare(`INSERT INTO exploration_result_groups
        (request_id, manager_id, member_count, members_json, lineage_json)
        VALUES (?, 'manager:1', 1, ?, '["source:fpl"]')`).run(requestId, assigned);
      reject(() => db.prepare(`UPDATE exploration_result_groups SET members_json = ? WHERE request_id = ?`)
        .run(assigned.replace("}]", ',"email":"private@example.test"}]'), requestId));

      // Claim is the only path that increments attempt; direct queued -> published is forbidden.
      reject(() => db.prepare(`UPDATE exploration_jobs SET status = 'published', attempt = 1,
        publication_json = ? WHERE job_id = ?`).run(publication, jobId));
      reject(() => db.prepare(`UPDATE exploration_jobs SET status = 'running', attempt = 1, claimed_at = ?,
        lease_id = 'worker:1', lease_expires_at = ? WHERE job_id = ?`).run(now, now, jobId));
      db.prepare(`UPDATE exploration_jobs SET status = 'running', attempt = 1, claimed_at = ?,
        lease_id = 'worker:1', lease_expires_at = '2026-10-20T00:15:00Z' WHERE job_id = ?`).run(now, jobId);
      db.prepare(`UPDATE exploration_jobs SET status = 'failed', lease_id = NULL, lease_expires_at = NULL,
        failure = 'source_unavailable', retry_after = '2026-10-20T00:05:00Z' WHERE job_id = ?`).run(jobId);
      reject(() => db.prepare(`UPDATE exploration_jobs SET status = 'queued',
        failure = NULL, updated_at = '2026-10-20T00:01:00Z' WHERE job_id = ?`).run(jobId));
      db.prepare(`UPDATE exploration_jobs SET status = 'queued', failure = NULL,
        retry_after = NULL, updated_at = '2026-10-20T00:06:00Z' WHERE job_id = ?`).run(jobId);
      db.prepare(`UPDATE exploration_jobs SET status = 'running', attempt = 2, claimed_at = ?,
        lease_id = 'worker:2', lease_expires_at = '2026-10-20T00:15:00Z', retry_after = NULL WHERE job_id = ?`).run(now, jobId);
      db.prepare(`UPDATE exploration_jobs SET status = 'published', lease_id = NULL, lease_expires_at = NULL,
        retry_after = NULL, failure = NULL, publication_json = ? WHERE job_id = ?`).run(publication, jobId);
      reject(() => db.prepare(`UPDATE exploration_jobs SET status = 'queued' WHERE job_id = ?`).run(jobId));
      reject(() => db.prepare(`UPDATE exploration_jobs SET status = 'failed', failure = 'no_data' WHERE job_id = ?`).run(jobId));
      reject(() => db.prepare(`UPDATE exploration_jobs SET publication_json = ? WHERE job_id = ?`)
        .run(JSON.stringify({ ...JSON.parse(publication), question_text: "raw question" }), jobId));

      const idem = `INSERT INTO exploration_job_idempotency
        (scope_key, operation_type, operation_id, body_hash, response_json, created_at, expires_at)
        VALUES ('bridge:v1', 'claim', 'op:1', ?, '{}', ?, ?)`;
      db.prepare(idem).run("d".repeat(64), now, jobExpires);
      reject(() => db.prepare(idem).run("e".repeat(64), now, jobExpires));
      reject(() => db.prepare(`INSERT INTO exploration_job_idempotency
        (scope_key, operation_type, operation_id, body_hash, response_json, created_at, expires_at)
        VALUES ('bridge:v1', 'ack', 'op:2', NULL, '{}', ?, ?)`).run(now, jobExpires));
      reject(() => db.prepare(`INSERT INTO exploration_request_accounts
        (request_id, account_sub, created_at, expires_at) VALUES (?, ?, ?, ?)`)
        .run("4".repeat(64), "account", now, jobExpires));

      db.prepare(insertRequest).run({ ...validRequest, request_id: "3".repeat(64), account_sub: "human-subject-b" });
      db.prepare(`INSERT INTO exploration_request_accounts
        (request_id, account_sub, created_at, expires_at) VALUES (?, ?, ?, ?)`)
        .run("3".repeat(64), "human-subject-b", now, requestExpires);
      db.prepare("DELETE FROM exploration_requests WHERE account_sub = ?").run("human-subject-a");
      expect(db.prepare("SELECT account_sub FROM exploration_requests").all()).toEqual([{ account_sub: "human-subject-b" }]);
      expect(db.prepare("SELECT count(*) AS n FROM exploration_results").get()).toEqual({ n: 0 });

      db.exec(readFileSync("infra/migrations/0007_exploration_requests.sql", "utf8"));
    } finally {
      db.close();
    }
  });
});
