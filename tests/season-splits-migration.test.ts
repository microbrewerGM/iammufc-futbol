import { describe, expect, it } from "vitest";
// @ts-expect-error Node's built-in module is available in the configured test runtime.
import { readFileSync } from "node:fs";
// @ts-expect-error Node's built-in SQLite module is available in the configured test runtime.
import { DatabaseSync } from "node:sqlite";

const migrations = ["0001_schema.sql", "0003_p16_dot_plot.sql", "0004_cache_slots.sql",
  "0005_account_question_history.sql", "0006_season_splits.sql"];
const validRow = {
  snapshot_id: "a".repeat(64), season: "2024-25", competition: "PL", venue: "home", opponent_id: "club:1",
  played: 1, won: 1, drawn: 0, lost: 0, goals_for: 2, goals_against: 0, lineage_json: '["openfootball_cl"]',
};
const insertSql = `INSERT INTO season_splits
  (snapshot_id, season, competition, venue, opponent_id, played, won, drawn, lost, goals_for, goals_against, lineage_json)
  VALUES ($snapshot_id, $season, $competition, $venue, $opponent_id, $played, $won, $drawn, $lost, $goals_for, $goals_against, $lineage_json)`;
function applyMigrations(db: InstanceType<typeof DatabaseSync>) {
  for (const migration of migrations) db.exec(readFileSync(`infra/migrations/${migration}`, "utf8"));
}
function expectRejected(db: InstanceType<typeof DatabaseSync>, row: Record<string, string | number>) {
  expect(() => db.prepare(insertSql).run(row)).toThrow();
}

describe("season splits migration", () => {
  it("executes migrations repeatably and enforces aggregates and source-ID lineage", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrations(db);
      db.exec(readFileSync("infra/migrations/0006_season_splits.sql", "utf8"));
      db.prepare(insertSql).run(validRow);
      expect(db.prepare("SELECT count(*) AS n FROM season_splits").get()).toEqual({ n: 1 });

      expectRejected(db, { ...validRow }); // duplicate primary key
      expectRejected(db, { ...validRow, season: "2025-26", venue: "away", played: -1, won: 0, lost: 1 });
      expectRejected(db, { ...validRow, season: "2025-26", venue: "away", played: 1.5 });
      expectRejected(db, { ...validRow, season: "2025-26", venue: "away", drawn: 1 });

      let rejectedSeason = 2025;
      for (const lineage_json of ["[]", "[\"openfootball_cl\",\"openfootball_cl\"]", "[\" \n\"]",
        "[\"Openfootball\"]", "[\"1source\"]", "[\"bad-id\"]", "[1]", "[null]",
        JSON.stringify(["a".repeat(129)])]) {
        expectRejected(db, { ...validRow, season: `${rejectedSeason}-${String((rejectedSeason + 1) % 100).padStart(2, "0")}`, lineage_json });
        rejectedSeason += 1;
      }

      expect(() => db.prepare("UPDATE season_splits SET lineage_json = '[\"bad-id\"]'").run()).toThrow();
      db.prepare("UPDATE season_splits SET lineage_json = '[\"fpl\",\"openfootball_cl\"]'").run();
      expect(db.prepare("SELECT lineage_json FROM season_splits").get()).toEqual({ lineage_json: '["fpl","openfootball_cl"]' });
    } finally {
      db.close();
    }
  });

  it("applies before worker and private seed consumption in both deploy paths", () => {
    const workflow = readFileSync(".github/workflows/deploy.yml", "utf8");
    const deploySection = workflow.split("  consume-private-seed:")[0];
    const consumerSection = workflow.split("  consume-private-seed:")[1];
    expect(deploySection.indexOf("0005_account_question_history.sql")).toBeLessThan(deploySection.indexOf("0006_season_splits.sql"));
    expect(deploySection.indexOf("0006_season_splits.sql")).toBeLessThan(deploySection.indexOf("Deploy Worker (dev)"));
    expect(consumerSection.indexOf("0005_account_question_history.sql")).toBeLessThan(consumerSection.indexOf("0006_season_splits.sql"));
    expect(consumerSection.indexOf("0006_season_splits.sql")).toBeLessThan(consumerSection.indexOf("private-seed/0002_seed.sql"));
    const localSeed = JSON.parse(readFileSync("package.json", "utf8")).scripts["d1:seed"] as string;
    expect(localSeed.indexOf("0005_account_question_history.sql")).toBeLessThan(localSeed.indexOf("0006_season_splits.sql"));
    expect(localSeed.indexOf("0006_season_splits.sql")).toBeLessThan(localSeed.indexOf("0002_seed.sql"));
    expect((workflow.match(/0006_season_splits\.sql/g) ?? [])).toHaveLength(2);
  });
});
