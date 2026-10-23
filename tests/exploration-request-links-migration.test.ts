import { describe, expect, it } from "vitest";
// @ts-expect-error Node's built-in module is available in the configured test runtime.
import { readFileSync } from "node:fs";
// @ts-expect-error Node's built-in SQLite module is available in the configured test runtime.
import { DatabaseSync } from "node:sqlite";

const migrations = ["0001_schema.sql", "0003_p16_dot_plot.sql", "0004_cache_slots.sql",
  "0005_account_question_history.sql", "0006_season_splits.sql", "0007_exploration_requests.sql",
  "0008_exploration_request_links.sql"];
const now = "2026-10-20T00:00:00Z";
const requestId = "a".repeat(64);
const requestJson = JSON.stringify({ version: 1, family: "arrival_manager", as_of: "2026-10-20",
  population: "first_team_available", joining_basis: "effective_first_team_spell_entry",
  academy_basis: "documented_first_team_promotion", visualization: "table" });

describe("exploration request account links migration", () => {
  it("shares canonical work while unlinking and retaining each account independently", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const migration of migrations.slice(0, -1)) db.exec(readFileSync(`infra/migrations/${migration}`, "utf8"));
      db.prepare(`INSERT INTO exploration_requests
        (request_id, account_sub, contract_version, request_json, created_at, expires_at)
        VALUES (?, 'account-a', 1, ?, ?, '2027-01-18T00:00:00Z')`).run(requestId, requestJson, now);
      db.prepare(`INSERT INTO exploration_request_accounts (request_id, account_sub, created_at, expires_at)
        VALUES (?, 'account-a', ?, '2027-01-18T00:00:00Z')`).run(requestId, now);
      db.exec(readFileSync("infra/migrations/0008_exploration_request_links.sql", "utf8"));
      db.exec(readFileSync("infra/migrations/0008_exploration_request_links.sql", "utf8"));
      const insertRequest = `INSERT INTO exploration_requests
        (request_id, account_sub, contract_version, request_json, created_at, expires_at)
        VALUES (?, 'legacy-unused', 1, ?, ?, '2027-01-18T00:00:00Z')
        ON CONFLICT(request_id) DO NOTHING`;
      db.prepare(insertRequest).run(requestId, requestJson, now);
      db.prepare(insertRequest).run(requestId, requestJson, now); // canonical replay is idempotent
      db.prepare(`INSERT INTO exploration_results
        (request_id, snapshot_id, artifact_key, transform_code_version, renderer_version, roster_snapshot_id,
         feasibility, coverage, population_count, assigned_json, unknown_json, lineage_json, created_at, expires_at)
        VALUES (?, 'snapshot:one', ?, 'transform:v1', 'renderer:v1', NULL,
          'no_data', 'missing', 0, '[]', '[]', '[]', ?, '2026-11-19T00:00:00Z')`)
        .run(requestId, "d".repeat(64), now);
      db.prepare(`INSERT INTO exploration_jobs
        (job_id, request_id, status, attempt, admitted_at, created_at, updated_at, expires_at)
        VALUES (?, ?, 'queued', 0, ?, ?, ?, '2026-11-19T00:00:00Z')`).run("b".repeat(64), requestId, now, now, now);
      db.prepare(`UPDATE exploration_jobs SET status='running', attempt=1, claimed_at=?, lease_id='worker:1',
        lease_expires_at='2026-10-20T00:15:00Z' WHERE request_id=?`).run(now, requestId);
      expect(() => db.prepare(`INSERT INTO exploration_jobs
        (job_id, request_id, status, attempt, admitted_at, created_at, updated_at, expires_at)
        VALUES (?, ?, 'queued', 0, ?, ?, ?, '2026-11-19T00:00:00Z')`).run("c".repeat(64), requestId, now, now, now)).toThrow();
      db.prepare(`INSERT INTO exploration_request_links (request_id, account_sub, created_at, expires_at)
        VALUES (?, 'account-b', ?, '2027-01-19T00:00:00Z')`).run(requestId, "2026-10-21T00:00:00Z");
      expect(db.prepare(`SELECT account_sub, created_at, expires_at FROM exploration_request_links
        WHERE request_id=? ORDER BY account_sub`).all(requestId)).toEqual([
        { account_sub: "account-a", created_at: now, expires_at: "2027-01-18T00:00:00Z" },
        { account_sub: "account-b", created_at: "2026-10-21T00:00:00Z", expires_at: "2027-01-19T00:00:00Z" },
      ]);
      expect(() => db.prepare(`INSERT INTO exploration_request_links
        (request_id, account_sub, created_at, expires_at) VALUES (?, 'account-a', ?, '2027-01-18T00:00:00Z')`)
        .run(requestId, now)).toThrow();
      expect(() => db.prepare(`UPDATE exploration_request_links SET account_sub='account-c'
        WHERE request_id=? AND account_sub='account-a'`).run(requestId)).toThrow();
      expect(db.prepare("SELECT count(*) AS n FROM exploration_requests WHERE request_id=?").get(requestId))
        .toEqual({ n: 1 });
      db.prepare("DELETE FROM exploration_request_links WHERE request_id=? AND account_sub='account-a'").run(requestId);
      expect(db.prepare("SELECT account_sub FROM exploration_request_links WHERE request_id=?").all(requestId))
        .toEqual([{ account_sub: "account-b" }]);
      expect(db.prepare("SELECT status, lease_id FROM exploration_jobs WHERE request_id=?").all(requestId))
        .toEqual([{ status: "running", lease_id: "worker:1" }]);
      expect(db.prepare("SELECT snapshot_id FROM exploration_results WHERE request_id=?").all(requestId))
        .toEqual([{ snapshot_id: "snapshot:one" }]);
      db.close();
    } finally {
      // DatabaseSync close is safe after the assertions and makes teardown explicit.
    }
  });
});
