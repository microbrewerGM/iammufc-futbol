import { describe, expect, it } from "vitest";
import { seasonSplitFacts, type Env } from "../worker/src/core/db";

const sqliteModuleName: string = "node:sqlite";
const { DatabaseSync } = await import(sqliteModuleName) as unknown as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...values: unknown[]): unknown;
      get(...values: unknown[]): unknown;
      all(...values: unknown[]): unknown[];
    };
  };
};

const snapshotA = "a".repeat(64);
const snapshotB = "b".repeat(64);
const seasons = ["2023-24", "2024-25"];

function fakeD1(latest = snapshotA) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE snapshots (snapshot_id TEXT PRIMARY KEY);
    CREATE TABLE publication_runs (run_id INTEGER PRIMARY KEY, snapshot_id TEXT NOT NULL);
    CREATE TABLE season_stats (snapshot_id TEXT, season TEXT, competition TEXT, played INTEGER);
    CREATE TABLE season_splits (
      snapshot_id TEXT, season TEXT, competition TEXT, venue TEXT, opponent_id TEXT,
      played INTEGER, won INTEGER, drawn INTEGER, lost INTEGER, goals_for INTEGER,
      goals_against INTEGER, lineage_json TEXT
    );
  `);
  sqlite.prepare("INSERT INTO snapshots VALUES (?)").run(snapshotA);
  sqlite.prepare("INSERT INTO snapshots VALUES (?)").run(snapshotB);
  sqlite.prepare("INSERT INTO publication_runs VALUES (1, ?)").run(latest);
  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const statement = {
      bind: (...values: unknown[]) => { bound = values; return statement; },
      first: async <T,>() => (sqlite.prepare(sql).get(...bound) ?? null) as T | null,
      all: async <T,>() => ({ results: sqlite.prepare(sql).all(...bound) as T[] }),
      run: async () => sqlite.prepare(sql).run(...bound),
    };
    return statement;
  };
  return { sqlite, db: { prepare } };
}

function addSeason(store: ReturnType<typeof fakeD1>, season: string, played: number, rows = played) {
  store.sqlite.prepare("INSERT INTO season_stats VALUES (?, ?, 'PL', ?)").run(snapshotA, season, played);
  const insert = store.sqlite.prepare(`INSERT INTO season_splits VALUES (?, ?, 'PL', ?, ?, 1, 1, 0, 0, 2, 0, '["football_data_couk"]')`);
  for (let i = 0; i < rows; i++) insert.run(snapshotA, season, i % 2 ? "away" : "home", `club:${i + 1}`);
}
const envFor = (db: ReturnType<typeof fakeD1>["db"]) => ({ DB: db, CFG: {} }) as unknown as Env;

describe("season split D1 publication facts", () => {
  it("marks only reconciled, catalog-covered seasons complete", async () => {
    const store = fakeD1();
    addSeason(store, seasons[0]!, 3, 2); // Partial: aggregate matches do not reconcile.
    addSeason(store, seasons[1]!, 2, 2);
    const facts = await seasonSplitFacts(envFor(store.db), snapshotA, seasons, seasons.map((season) => ({ season, coverage: "complete" as const })));
    expect(facts.catalog).toEqual({ snapshot_id: snapshotA, seasons: [
      { season: seasons[0], coverage: "missing" }, { season: seasons[1], coverage: "complete" },
    ] });
  });

  it("binds reads to the validated publication snapshot and rejects a mismatch", async () => {
    const store = fakeD1(snapshotB);
    await expect(seasonSplitFacts(envFor(store.db), snapshotA, [seasons[1]!], [{ season: seasons[1]!, coverage: "complete" }]))
      .rejects.toThrow("stale season split publication");
  });

  it("contains malformed lineage to its own season", async () => {
    const store = fakeD1();
    addSeason(store, seasons[0]!, 1);
    addSeason(store, seasons[1]!, 1);
    store.sqlite.prepare("UPDATE season_splits SET lineage_json = 'not-json' WHERE season = ?").run(seasons[0]!);
    const facts = await seasonSplitFacts(envFor(store.db), snapshotA, seasons, seasons.map((season) => ({ season, coverage: "complete" as const })));
    expect(facts.catalog.seasons).toEqual([
      { season: seasons[0], coverage: "missing" }, { season: seasons[1], coverage: "complete" },
    ]);
    expect(facts.rows.map((row) => row.season)).toEqual([seasons[1]]);
  });

  it("detects bad lineage even when dimension filters hide its row", async () => {
    const store = fakeD1();
    addSeason(store, seasons[1]!, 2, 2);
    store.sqlite.prepare("UPDATE season_splits SET lineage_json = 'not-json' WHERE venue = 'home'").run();
    const facts = await seasonSplitFacts(envFor(store.db), snapshotA, [seasons[1]!], [{ season: seasons[1]!, coverage: "complete" }], { venue: "away", opponent_id: null });
    expect(facts.catalog.seasons).toEqual([{ season: seasons[1]!, coverage: "missing" }]);
    expect(facts.rows).toHaveLength(1);
  });

  it("pushes dimensions and the selection bound into the SQL read", async () => {
    const store = fakeD1();
    addSeason(store, seasons[1]!, 2, 2);
    const facts = await seasonSplitFacts(envFor(store.db), snapshotA, [seasons[1]!], [{ season: seasons[1]!, coverage: "complete" }], { venue: "home", opponent_id: null });
    expect(facts.rows).toHaveLength(1);
    const oversized = fakeD1();
    addSeason(oversized, seasons[1]!, 4097, 4097);
    await expect(seasonSplitFacts(envFor(oversized.db), snapshotA, [seasons[1]!], [{ season: seasons[1]!, coverage: "complete" }]))
      .rejects.toThrow("season split read bound reached");
  });
});
