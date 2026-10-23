import { describe, expect, it } from "vitest";
import type { CoverageCell } from "../worker/src/core/feasibility";
import type { PlayerTrendsRequest } from "../worker/src/core/player-trends";
import { playerTrendsFacts, playerTrendsFactsSql, PLAYER_TRENDS_FACTS_SQL,
  PLAYER_TRENDS_MAX_FACTS, PLAYER_TRENDS_SNAPSHOT_SQL } from "../worker/src/core/player-trends-db";

const sqliteModuleName: string = "node:sqlite";
const { DatabaseSync } = await import(sqliteModuleName) as unknown as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...values: unknown[]): unknown; get(...values: unknown[]): unknown; all(...values: unknown[]): unknown[] };
  };
};

const snapshot = "a".repeat(64);
const people = ["fpl:code:10", "fpl:code:20"];
const seasons = ["2023-24", "2024-25"];
const request: PlayerTrendsRequest = { schema_version: 1, competition: "PL", person_ids: people,
  seasons, metric: "goals", normalization: "per90", min_minutes: 450, viz: "line" };

function coverage(season: string, metric: string): CoverageCell & { feasibility: string } {
  return { metric, entity_type: "player", granularity: "box_score", season, competition: "PL", feasibility: "available",
    source_id: "fpl", redistributable: true, cost_class: "cheap", attribution_asset: "fpl_credit",
    attribution_text: "credit", attribution_text_es: "crédito", source_name: "FPL" };
}

