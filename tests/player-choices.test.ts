import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error Node built-ins are available in the configured test runtime.
import { readFileSync, readdirSync } from "node:fs";
import { playerChoices, type Env } from "../worker/src/core/db";

const sqliteModuleName: string = "node:sqlite";
const { DatabaseSync } = await import(sqliteModuleName) as unknown as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    close(): void;
    prepare(sql: string): {
      run(...values: unknown[]): unknown;
      all(...values: unknown[]): Array<Record<string, unknown>>;
    };
  };
};
type Sqlite = InstanceType<typeof DatabaseSync>;
const stores: Sqlite[] = [];
const OLD = "b".repeat(64);
const NEW = "a".repeat(64);

afterEach(() => { for (const db of stores.splice(0)) db.close(); });

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  stores.push(sqlite);
  for (const name of readdirSync("infra/migrations").filter((n: string) => n.endsWith(".sql") && n !== "0002_seed.sql").sort()) {
    sqlite.exec(readFileSync(`infra/migrations/${name}`, "utf8"));
  }
  sqlite.prepare("INSERT INTO snapshots VALUES (?, '2025-01-01', '{}', '{}')").run(OLD);
  sqlite.prepare("INSERT INTO snapshots VALUES (?, '2026-01-01', '{}', '{}')").run(NEW);
  const reads: { sql: string; values: unknown[] }[] = [];
  const env = { DB: { prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind(...bound: unknown[]) { values = bound; return statement; },
      async all() { reads.push({ sql, values }); return { results: sqlite.prepare(sql).all(...values) }; },
    };
    return statement;
  } } } as unknown as Env;
  return { sqlite, env, reads };
}

function add(sqlite: Sqlite, code: number, season: string, minutes: number,
  opts: { competition?: string; snapshot?: string; name?: string } = {}) {
  const player = `fpl:${code}:${season}`;
  const exists = sqlite.prepare("SELECT 1 AS x FROM players WHERE player_id = ?").all(player).length > 0;
  if (!exists) {
    sqlite.prepare("INSERT INTO players VALUES (?, ?, ?, ?, '', '', 'MID', 'MUN')").run(player, code, season, opts.name ?? `P${code}-${season}`);
    sqlite.prepare("INSERT INTO player_identities VALUES (?, ?, 'fpl', ?, ?)").run(player, `fpl:code:${code}`, code, season);
  }
  sqlite.prepare(`INSERT INTO player_season_stats(player_id, season, competition, minutes, snapshot_id)
    VALUES (?, ?, ?, ?, ?)`).run(player, season, opts.competition ?? "PL", minutes, opts.snapshot ?? NEW);
}

describe("playerChoices", () => {
  it("orders by total minutes desc then person_id, summing seasons, latest-season label", async () => {
    const { sqlite, env } = fixture();
    add(sqlite, 3, "2024-25", 500);
    add(sqlite, 1, "2024-25", 400);
    add(sqlite, 1, "2023-24", 600);
    add(sqlite, 2, "2024-25", 1000);
    const rows = await playerChoices(env, NEW, { seasons: ["2023-24", "2024-25"] });
    expect(rows).toEqual([
      { person_id: "fpl:code:1", label: "P1-2024-25" },
      { person_id: "fpl:code:2", label: "P2-2024-25" },
      { person_id: "fpl:code:3", label: "P3-2024-25" },
    ]);
  });

  it("breaks minute ties by person_id", async () => {
    const { sqlite, env } = fixture();
    add(sqlite, 9, "2024-25", 100);
    add(sqlite, 4, "2024-25", 100);
    const rows = await playerChoices(env, NEW, { seasons: ["2024-25"] });
    expect(rows.map((r) => r.person_id)).toEqual(["fpl:code:4", "fpl:code:9"]);
  });

  it("defaults to 60 and hard-caps at 100", async () => {
    const { sqlite, env, reads } = fixture();
    for (let code = 1; code <= 120; code++) add(sqlite, code, "2024-25", 1000 - code);
    expect(await playerChoices(env, NEW, { seasons: ["2024-25"] })).toHaveLength(60);
    expect(await playerChoices(env, NEW, { seasons: ["2024-25"], limit: 5 })).toHaveLength(5);
    expect(await playerChoices(env, NEW, { seasons: ["2024-25"], limit: 500 })).toHaveLength(100);
    expect(reads.at(-1)!.values.at(-1)).toBe(100);
  });

  it("filters by seasons", async () => {
    const { sqlite, env } = fixture();
    add(sqlite, 1, "2023-24", 900);
    add(sqlite, 2, "2024-25", 900);
    const rows = await playerChoices(env, NEW, { seasons: ["2023-24"] });
    expect(rows.map((r) => r.person_id)).toEqual(["fpl:code:1"]);
  });

  it("filters by competition", async () => {
    const { sqlite, env } = fixture();
    add(sqlite, 1, "2024-25", 900);
    add(sqlite, 2, "2024-25", 900, { competition: "CL" });
    expect((await playerChoices(env, NEW, { seasons: ["2024-25"] })).map((r) => r.person_id)).toEqual(["fpl:code:1"]);
    expect((await playerChoices(env, NEW, { seasons: ["2024-25"], competition: "CL" })).map((r) => r.person_id)).toEqual(["fpl:code:2"]);
  });

  it("omits players with no minutes", async () => {
    const { sqlite, env } = fixture();
    add(sqlite, 1, "2024-25", 0);
    expect(await playerChoices(env, NEW, { seasons: ["2024-25"] })).toEqual([]);
  });

  it("returns [] for empty seasons without querying", async () => {
    const { env, reads } = fixture();
    expect(await playerChoices(env, NEW, { seasons: [] })).toEqual([]);
    expect(reads).toHaveLength(0);
  });

  it("rejects malformed seasons", async () => {
    const { env } = fixture();
    await expect(playerChoices(env, NEW, { seasons: ["x' OR 1=1"] })).rejects.toThrow();
  });

  it("reads the given snapshot only", async () => {
    const { sqlite, env } = fixture();
    add(sqlite, 1, "2024-25", 900, { snapshot: OLD });
    add(sqlite, 2, "2024-25", 100, { snapshot: NEW });
    const rows = await playerChoices(env, NEW, { seasons: ["2024-25"] });
    expect(rows.map((r) => r.person_id)).toEqual(["fpl:code:2"]);
    expect((await playerChoices(env, OLD, { seasons: ["2024-25"] })).map((r) => r.person_id)).toEqual(["fpl:code:1"]);
  });

  it("rejects an invalid snapshot id", async () => {
    const { env, reads } = fixture();
    await expect(playerChoices(env, "nope", { seasons: ["2024-25"] })).rejects.toThrow();
    expect(reads).toHaveLength(0);
  });

  it("uses an index on player_season_stats (no full scan)", async () => {
    const { sqlite, env, reads } = fixture();
    add(sqlite, 1, "2024-25", 900);
    await playerChoices(env, NEW, { seasons: ["2024-25"] });
    const { sql, values } = reads[0]!;
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values).map((r) => String(r.detail));
    expect(plan.some((l) => /^SEARCH s USING (COVERING )?INDEX /.test(l)), plan.join("\n")).toBe(true);
    expect(plan.some((l) => l.startsWith("SCAN ")), plan.join("\n")).toBe(false);
    expect(sql).not.toMatch(/\bLIKE\b/i);
  });
});
