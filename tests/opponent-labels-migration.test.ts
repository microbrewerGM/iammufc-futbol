import { describe, expect, it } from "vitest";
// @ts-expect-error Node's built-in module is available in the configured test runtime.
import { readFileSync } from "node:fs";
// @ts-expect-error Node's built-in SQLite module is available in the configured test runtime.
import { DatabaseSync } from "node:sqlite";

type Db = InstanceType<typeof DatabaseSync>;
const migrations = ["0001_schema.sql", "0003_p16_dot_plot.sql", "0004_cache_slots.sql",
  "0005_account_question_history.sql", "0006_season_splits.sql", "0008_exploration_request_links.sql",
  "0009_manager_era_records.sql", "0010_question_requests.sql", "0011_opponent_labels.sql"];
const sqlOf = (name: string): string => readFileSync(`infra/migrations/${name}`, "utf8");
const insertSql = `INSERT INTO opponent_labels (opponent_id, label, snapshot_id)
  VALUES ($opponent_id, $label, $snapshot_id)`;
const validRow = { opponent_id: "club:1", label: "Manchester United", snapshot_id: "a".repeat(64) };

function fresh(): Db {
  const db: Db = new DatabaseSync(":memory:");
  for (const migration of migrations) db.exec(sqlOf(migration));
  return db;
}

function expectRejected(db: Db, row: Record<string, string>) {
  expect(() => db.prepare(insertSql).run(row)).toThrow();
}

describe("opponent_labels migration (0011)", () => {
  it("applies on a fresh database after the deployed migrations and enforces its row contract", () => {
    const db = fresh();
    try {
      db.prepare(insertSql).run(validRow);
      expect(db.prepare("SELECT opponent_id, label, snapshot_id FROM opponent_labels").get()).toEqual(validRow);

      expectRejected(db, { ...validRow, opponent_id: "club:0" });
      expectRejected(db, { ...validRow, opponent_id: "team:1" });
      expectRejected(db, { ...validRow, opponent_id: "club:12abc" });
      expectRejected(db, { ...validRow, opponent_id: "club:2", label: "" });
      expectRejected(db, { ...validRow, opponent_id: "club:3", label: "x".repeat(81) });
      expectRejected(db, { ...validRow, opponent_id: "club:4", snapshot_id: "a".repeat(63) });
    } finally {
      db.close();
    }
  });

  it("applies in both dev publication paths after 0010 and before Worker or seed use", () => {
    const workflow = readFileSync(".github/workflows/deploy.yml", "utf8");
    const deploySection = workflow.split("  consume-private-seed:")[0];
    const consumerSection = workflow.split("  consume-private-seed:")[1];
    expect(deploySection.indexOf("0010_question_requests.sql")).toBeLessThan(deploySection.indexOf("0011_opponent_labels.sql"));
    expect(deploySection.indexOf("0011_opponent_labels.sql")).toBeLessThan(deploySection.indexOf("Deploy Worker (dev)"));
    expect(consumerSection.indexOf("0010_question_requests.sql")).toBeLessThan(consumerSection.indexOf("0011_opponent_labels.sql"));
    expect(consumerSection.indexOf("0011_opponent_labels.sql")).toBeLessThan(consumerSection.indexOf("private-seed/0002_seed.sql"));
    expect((workflow.match(/0011_opponent_labels\.sql/g) ?? [])).toHaveLength(2);
    expect((workflow.match(/0010_question_requests\.sql/g) ?? [])).toHaveLength(2);
  });
});
