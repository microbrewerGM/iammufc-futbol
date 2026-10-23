import { describe, expect, it } from "vitest";
import { buildOpponentHistoryQuery, queryOpponentHistory, readOpponentHistory } from "../worker/src/core/opponent-history";

const seasons = ["2022-23", "2024-25", "2025-26"];
const request = { schema_version: 1, competition: "PL", seasons, group_by: "opponent", venue: null, opponent_id: "club:1001" } as const;
const catalog = { snapshot_id: "snapshot", seasons: seasons.map((season, i) => ({ season, coverage: i === 1 ? "partial" as const : i === 2 ? "missing" as const : "complete" as const })) };
const row = (season: string, venue: "home" | "away", won: number, drawn: number, lost: number, goals_for: number, goals_against: number) => ({ season, competition: "PL", venue, opponent_id: "club:1001", played: 1, won, drawn, lost, goals_for, goals_against, snapshot_id: "snapshot", lineage: ["source"] });
const run = (rows: unknown[] = [row(seasons[0]!, "home", 1, 0, 0, 2, 0), row(seasons[0]!, "away", 0, 0, 1, 1, 3), row(seasons[1]!, "home", 0, 1, 0, 0, 0)], req: unknown = request, cat: unknown = catalog) => queryOpponentHistory(req, cat, rows);

