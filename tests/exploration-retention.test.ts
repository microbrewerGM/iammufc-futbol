import { describe, expect, it } from "vitest";
// @ts-expect-error Node's built-in module is available in the configured test runtime.
import { readFileSync } from "node:fs";
// @ts-expect-error Node's built-in SQLite module is available in the configured test runtime.
import { DatabaseSync } from "node:sqlite";
import { collectExplorationRetention } from "../worker/src/core/exploration-retention";

type Db = InstanceType<typeof DatabaseSync>;
const migration = "infra/migrations/0008_exploration_request_links.sql";
const sql = (name: string) => readFileSync(`infra/migrations/${name}`, "utf8");
function fresh(): Db {
  const db: Db = new DatabaseSync(":memory:");
  for (const name of ["0001_schema.sql", "0003_p16_dot_plot.sql", "0004_cache_slots.sql",
    "0005_account_question_history.sql", "0006_season_splits.sql", "0008_exploration_request_links.sql"]) db.exec(sql(name));
  return db;
}
const now = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace(".000Z", "Z");
const days = (n: number) => new Date(Date.parse(now) + n * 86_400_000).toISOString().replace(".000Z", "Z");
const request = JSON.stringify({ version: 1, family: "arrival_manager", as_of: now.slice(0, 10), population: "first_team_available",
  joining_basis: "effective_first_team_spell_entry", academy_basis: "documented_first_team_promotion", visualization: "table" });
const id = (n: number) => n.toString(16).padStart(64, "0");
function addRequest(db: Db, n: number, links: Array<{ account: string; at: string }>) {
  db.prepare("INSERT INTO exploration_shared_requests (request_id, contract_version, request_json, created_at) VALUES (?, 1, ?, ?)")
    .run(id(n), request, now);
  for (const link of links) {
    const createdAt = Date.parse(link.at) < Date.parse(now) ? days(-91) : now;
    db.prepare(`INSERT INTO exploration_request_links (request_id, account_sub, created_at, expires_at)
      VALUES (?, ?, ?, ?)`).run(id(n), link.account, createdAt, days(Date.parse(createdAt) < Date.parse(now) ? -1 : 90));
  }
}
const count = (db: Db, table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("exploration time based retention", () => {
  it("executes the migration's exact collector SQL against a real 0008 schema", () => {
    const db = fresh();
    try {
      const statements = (readFileSync(migration, "utf8") as string).split("-- COLLECTOR-BEGIN\n")[1]!.split("-- COLLECTOR-END")[0]!
        .split("\n").filter(Boolean).map((line) => line.replace(/^-- /, ""));
      expect(statements).toHaveLength(3);
      addRequest(db, 1, [{ account: "expired", at: days(-1) }]);
      addRequest(db, 2, [{ account: "live", at: days(90) }]);
      for (let n = 10; n < 111; n++) {
        db.prepare("INSERT INTO exploration_shared_requests (request_id, contract_version, request_json, created_at) VALUES (?, 1, ?, ?)")
          .run(id(n), request, now);
      }
      db.prepare(`INSERT INTO exploration_shared_job_tombstones (job_id, request_id, deleted_at) VALUES (?, ?, ?)`)
        .run(id(3), id(3), days(-31));
      db.prepare(`INSERT INTO exploration_shared_job_tombstones (job_id, request_id, deleted_at) VALUES (?, ?, ?)`)
        .run(id(4), id(4), now);
      db.exec(statements[0]!);
      expect(db.prepare("SELECT account_sub FROM exploration_request_links").all()).toEqual([{ account_sub: "live" }]);
      expect(db.prepare("SELECT request_id FROM exploration_shared_requests WHERE request_id IN (?, ?)").all(id(1), id(2)))
        .toEqual([{ request_id: id(2) }]);
      db.exec(statements[1]!);
      expect(count(db, "exploration_shared_requests")).toBe(2);
      db.exec(statements[1]!);
      expect(count(db, "exploration_shared_requests")).toBe(1);
      db.exec(statements[2]!);
      expect(db.prepare("SELECT job_id FROM exploration_shared_job_tombstones").all()).toEqual([{ job_id: id(4) }]);
    } finally { db.close(); }
  });

  it("runs the server-owned collector using only fixed SQL and bounded requests", async () => {
    const calls: Array<{ query: string; bindings: unknown[] }> = [];
    const db = { prepare(query: string) { return { bind(...bindings: unknown[]) { return { run: async () => { calls.push({ query, bindings }); } }; },
      run: async () => { calls.push({ query, bindings: [] }); } }; } } as unknown as D1Database;
    await collectExplorationRetention({ DB: db });
    expect(calls).toHaveLength(3);
    expect(calls.map(({ query }) => query)).toEqual(expect.arrayContaining([
      expect.stringContaining("LIMIT 100"), expect.stringContaining("exploration_collectable_requests"),
      expect.stringContaining("exploration_shared_job_tombstones"),
    ]));
    expect(calls.every(({ bindings }) => bindings.length === 0)).toBe(true);
  });
});