function store(latest = snapshot): { sqlite: InstanceType<typeof DatabaseSync>; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE snapshots(snapshot_id TEXT PRIMARY KEY);
    CREATE TABLE publication_runs(run_id INTEGER PRIMARY KEY, snapshot_id TEXT NOT NULL);
    CREATE TABLE players(player_id TEXT PRIMARY KEY);
    CREATE TABLE player_identities(player_id TEXT PRIMARY KEY, person_id TEXT, season TEXT);
    CREATE TABLE player_season_stats(player_id TEXT, season TEXT, competition TEXT, goals INTEGER,
      assists INTEGER, minutes INTEGER, snapshot_id TEXT, PRIMARY KEY(player_id,season,competition));`);
  sqlite.prepare("INSERT INTO snapshots VALUES (?)").run(snapshot);
  sqlite.prepare("INSERT INTO publication_runs VALUES (1, ?)").run(latest);
  const db = { prepare(sql: string) {
    let bound: unknown[] = [];
    const statement = { bind(...values: unknown[]) { bound = values; return statement; },
      first: async <T,>() => (sqlite.prepare(sql).get(...bound) ?? null) as T | null,
      all: async <T,>() => ({ results: sqlite.prepare(sql).all(...bound) as T[] }) };
    return statement;
  } } as unknown as D1Database;
  return { sqlite, db };
}

function add(data: ReturnType<typeof store>, id: string, season: string, goals: number, minutes: number) {
  const playerId = `${id}/${season}`;
  data.sqlite.prepare("INSERT INTO players VALUES (?)").run(playerId);
  data.sqlite.prepare("INSERT INTO player_identities VALUES (?,?,?)").run(playerId, id, season);
  data.sqlite.prepare("INSERT INTO player_season_stats VALUES (?,?,'PL',?,0,?,?)")
    .run(playerId, season, goals, minutes, snapshot);
}

const allCoverage = seasons.flatMap((season) => [coverage(season, "goals"), coverage(season, "minutes")]);

describe("player trends D1 read", () => {
  it("pins parameterized SQL and read bounds", () => {
    expect(PLAYER_TRENDS_SNAPSHOT_SQL).toContain("ORDER BY r.run_id DESC LIMIT 1");
    expect(PLAYER_TRENDS_FACTS_SQL).toContain("AND i.season = s.season");
    expect(PLAYER_TRENDS_FACTS_SQL).toContain("s.competition = 'PL' AND s.snapshot_id = ?");
    expect(PLAYER_TRENDS_FACTS_SQL).toContain("LIMIT 41");
    expect(playerTrendsFactsSql(2, 2)).toBe(`SELECT i.person_id, s.season, s.competition,
  s.goals, s.assists, s.minutes, s.snapshot_id
  FROM player_season_stats s JOIN player_identities i ON i.player_id = s.player_id
  WHERE i.person_id IN (?,?) AND s.season IN (?,?) AND i.season = s.season
    AND s.competition = 'PL' AND s.snapshot_id = ?
  ORDER BY i.person_id, s.season LIMIT 41`);
    expect(PLAYER_TRENDS_MAX_FACTS).toBe(40);
  });

  it("reads only selected catalog cells with lineage and leaves absent facts absent", async () => {
    const data = store();
    add(data, people[0]!, seasons[0]!, 2, 900);
    add(data, people[1]!, seasons[1]!, 4, 1200);
    const rows = await playerTrendsFacts(data.db, request, snapshot, people, seasons, allCoverage);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.person_id, row.season])).toEqual([
      [people[0], seasons[0]], [people[1], seasons[1]],
    ]);
    expect(rows[0]!.lineage).toEqual(["fpl:fpl_credit"]);
  });

  it("rejects stale snapshots and unusable metric or minutes coverage", async () => {
    await expect(playerTrendsFacts(store("b".repeat(64)).db, request, snapshot, people, seasons, allCoverage))
      .rejects.toThrow("stale player trends publication");
    const missingMinutes = allCoverage.filter((cell) => !(cell.season === seasons[1] && cell.metric === "minutes"));
    await expect(playerTrendsFacts(store().db, request, snapshot, people, seasons, missingMinutes))
      .rejects.toThrow("coverage or rights unavailable");
  });

  it("reads the full 5×8 maximum without truncation", async () => {
    const many = store();
    const ids = Array.from({ length: 5 }, (_, index) => `fpl:code:${200 + index}`);
    const manyRequest = { ...request, person_ids: ids, seasons: Array.from({ length: 8 }, (_, i) => `${2010 + i}-${String((11 + i) % 100).padStart(2, "0")}`) };
    many.sqlite.prepare("UPDATE publication_runs SET snapshot_id=?").run(snapshot);
    const manyCoverage = manyRequest.seasons.flatMap((season) => [coverage(season, "goals"), coverage(season, "minutes")]);
    for (const id of ids) for (const season of manyRequest.seasons) {
      many.sqlite.prepare("INSERT INTO players VALUES (?)").run(`${id}/${season}`);
      many.sqlite.prepare("INSERT INTO player_identities VALUES (?,?,?)").run(`${id}/${season}`, id, season);
      many.sqlite.prepare("INSERT INTO player_season_stats VALUES (?,?,'PL',1,0,90,?)").run(`${id}/${season}`, season, snapshot);
    }
    await expect(playerTrendsFacts(many.db, manyRequest, snapshot, ids, manyRequest.seasons, manyCoverage))
      .resolves.toHaveLength(PLAYER_TRENDS_MAX_FACTS);
  });

  it("rejects infeasible coverage and invalid or unordered seasons", async () => {
    const infeasible = allCoverage.map((cell) => cell.metric === "goals" && cell.season === seasons[0] ? { ...cell, feasibility: "no_data" } : cell);
    await expect(playerTrendsFacts(store().db, request, snapshot, people, seasons, infeasible)).rejects.toThrow("coverage or rights unavailable");
    await expect(playerTrendsFacts(store().db, { ...request, seasons: ["2023-25"] }, snapshot, people, seasons, allCoverage)).rejects.toThrow("invalid player trends read");
    await expect(playerTrendsFacts(store().db, { ...request, seasons: [...seasons].reverse() }, snapshot, people, seasons, allCoverage)).rejects.toThrow("invalid player trends read");
  });

  it("rejects overflow sentinel, duplicate facts, and invalid counters", async () => {
    const overflow = store();
    const ids = people;
    for (let i = 0; i < 41; i++) {
      const playerId = `duplicate-${i}`;
      overflow.sqlite.prepare("INSERT INTO players VALUES (?)").run(playerId);
      overflow.sqlite.prepare("INSERT INTO player_identities VALUES (?,?,?)").run(playerId, ids[0], seasons[0]);
      overflow.sqlite.prepare("INSERT INTO player_season_stats VALUES (?,?,'PL',1,0,90,?)").run(playerId, seasons[0], snapshot);
    }
    await expect(playerTrendsFacts(overflow.db, { ...request, person_ids: ids.slice(0, 1), seasons: [seasons[0]!] }, snapshot, ids, [seasons[0]!], [coverage(seasons[0]!, "goals"), coverage(seasons[0]!, "minutes")])).rejects.toThrow("fact bound reached");

    const duplicate = store(); add(duplicate, people[0]!, seasons[0]!, 1, 90);
    const dupId = `${people[0]}/duplicate`;
    duplicate.sqlite.prepare("INSERT INTO players VALUES (?)").run(dupId);
    duplicate.sqlite.prepare("INSERT INTO player_identities VALUES (?,?,?)").run(dupId, people[0], seasons[0]);
    duplicate.sqlite.prepare("INSERT INTO player_season_stats VALUES (?,?,'PL',1,0,90,?)").run(dupId, seasons[0], snapshot);
    await expect(playerTrendsFacts(duplicate.db, request, snapshot, people, seasons, allCoverage)).rejects.toThrow("duplicate player trends fact");

    const invalid = store(); add(invalid, people[0]!, seasons[0]!, -1, 90);
    await expect(playerTrendsFacts(invalid.db, request, snapshot, people, seasons, allCoverage)).rejects.toThrow("invalid player trends counter");
  });
});
