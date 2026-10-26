import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error Node built-ins are available in the configured test runtime.
import { readFileSync, readdirSync } from "node:fs";
import { playerCareerRows, resolvePlayerIdentity, seasonSquadRows, type Env } from "../worker/src/core/db";
import { playerTrendsFactsSql, PLAYER_TRENDS_SNAPSHOT_SQL } from "../worker/src/core/player-trends-db";

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
type Read = { sql: string; values: unknown[]; plan: string[] };
const stores: Sqlite[] = [];
const snapshot = "a".repeat(64);

afterEach(() => { for (const db of stores.splice(0)) db.close(); });

function explain(db: Sqlite, sql: string, values: unknown[]): string[] {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values).map((row) => String(row.detail));
}

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  stores.push(sqlite);
  // Schema only: the generated data seed is neither read nor needed.
  for (const name of readdirSync("infra/migrations").filter((name: string) => name.endsWith(".sql") && name !== "0002_seed.sql").sort()) {
    sqlite.exec(readFileSync(`infra/migrations/${name}`, "utf8"));
  }
  sqlite.prepare("INSERT INTO snapshots VALUES (?, '2026-01-01', '{}', '{}')").run(snapshot);
  sqlite.prepare("INSERT INTO publication_runs(snapshot_id, prepared_at, source_status_json) VALUES (?, '', '{}')").run(snapshot);
  for (const code of [10, 20]) for (const season of ["2023-24", "2024-25"]) {
    const player = `fpl:${code}:${season}`;
    sqlite.prepare("INSERT INTO players VALUES (?, ?, ?, ?, '', '', 'MID', 'MUN')").run(player, code, season, `Player ${code}`);
    sqlite.prepare("INSERT INTO player_identities VALUES (?, ?, 'fpl', ?, ?)").run(player, `fpl:code:${code}`, code, season);
    sqlite.prepare(`INSERT INTO player_season_stats(player_id, season, competition, goals, minutes, snapshot_id)
      VALUES (?, ?, 'PL', 2, 900, ?)`).run(player, season, snapshot);
  }
  const reads: Read[] = [];
  const env = { DB: { prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind(...bound: unknown[]) { values = bound; return statement; },
      async all() {
        reads.push({ sql, values, plan: explain(sqlite, sql, values) });
        return { results: sqlite.prepare(sql).all(...values) };
      },
    };
    return statement;
  } } } as unknown as Env;
  return { sqlite, env, reads };
}

function search(plan: string[], tableAlias: string, index: string) {
  // Assert the indexed SEARCH and its exact index name, without pinning plan ids,
  // estimates, join order, covering status or the entire SQLite-version-specific text.
  expect(plan.some((line) => line.startsWith(`SEARCH ${tableAlias} `) && line.includes(" USING ") &&
    line.split(" ").includes(index)), plan.join("\n")).toBe(true);
}

describe("hot D1 read plans against committed migrations (local SQLite diagnostics)", () => {
  it.each([[1, 1], [5, 8]])("indexes trend facts at %i people and %i seasons", (personCount, seasonCount) => {
    const { sqlite } = fixture();
    const people = Array.from({ length: personCount }, (_, i) => `fpl:code:${10 + i}`);
    const seasons = Array.from({ length: seasonCount }, (_, i) => `${2017 + i}-${18 + i}`);
    const plan = explain(sqlite, playerTrendsFactsSql(personCount, seasonCount), [...people, ...seasons, snapshot]);
    search(plan, "i", "sqlite_autoindex_player_identities_2");
    search(plan, "s", "sqlite_autoindex_player_season_stats_1");
  });

  it("indexes the snapshot side of the latest-publication join", () => {
    const { sqlite } = fixture();
    const plan = explain(sqlite, PLAYER_TRENDS_SNAPSHOT_SQL, []);
    search(plan, "s", "sqlite_autoindex_snapshots_1");
    // publication_runs uses reverse INTEGER PRIMARY KEY traversal with LIMIT 1;
    // SQLite calls that SCAN r. It is not a missing-index failure.
    expect(plan.some((line) => line.includes("TEMP B-TREE"))).toBe(false);
  });

  it("executes the real exact-identity branch with an indexed person lookup", async () => {
    const { env, reads } = fixture();
    await expect(resolvePlayerIdentity(env, "fpl:code:10")).resolves.toEqual({ person_id: "fpl:code:10", web_name: "Player 10" });
    expect(reads).toHaveLength(1);
    expect(reads[0]!.values).toEqual(["fpl:code:10", "PL"]);
    search(reads[0]!.plan, "i", "idx_player_identities_person");
    search(reads[0]!.plan, "p", "sqlite_autoindex_players_1");
    search(reads[0]!.plan, "s", "sqlite_autoindex_player_season_stats_1");
  });

  it("executes the real career read with indexed identity and fact joins", async () => {
    const { env, reads } = fixture();
    await expect(playerCareerRows(env, "fpl:code:10")).resolves.toHaveLength(2);
    expect(reads).toHaveLength(2);
    expect(reads[1]!.values).toEqual(["PL", "fpl:code:10"]);
    search(reads[1]!.plan, "i", "idx_player_identities_person");
    search(reads[1]!.plan, "s", "sqlite_autoindex_player_season_stats_1");
  });

  it("executes the real squad read with an indexed season filter", async () => {
    const { env, reads } = fixture();
    await expect(seasonSquadRows(env, "2024-25")).resolves.toHaveLength(2);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.values).toEqual(["2024-25", "PL"]);
    search(reads[0]!.plan, "p", "idx_players_season");
    search(reads[0]!.plan, "s", "sqlite_autoindex_player_season_stats_1");
  });
});
