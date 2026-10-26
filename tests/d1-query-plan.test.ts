import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error Node built-ins are available in the configured test runtime.
import { readFileSync, readdirSync } from "node:fs";
import { playerCareerRows, resolvePlayerIdentity, runQuery, seasonSquadRows, type Env } from "../worker/src/core/db";
import { playerTrendsFacts, PLAYER_TRENDS_SNAPSHOT_SQL } from "../worker/src/core/player-trends-db";

import { withDefaults } from "../worker/src/core/intent";
import type { CoverageCell } from "../worker/src/core/feasibility";

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
      async first() {
        reads.push({ sql, values, plan: explain(sqlite, sql, values) });
        return sqlite.prepare(sql).all(...values)[0] ?? null;
      },
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
  it.each([[1, 1], [5, 8]])("executes indexed trend facts at %i people and %i seasons", async (personCount, seasonCount) => {
    const { env, reads } = fixture();
    const people = Array.from({ length: personCount }, (_, i) => `fpl:code:${10 + i * 10}`);
    const seasons = Array.from({ length: seasonCount }, (_, i) => `${2025 - seasonCount + i}-${26 - seasonCount + i}`);
    const coverage: Array<CoverageCell & { feasibility: string }> = seasons.flatMap((season) =>
      ["goals", "minutes"].map((metric) => ({ metric, season, entity_type: "player", granularity: "box_score",
        competition: "PL", source_id: "fpl", redistributable: true, cost_class: "cheap",
        feasibility: "available", attribution_asset: "fpl_credit", attribution_text: "FPL", attribution_text_es: "FPL", source_name: "FPL" })));
    const rows = await playerTrendsFacts(env.DB, { schema_version: 1, competition: "PL", person_ids: people,
      seasons, metric: "goals", normalization: "per90", min_minutes: 450, viz: "line" },
    snapshot, people, seasons, coverage);
    expect(rows).toHaveLength(seasonCount === 1 ? 1 : 4);
    expect(reads).toHaveLength(4);
    const facts = reads[1]!;
    expect(facts.values).toEqual([...people, ...seasons, snapshot]);
    search(facts.plan, "i", "sqlite_autoindex_player_identities_2");
    search(facts.plan, "s", "sqlite_autoindex_player_season_stats_1");
    for (const publication of [reads[0]!, reads[2]!, reads[3]!]) {
      expect(publication.sql).toBe(PLAYER_TRENDS_SNAPSHOT_SQL);
      search(publication.plan, "s", "sqlite_autoindex_snapshots_1");
    }
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

  it("executes the ask leaderboard through indexed season and fact joins", async () => {
    const { env, reads } = fixture();
    const result = await runQuery(env, withDefaults({ metric: "goals", entity_type: "player",
      entity_id: "all", season: "2024-25", competition: "PL", limit: 1 }), snapshot);
    expect(result.snapshot_id).toBe(snapshot);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.value).toBe(2);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.values).toEqual(["2024-25", "PL", 1]);
    search(reads[0]!.plan, "p", "idx_players_season");
    search(reads[0]!.plan, "s", "sqlite_autoindex_player_season_stats_1");
    search(reads[0]!.plan, "i", "sqlite_autoindex_player_identities_1");
  });

  it("keeps an empty ask season empty while using the indexed leaderboard read", async () => {
    const { env, reads } = fixture();
    const result = await runQuery(env, withDefaults({ metric: "goals", entity_type: "player",
      entity_id: "all", season: "2022-23", competition: "PL" }), snapshot);
    expect(result).toEqual({ rows: [], snapshot_id: snapshot, unit: "goals" });
    expect(reads).toHaveLength(1);
    expect(reads[0]!.values).toEqual(["2022-23", "PL", 10]);
    search(reads[0]!.plan, "p", "idx_players_season");
  });

  it.each(["fpl:code:10", "Player 10"])("executes the named ask read for %s", async (entityId) => {
    const { env, reads } = fixture();
    const result = await runQuery(env, withDefaults({ metric: "goals", entity_type: "player",
      entity_id: entityId, season: "2024-25", competition: "PL" }), snapshot);
    expect(result.rows).toEqual([{ label: "Player 10", value: 2, secondary: "MID", route_key: "fpl:code:10" }]);
    expect(reads).toHaveLength(2);
    const facts = reads[1]!;
    expect(facts.values).toEqual(["2024-25", "PL", "fpl:code:10", 10]);
    search(facts.plan, "i", "sqlite_autoindex_player_identities_1");
    search(facts.plan, "p", "idx_players_season");
    search(facts.plan, "s", "sqlite_autoindex_player_season_stats_1");
    if (entityId === "Player 10") {
      // The normalized, leading-wildcard alias LIKE branch is an expected scan.
      // This diagnostic does not claim an alias index or hosted D1 latency gain.
      expect(reads[0]!.sql).toContain("LIKE '%' || ? || '%'");
      expect(reads[0]!.plan.some((line) => line.startsWith("SCAN ")), reads[0]!.plan.join("\n")).toBe(true);
      search(reads[0]!.plan, "p", "sqlite_autoindex_players_1");
      search(reads[0]!.plan, "i", "sqlite_autoindex_player_identities_1");
    } else {
      search(reads[0]!.plan, "i", "idx_player_identities_person");
    }
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
