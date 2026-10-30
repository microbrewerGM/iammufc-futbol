import { describe, expect, it } from "vitest";
// @ts-expect-error Node's built-in module is available in the configured test runtime.
import { readFileSync } from "node:fs";
// @ts-expect-error Node's built-in SQLite module is available in the configured test runtime.
import { DatabaseSync } from "node:sqlite";

type Db = InstanceType<typeof DatabaseSync>;
const migrations = ["0001_schema.sql", "0003_p16_dot_plot.sql", "0004_cache_slots.sql",
  "0005_account_question_history.sql", "0006_season_splits.sql", "0008_exploration_request_links.sql",
  "0009_manager_era_records.sql", "0010_question_requests.sql", "0011_opponent_labels.sql"];
const sqlOf = (name: string) => readFileSync(`infra/migrations/${name}`, "utf8");
const stages = ["group_stage", "league_phase", "knockout_playoff", "round_of_16", "quarter_final", "semi_final", "final", "winner"];

function fresh(): Db {
  const db: Db = new DatabaseSync(":memory:");
  for (const migration of migrations) db.exec(sqlOf(migration));
  return db;
}

function expectStageTable(db: Db) {
  db.exec(sqlOf("0012_cl_season_stage.sql"));
  const columns = db.prepare("PRAGMA table_info(cl_season_stage)").all() as Array<{ name: string; pk: number }>;
  expect(columns.map(({ name }) => name)).toEqual(["snapshot_id", "season", "stage_reached"]);
  expect(columns.filter(({ pk }) => pk > 0).sort((a, b) => a.pk - b.pk).map(({ name }) => name)
    .sort()).toEqual(["season", "snapshot_id"]);
  const insert = db.prepare("INSERT INTO cl_season_stage(snapshot_id, season, stage_reached) VALUES (?, ?, ?)");
  for (const [index, stage] of stages.entries()) insert.run("a".repeat(64), `20${index + 10}-${String(index + 11).slice(-2)}`, stage);
  expect(db.prepare("SELECT count(*) AS n FROM cl_season_stage").get()).toEqual({ n: stages.length });
  expect(() => insert.run("b".repeat(64), "2025-26", "unknown_stage")).toThrow();
  expect(() => insert.run("a".repeat(64), "2030-31", "winner")).not.toThrow();
  expect(() => db.prepare("INSERT INTO cl_season_stage VALUES (?, ?, ?)").run("a".repeat(64), "2030-31", "final")).toThrow();
}

describe("CL stage migration (0012)", () => {
  it("creates the checked table on an empty database and after the current schema", () => {
    const empty = new DatabaseSync(":memory:");
    const current = fresh();
    try {
      expectStageTable(empty);
      expectStageTable(current);
      expect(current.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='season_stats'").get())
        .toEqual({ name: "season_stats" });
    } finally {
      empty.close();
      current.close();
    }
  });

  it("applies in both dev publication paths and the local seed sequence", () => {
    const workflow = readFileSync(".github/workflows/deploy.yml", "utf8");
    const deploySection = workflow.split("  consume-private-seed:")[0]!;
    const consumerSection = workflow.split("  consume-private-seed:")[1]!;
    for (const [section, next] of [[deploySection, "Deploy Worker (dev)"], [consumerSection, "private-seed/0002_seed.sql"]]) {
      const step = section.match(/- name: Apply Champions League stage migration \(dev\)[\s\S]*?(?=\n      - |$)/)?.[0];
      expect(step).toBeDefined();
      expect(step).toContain("command: d1 execute iammufc-dev --config infra/wrangler.jsonc --env dev --remote --file infra/migrations/0012_cl_season_stage.sql");
      expect(step).toContain("uses: cloudflare/wrangler-action@ebbaa1584979971c8614a24965b4405ff95890e0");
      expect(section.indexOf("0012_cl_season_stage.sql")).toBeLessThan(section.indexOf(next));
    }
    expect((workflow.match(/0012_cl_season_stage\.sql/g) ?? [])).toHaveLength(2);
    const seed = JSON.parse(readFileSync("package.json", "utf8")).scripts["d1:seed"] as string;
    expect(seed.indexOf("0011_opponent_labels.sql")).toBeLessThan(seed.indexOf("0012_cl_season_stage.sql"));
    expect(seed.indexOf("0012_cl_season_stage.sql")).toBeLessThan(seed.indexOf("0002_seed.sql"));
  });
});
