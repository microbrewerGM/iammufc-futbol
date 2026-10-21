import { describe, expect, it } from "vitest";
// @ts-expect-error Node's built-in module is available in the configured test runtime.
import { readFileSync } from "node:fs";
// @ts-expect-error Node's built-in SQLite module is available in the configured test runtime.
import { DatabaseSync } from "node:sqlite";

const migrations = ["0001_schema.sql", "0003_p16_dot_plot.sql", "0004_cache_slots.sql",
  "0005_account_question_history.sql", "0006_season_splits.sql", "0007_exploration_requests.sql"];
const requestId = "a".repeat(64);
const jobId = "b".repeat(64);
const request = JSON.stringify({ version: 1, family: "arrival_manager", as_of: "2026-10-20",
  population: "first_team_available", joining_basis: "effective_first_team_spell_entry",
  academy_basis: "documented_first_team_promotion", visualization: "table" });
function applyMigrations(db: InstanceType<typeof DatabaseSync>) {
  for (const migration of migrations) db.exec(readFileSync(`infra/migrations/${migration}`, "utf8"));
}
const insertRequest = `INSERT INTO exploration_requests
  (request_id, account_sub, contract_version, request_json, created_at, expires_at)
  VALUES ($request_id, $account_sub, 1, $request_json, $created_at, $expires_at)`;
const validRequest = { request_id: requestId, account_sub: "human-subject-a", request_json: request,
  created_at: "2026-10-20T00:00:00Z", expires_at: "2027-01-18T00:00:00Z" };

describe("exploration request storage migration", () => {
  it("applies 0001 and 0003–0007 in order, replays 0007, accepts bounded rows and rejects invalid rows", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrations(db);
      db.exec(readFileSync("infra/migrations/0007_exploration_requests.sql", "utf8"));
      db.prepare(insertRequest).run(validRequest);
      db.prepare(`INSERT INTO exploration_results
        (request_id, snapshot_id, artifact_key, transform_code_version, renderer_version, roster_snapshot_id,
         feasibility, coverage, population_count, assigned_json, unknown_json, lineage_json, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(requestId, "snapshot:one", "c".repeat(64), "transform:v1", "renderer:v1", "roster:one",
          "available", "complete", 1, '[{"member_id":"member:1"}]', "[]", '["fpl"]',
          "2026-10-20T00:00:00Z", "2026-11-19T00:00:00Z");
      db.prepare(`INSERT INTO exploration_jobs
        (job_id, request_id, status, attempt, admitted_at, updated_at, expires_at)
        VALUES (?, ?, 'queued', 0, ?, ?, ?)`)
        .run(jobId, requestId, "2026-10-20T00:00:00Z", "2026-10-20T00:00:00Z", "2026-11-19T00:00:00Z");
      expect(db.prepare("SELECT count(*) AS n FROM exploration_jobs WHERE status = 'queued'").get()).toEqual({ n: 1 });

      const rejectedRequestRows = [
        { ...validRequest, request_id: "bad" },
        { ...validRequest, request_id: "d".repeat(64), request_json: JSON.stringify({ ...JSON.parse(request), family: "other" }) },
        { ...validRequest, request_id: "e".repeat(64), account_sub: "" },
        { ...validRequest, request_id: "f".repeat(64), expires_at: validRequest.created_at },
        { ...validRequest, request_id: "1".repeat(64), request_json: JSON.stringify({ ...JSON.parse(request), question_text: "private text" }) },
      ];
      for (const row of rejectedRequestRows) {
        try {
          db.prepare(insertRequest).run(row);
          throw new Error(`unexpectedly accepted request row ${row.request_id}`);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("unexpectedly accepted")) throw error;
        }
      }

      expect(() => db.prepare(`INSERT INTO exploration_jobs
        (job_id, request_id, status, attempt, admitted_at, updated_at, expires_at)
        VALUES (?, ?, 'queued', 4, ?, ?, ?)`)
        .run("2".repeat(64), requestId, "2026-10-20T00:00:00Z", "2026-10-20T00:00:00Z", "2026-11-19T00:00:00Z")).toThrow();
      expect(() => db.prepare(`INSERT INTO exploration_results
        (request_id, snapshot_id, artifact_key, transform_code_version, renderer_version, roster_snapshot_id,
         feasibility, coverage, population_count, assigned_json, unknown_json, lineage_json, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("a".repeat(64), "snapshot:two", "c".repeat(64), "transform:v1", "renderer:v1", null,
          "available", "missing", 0, "[]", "[]", "[]", "2026-10-20T00:00:00Z", "2026-11-19T00:00:00Z")).toThrow();

      db.prepare(insertRequest).run({ ...validRequest, request_id: "3".repeat(64), account_sub: "human-subject-b" });
      db.prepare(`INSERT INTO exploration_request_accounts
        (request_id, account_sub, created_at, expires_at) VALUES (?, ?, ?, ?)`)
        .run("3".repeat(64), "human-subject-b", "2026-10-20T00:00:00Z", "2027-01-18T00:00:00Z");
      db.prepare("DELETE FROM exploration_requests WHERE account_sub = ?").run("human-subject-a");
      expect(db.prepare("SELECT account_sub FROM exploration_requests").all()).toEqual([{ account_sub: "human-subject-b" }]);
      expect(db.prepare("SELECT count(*) AS n FROM exploration_results").get()).toEqual({ n: 0 });
      db.prepare("DELETE FROM exploration_jobs WHERE expires_at <= ?").run("2026-12-01T00:00:00Z");
      expect(db.prepare("SELECT count(*) AS n FROM exploration_jobs").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
