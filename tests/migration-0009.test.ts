import { describe, expect, it } from "vitest";
// @ts-expect-error Node's built-in module is available in the configured test runtime.
import { readFileSync } from "node:fs";
// @ts-expect-error Node's built-in SQLite module is available in the configured test runtime.
import { DatabaseSync } from "node:sqlite";

const migrations = ["0001_schema.sql", "0003_p16_dot_plot.sql", "0004_cache_slots.sql",
  "0005_account_question_history.sql", "0006_season_splits.sql", "0008_exploration_request_links.sql",
  "0009_manager_era_records.sql"];
const lineage = '["openfootball_cl"]';
const record = { snapshot_id: "a".repeat(64), season: "2024-25", tenure_id: "tenure:001", manager_id: "manager:001",
  role: "manager", played: 1, won: 1, drawn: 0, lost: 0, goals_for: 2, goals_against: 0, lineage_json: lineage };
const recordSql = `INSERT INTO manager_era_season_records
  (snapshot_id, season, tenure_id, manager_id, role, played, won, drawn, lost, goals_for, goals_against, lineage_json)
  VALUES ($snapshot_id, $season, $tenure_id, $manager_id, $role, $played, $won, $drawn, $lost, $goals_for, $goals_against, $lineage_json)`;
function applyMigrations(db: InstanceType<typeof DatabaseSync>) {
  for (const migration of migrations) db.exec(readFileSync(`infra/migrations/${migration}`, "utf8"));
}
function rejected(db: InstanceType<typeof DatabaseSync>, sql: string, row: Record<string, string | number>) {
  expect(() => db.prepare(sql).run(row)).toThrow();
}

describe("manager era migration", () => {
  it("is repeatable and enforces every table's checks and lineage triggers", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrations(db);
      db.exec(readFileSync("infra/migrations/0009_manager_era_records.sql", "utf8"));
      db.prepare(recordSql).run(record);
      expect(db.prepare("SELECT count(*) AS n FROM manager_era_season_records").get()).toEqual({ n: 1 });
      const update = (lineage_json: string) => db.prepare("UPDATE manager_era_season_records SET lineage_json = ?").run(lineage_json);
      expect(() => update('["bad-id"]')).toThrow();
      expect(() => update(`["${"a".repeat(129)}"]`)).toThrow();
      update(lineage);

      rejected(db, recordSql, { ...record, season: "2024-26", tenure_id: "tenure:002" });
      rejected(db, recordSql, { ...record, tenure_id: "tenure:bad!", season: "2025-26" });
      rejected(db, recordSql, { ...record, played: 1.5, season: "2025-26" });
      rejected(db, recordSql, { ...record, drawn: 1, season: "2025-26" });
      rejected(db, recordSql, { ...record, lineage_json: "not-json", season: "2025-26" });
      rejected(db, recordSql, { ...record, lineage_json: JSON.stringify(["a".repeat(8190)]), season: "2025-26" });

      const unassignedSql = `INSERT INTO manager_era_season_unassigned
        (snapshot_id, season, reason, played, won, drawn, lost, goals_for, goals_against, lineage_json)
        VALUES ($snapshot_id, $season, $reason, $played, $won, $drawn, $lost, $goals_for, $goals_against, $lineage_json)`;
      const counts = { snapshot_id: record.snapshot_id, season: "2024-25", played: 1, won: 0, drawn: 1, lost: 0, goals_for: 0, goals_against: 0, lineage_json: lineage };
      rejected(db, unassignedSql, { ...counts, reason: "unknown" });
      db.prepare(unassignedSql).run({ ...counts, reason: "tenure_missing" });

      const coverageSql = `INSERT INTO manager_era_season_coverage
        (snapshot_id, season, coverage, completed, unfinished, ambiguous, lineage_json)
        VALUES ($snapshot_id, $season, $coverage, $completed, $unfinished, $ambiguous, $lineage_json)`;
      const coverage = { snapshot_id: record.snapshot_id, season: "2024-25", completed: 1, unfinished: 0, ambiguous: 0, lineage_json: lineage };
      rejected(db, coverageSql, { ...coverage, coverage: "unknown" });
      db.prepare(coverageSql).run({ ...coverage, coverage: "complete" });

      const managerSql = `INSERT INTO manager_era_managers (snapshot_id, manager_id, label, lineage_json)
        VALUES ($snapshot_id, $manager_id, $label, $lineage_json)`;
      const manager = { snapshot_id: record.snapshot_id, manager_id: record.manager_id, lineage_json: lineage };
      rejected(db, managerSql, { ...manager, label: "Bad\nName" });
      db.prepare(managerSql).run({ ...manager, label: "Valid Name" });
    } finally { db.close(); }
  });
});
