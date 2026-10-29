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
      expectRejected(db, { ...validRow, opponent_id: "club:1x" });
      expectRejected(db, { ...validRow, opponent_id: "club:01" });
      expectRejected(db, { ...validRow, opponent_id: "club:1\n" });
      expectRejected(db, { ...validRow, opponent_id: "club:1 " });
      expectRejected(db, { ...validRow, opponent_id: "club:1\0x" });
      expectRejected(db, { ...validRow, opponent_id: "club:2", label: "" });
      expectRejected(db, { ...validRow, opponent_id: "club:2", label: "label\0x" });
      expectRejected(db, { ...validRow, opponent_id: "club:3", label: "x".repeat(81) });
      expectRejected(db, { ...validRow, opponent_id: "club:4", snapshot_id: "a".repeat(63) });
      expectRejected(db, { ...validRow, opponent_id: "club:5", snapshot_id: "g".repeat(64) });
      expectRejected(db, { ...validRow, opponent_id: "club:6", snapshot_id: "A".repeat(64) });
      expectRejected(db, { ...validRow, opponent_id: "club:6", snapshot_id: `${"a".repeat(64)}\0g` });
      const lowerHexRow = { ...validRow, opponent_id: "club:7", snapshot_id: "0123456789abcdef".repeat(4) };
      db.prepare(insertSql).run(lowerHexRow);
      expect(db.prepare("SELECT opponent_id, label, snapshot_id FROM opponent_labels WHERE opponent_id = $opponent_id").get({ $opponent_id: lowerHexRow.opponent_id })).toEqual(lowerHexRow);
    } finally {
      db.close();
    }
  });

  it("applies in both dev publication paths after 0010 and before Worker or seed use", () => {
    const workflow = readFileSync(".github/workflows/deploy.yml", "utf8");
    const jobs = workflow.split(/^  [a-z][a-z0-9-]*:\s*$/m).slice(1);
    const exactCommand = "d1 execute iammufc-dev --config infra/wrangler.jsonc --env dev --remote --file infra/migrations/0011_opponent_labels.sql";
    const migrationSteps: Array<{ job: string; uses: string; apiToken: string; accountId: string; command: string; index: number }> = [];
    for (const job of jobs) {
      const jobName = job.slice(0, job.indexOf("\n"));
      const stepPattern = /- name: Apply (?:question requests|opponent labels) migration \(dev\)[\s\S]*?(?=\n      - |$)/g;
      const steps = [...job.matchAll(stepPattern)];
      const step0010 = steps.find((step) => step[0].includes("0010_question_requests.sql"));
      const step0011 = steps.find((step) => step[0].includes("0011_opponent_labels.sql"));
      if (!step0011) continue;
      expect(step0010).toBeDefined();
      expect(step0011.index).toBeGreaterThan(step0010!.index!);
      expect(step0011[0]).toContain(`command: ${exactCommand}`);
      expect(step0011[0]).toContain("apiToken: ${{ secrets.CF_TOKEN_DEV }}");
      expect(step0011[0]).toContain("accountId: ${{ secrets.CF_ACCOUNT }}");
      const uses0010 = step0010![0].match(/^        uses: (.+)$/m)?.[1];
      const uses0011 = step0011[0].match(/^        uses: (.+)$/m)?.[1];
      expect(uses0011).toBe(uses0010);
      expect(uses0011).toMatch(/^cloudflare\/wrangler-action@[0-9a-f]{40}(?:\s+#.*)?$/);
      const after0011 = job.slice(step0011.index! + step0011[0].length);
      expect(after0011.search(/^      - name: (?:Deploy Worker|Load verified private seed)/m)).toBeGreaterThanOrEqual(0);
      migrationSteps.push({ job: jobName, uses: uses0011!, apiToken: "checked", accountId: "checked", command: exactCommand, index: step0011.index! });
    }
    expect(migrationSteps).toHaveLength(2);
  });

  it("includes 0011 in the local d1:seed sequence after 0010 and before the seed data", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: { "d1:seed": string } };
    const seed = packageJson.scripts["d1:seed"];
    const segment0010 = "wrangler d1 execute iammufc-dev --config infra/wrangler.jsonc --env dev --local --file infra/migrations/0010_question_requests.sql";
    const segment0011 = "wrangler d1 execute iammufc-dev --config infra/wrangler.jsonc --env dev --local --file infra/migrations/0011_opponent_labels.sql";
    const segment0002 = "wrangler d1 execute iammufc-dev --config infra/wrangler.jsonc --env dev --local --file infra/migrations/0002_seed.sql";
    expect(seed).toContain(`${segment0010} && ${segment0011} && ${segment0002}`);
  });
});
