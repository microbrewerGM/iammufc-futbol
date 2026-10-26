import { describe, expect, it } from "vitest";
import { seasonSplitFacts, type Env } from "../worker/src/core/db";
import { APPROVED_OPPONENT_IDS, queryOpponentHistory, readOpponentHistory } from "../worker/src/core/opponent-history";
import { parseSeasonSplitRequest } from "../worker/src/core/season-splits";
import { page } from "../worker/src/views/layout";
import { LOCALES } from "../worker/src/core/locale";
import compiled from "../worker/src/generated/catalog.json";

const sqliteModuleName: string = "node:sqlite";
const { DatabaseSync } = await import(sqliteModuleName) as unknown as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    close(): void;
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
  for (let i = 0; i < rows; i++) insert.run(snapshotA, season, i % 2 ? "away" : "home", `club:${1001 + i}`);
}
const envFor = (db: ReturnType<typeof fakeD1>["db"]) => ({ DB: db, CFG: {} }) as unknown as Env;


const request = { schema_version: 1 as const, competition: "PL" as const, seasons,
  group_by: "opponent" as const, venue: null, opponent_id: "club:1001" };

describe("season split hardening", () => {
  it.each(["openfootball_cl", "unknown-source"])("withholds uncredited %s lineage only in its season", async (source) => {
    const store = fakeD1();
    try {
      seasons.forEach(season => addSeason(store, season, 1));
      store.sqlite.prepare("UPDATE season_splits SET lineage_json = ? WHERE season = ?")
        .run(JSON.stringify([source]), seasons[0]!);
      const facts = await seasonSplitFacts(envFor(store.db), snapshotA, seasons);
      expect(facts.catalog.seasons.map(s => s.coverage)).toEqual(["missing", "complete"]);
      expect(facts.rows.map(r => r.season)).toEqual([seasons[1]]);
    } finally { store.sqlite.close(); }
  });

  it.each(["football_data_couk", "fpl"])("retains credited %s lineage", async (source) => {
    const store = fakeD1();
    try {
      addSeason(store, seasons[0]!, 1);
      store.sqlite.prepare("UPDATE season_splits SET lineage_json = ?").run(JSON.stringify([source]));
      const facts = await seasonSplitFacts(envFor(store.db), snapshotA, [seasons[0]!]);
      expect(facts.catalog.seasons[0]?.coverage).toBe("complete");
      expect(facts.rows[0]?.lineage).toEqual([source]);
      expect(compiled.coverage.some(cell => cell.source_id === source && (cell.attribution_text || cell.source_name) && (cell.attribution_text_es || cell.attribution_text || cell.source_name))).toBe(true);
    } finally { store.sqlite.close(); }
  });

  it("does not reread a withheld bad-lineage season into the opponent total", async () => {
    const store = fakeD1();
    try {
      seasons.forEach(season => addSeason(store, season, 1));
      store.sqlite.prepare("UPDATE season_splits SET lineage_json = 'not-json' WHERE season = ?").run(seasons[0]!);
      const facts = await seasonSplitFacts(envFor(store.db), snapshotA, seasons);
      const result = await readOpponentHistory(envFor(store.db), request, facts.catalog);
      expect(result.status).toBe("partial");
      expect(result.seasons[0]).toEqual({ season: seasons[0], coverage: "missing", status: "missing_capability" });
      expect(result.combined).toMatchObject({ played: 1, points: 3, lineage: ["football_data_couk"] });
      expect(result.contributing_seasons).toEqual([seasons[1]]);
    } finally { store.sqlite.close(); }
  });

  it("retains strict rejection of malformed published rows", async () => {
    const store = fakeD1();
    try {
      addSeason(store, seasons[0]!, 1);
      const catalog = { snapshot_id: snapshotA, seasons: [{ season: seasons[0]!, coverage: "complete" as const }] };
      store.sqlite.prepare("UPDATE season_splits SET lineage_json = 'not-json'").run();
      await expect(readOpponentHistory(envFor(store.db), { ...request, seasons: [seasons[0]!] }, catalog)).rejects.toThrow("lineage");
      expect(() => queryOpponentHistory(request, { snapshot_id: snapshotA, seasons: seasons.map(season => ({ season, coverage: "missing" as const })) }, [{}])).toThrow();
    } finally { store.sqlite.close(); }
  });

  it.each([
    { snapshot_id: snapshotB }, { season: "2022-23" }, { opponent_id: "club:1002" },
    { competition: "CL" }, { venue: "neutral" },
  ])("does not hide identity corruption in withheld rows: %j", async (delta) => {
    const row = { snapshot_id: snapshotA, season: seasons[0], opponent_id: "club:1001",
      competition: "PL", venue: "home", lineage_json: "not-json", ...delta };
    const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [row] }) }) }) } } as unknown as Env;
    const catalog = { snapshot_id: snapshotA, seasons: seasons.map(season => ({ season, coverage: "missing" as const })) };
    await expect(readOpponentHistory(env, request, catalog)).rejects.toThrow("Invalid opponent history");
  });

  it("checks the raw row bound before omitting withheld rows", async () => {
    const row = { snapshot_id: snapshotA, season: seasons[0], opponent_id: "club:1001",
      competition: "PL", venue: "home", lineage_json: "not-json" };
    const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: Array(4097).fill(row) }) }) }) } } as unknown as Env;
    const catalog = { snapshot_id: snapshotA, seasons: seasons.map(season => ({ season, coverage: "missing" as const })) };
    await expect(readOpponentHistory(env, request, catalog)).rejects.toThrow("row count");
  });

  it.each(["en", "es"] as const)("provides valid explicit %s navigation selections", (code) => {
    const markup = page("", { title: "test", locale: LOCALES[code], unprefixedPath: "/" });
    for (const path of ["opponents/history", "seasons/explore"]) {
      const match = markup.match(new RegExp(`href="(/${code}/${path}[^\"]*)"`));
      expect(match).not.toBeNull();
      const url = new URL(match![1]!.replaceAll("&amp;", "&"), "https://site.invalid");
      const params = url.searchParams;
      const selected = params.getAll("seasons");
      const known = [...new Set(compiled.coverage.filter(c => c.competition === "PL").map(c => c.season))];
      const opponent = params.get("opponent_id");
      const parsed = parseSeasonSplitRequest({ schema_version: 1, competition: "PL", seasons: selected,
        group_by: path === "opponents/history" ? "opponent" : params.get("group_by") ?? "venue",
        venue: null, opponent_id: opponent }, known);
      expect(parsed.seasons).toHaveLength(1);
      if (path === "opponents/history") expect(APPROVED_OPPONENT_IDS.has(opponent!)).toBe(true);
    }
  });
});