describe("opponent history query", () => {
  it("returns per-season and weighted combined totals while retaining missing seasons", () => {
    const result = run();
    expect(result.seasons.map(s => s.status)).toEqual(["available", "available", "missing_capability"]);
    expect(result.seasons[2]).not.toHaveProperty("record");
    expect(result.combined).toMatchObject({ played: 3, won: 1, drawn: 1, lost: 1, goals_for: 3, goals_against: 3, points: 4, goal_difference: 0, points_per_match: 4 / 3, win_rate: 1 / 3 });
    expect(result.partial).toBe(true);
    expect(result.status).toBe("partial");
  });
  it("keeps each empty coverage state distinct and makes combined coverage visible", () => {
    const result = run([]);
    expect(result.seasons.map(s => [s.coverage, s.status])).toEqual([["complete", "no_matches"], ["partial", "missing_capability"], ["missing", "missing_capability"]]);
    expect(result).not.toHaveProperty("combined");
    const partialOnly = run([row(seasons[1]!, "home", 0, 1, 0, 0, 0)]);
    expect(partialOnly.status).toBe("partial");
    expect(partialOnly.partial).toBe(true);
    const completeOnlyCatalog = { snapshot_id: "snapshot", seasons: [{ season: seasons[0], coverage: "complete" as const }] };
    const completeEmpty = run([], { ...request, seasons: [seasons[0]] }, completeOnlyCatalog);
    expect(completeEmpty.status).toBe("no_matches");
  });
  it("rejects unknown/self/gap IDs and closed-schema or invalid selections", () => {
    for (const opponent_id of ["club:9999", "club:1016", "club:1045", "club:1000"]) {
      expect(() => run([], { ...request, opponent_id })).toThrow("Invalid opponent history: opponent");
    }
    expect(() => run([], { ...request, free_text: "Arsenal" })).toThrow("Invalid opponent history: selection");
    expect(() => run([], { ...request, seasons: [...seasons, "2022-23"] })).toThrow("Invalid opponent history: selection");
    expect(() => run([], { ...request, seasons: ["2026-27"] })).toThrow("Invalid opponent history: selection");
    expect(() => run([], { ...request, venue: "neutral" })).toThrow("Invalid opponent history: selection");
    expect(() => run([], request, { ...catalog, seasons: [...catalog.seasons, catalog.seasons[0]] })).toThrow("Invalid opponent history: catalog");
  });
  it("rejects malformed rows, invalid lineage, missing contradictions, duplicate grains and snapshot changes", () => {
    expect(() => run([row(seasons[0]!, "home", 1, 0, 0, 2, 0), row(seasons[0]!, "home", 1, 0, 0, 2, 0)])).toThrow("duplicate grain");
    expect(() => run([{ ...row(seasons[0]!, "home", 1, 0, 0, 2, 0), snapshot_id: "other" }])).toThrow("snapshot or coverage");
    expect(() => run([{ ...row(seasons[0]!, "home", 1, 0, 0, 2, 0), lineage: ["source", "source"] }])).toThrow("lineage");
    expect(() => run([{ ...row(seasons[0]!, "home", 1, 0, 0, 2, 0), lineage: [""] }])).toThrow("lineage");
    expect(() => run([row(seasons[2]!, "home", 1, 0, 0, 2, 0)])).toThrow("snapshot or coverage");
    expect(() => run([row(seasons[0]!, "home", 1, 0, 0, 2, 0)], request, { ...catalog, snapshot_id: "other" })).toThrow("snapshot or coverage");
  });
  it("pins production SQL and bindings for both and venue-filtered reads", () => {
  const snapshotId = "a".repeat(64);
    const validCatalog = { ...catalog, snapshot_id: snapshotId };
    expect(buildOpponentHistoryQuery(request, validCatalog)).toEqual({
      sql: "SELECT snapshot_id, season, competition, venue, opponent_id, played, won, drawn, lost,\n            goals_for, goals_against, lineage_json\n       FROM season_splits WHERE snapshot_id = ? AND season IN (?,?,?) AND opponent_id = ?\n       ORDER BY season, venue, opponent_id LIMIT 4097",
      bindings: [snapshotId, ...seasons, "club:1001"],
    });
    expect(buildOpponentHistoryQuery({ ...request, venue: "home" }, validCatalog).bindings).toEqual([snapshotId, ...seasons, "home", "club:1001"]);
    expect(buildOpponentHistoryQuery({ ...request, venue: "home" }, validCatalog).sql).toContain("AND venue = ? AND opponent_id = ?");
    expect(() => buildOpponentHistoryQuery(request, catalog)).toThrow("query selection");
  });
  it("executes the exported bounded query using the catalog snapshot", async () => {
    const snapshotId = "a".repeat(64);
    const seen: { sql?: string; bindings?: unknown[] } = {};
    const dbRow = { ...row(seasons[0]!, "home", 1, 0, 0, 2, 0), snapshot_id: snapshotId };
    const env = { DB: { prepare(sql: string) { seen.sql = sql; return { bind(...bindings: unknown[]) { seen.bindings = bindings; return { all: async () => ({ results: [dbRow] }) }; } }; } } } as never;
    const result = await readOpponentHistory(env, request, { ...catalog, snapshot_id: snapshotId });
    expect(seen.bindings?.[0]).toBe(snapshotId);
    expect(seen.sql).toContain("LIMIT 4097");
    expect(result.snapshot_id).toBe(snapshotId);
  });
  it("rejects rows for a different requested opponent or venue", () => {
    expect(() => run([{ ...row(seasons[0]!, "home", 1, 0, 0, 2, 0), opponent_id: "club:1002" }])).toThrow("row dimensions differ from request");
    expect(() => run([row(seasons[0]!, "away", 1, 0, 0, 2, 0)], { ...request, venue: "home" })).toThrow("row dimensions differ from request");
  });
  it("rejects input bounds, unsafe counts and aggregate overflow", () => {
    expect(() => run(Array(4097).fill(null))).toThrow("row count");
    const invalidCounter = { ...row(seasons[0]!, "home", 1, 0, 0, 2, 0), goals_for: Number.MAX_SAFE_INTEGER + 1 };
    expect(() => run([invalidCounter])).toThrow("counter");
    const first = { ...row(seasons[0]!, "home", 1, 0, 0, 2, 0), goals_for: Number.MAX_SAFE_INTEGER - 1 };
    const second = { ...row(seasons[0]!, "away", 1, 0, 0, 2, 0), goals_for: Number.MAX_SAFE_INTEGER - 1 };
    expect(() => run([first, second])).toThrow("counter overflow");
  });
  it("accepts explicit approved IDs and preserves true zero values", () => {
    const zeroDraw = run([row(seasons[0]!, "home", 0, 1, 0, 0, 0)]);
    expect(zeroDraw.combined).toMatchObject({ played: 1, drawn: 1, goals_for: 0, goals_against: 0, points: 1 });
    expect(zeroDraw.seasons[0]?.record?.goals_for_per_match).toBe(0);
  });
  it("does not mutate input and is independent of source row order", () => {
    const input = [row(seasons[0]!, "home", 1, 0, 0, 2, 0), row(seasons[0]!, "away", 0, 0, 1, 1, 3)];
    const before = structuredClone(input);
    expect(run(input)).toEqual(run([...input].reverse()));
    expect(input).toEqual(before);
  });
});
