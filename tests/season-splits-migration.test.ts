import { describe, expect, it } from "vitest";
// @ts-expect-error Node's built-in module is available in the configured test runtime.
import { readFileSync } from "node:fs";

describe("season splits migration", () => {
  it("stores only non-negative integer aggregates at the frozen grain", () => {
    const migration = readFileSync("infra/migrations/0006_season_splits.sql", "utf8");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS season_splits");
    for (const column of ["played", "won", "drawn", "lost", "goals_for", "goals_against"]) {
      expect(migration).toMatch(new RegExp(`${column}\\s+INTEGER NOT NULL CHECK \\(typeof\\(${column}\\) = 'integer' AND ${column} >= 0\\)`));
    }
    expect(migration).toContain("CHECK (won + drawn + lost = played)");
    expect(migration).toContain("PRIMARY KEY (snapshot_id, season, competition, venue, opponent_id)");
    expect(migration).not.toMatch(/fixture_key/);
    expect(migration).toContain("lineage_json  TEXT NOT NULL");
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
