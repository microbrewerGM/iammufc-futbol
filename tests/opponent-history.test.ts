import { describe, expect, it } from "vitest";
import { queryOpponentHistory } from "../worker/src/core/opponent-history";

const seasons = ["2022-23", "2024-25", "2025-26"];
const request = { schema_version: 1, competition: "PL", seasons, group_by: "opponent", venue: null, opponent_id: "club:1001" } as const;
const catalog = { snapshot_id: "snapshot", seasons: seasons.map((season, i) => ({ season, coverage: i === 1 ? "partial" as const : i === 2 ? "missing" as const : "complete" as const })) };
const row = (season: string, venue: "home" | "away", won: number, drawn: number, lost: number, goals_for: number, goals_against: number) => ({ season, competition: "PL", venue, opponent_id: "club:1001", played: 1, won, drawn, lost, goals_for, goals_against, snapshot_id: "snapshot", lineage: ["source"] });
const run = (rows: unknown[] = [row(seasons[0]!, "home", 1, 0, 0, 2, 0), row(seasons[0]!, "away", 0, 0, 1, 1, 3), row(seasons[1]!, "home", 0, 1, 0, 0, 0)]) => queryOpponentHistory(request, catalog, rows);

describe("opponent history query", () => {
  it("returns per-season and weighted combined totals while retaining missing seasons", () => {
    const result = run();
    expect(result.seasons.map(s => s.status)).toEqual(["available", "available", "missing_capability"]);
    expect(result.seasons[2]).not.toHaveProperty("record");
    expect(result.combined).toMatchObject({ played: 3, won: 1, drawn: 1, lost: 1, goals_for: 3, goals_against: 3, points: 4, goal_difference: 0, points_per_match: 4 / 3, win_rate: 1 / 3 });
    expect(result.partial).toBe(true);
  });
  it("keeps complete empty distinct from missing empty", () => {
    const result = run([]);
    expect(result.seasons.map(s => s.status)).toEqual(["no_matches", "missing_capability", "missing_capability"]);
    expect(result).not.toHaveProperty("combined");
  });
  it("rejects unknown and self IDs and malformed or duplicate grains", () => {
    expect(() => queryOpponentHistory({ ...request, opponent_id: "club:9999" }, catalog, [])).toThrow("Invalid opponent history: opponent");
    expect(() => queryOpponentHistory({ ...request, opponent_id: "club:1016" }, catalog, [])).toThrow("Invalid opponent history: opponent");
    expect(() => run([row(seasons[0]!, "home", 1, 0, 0, 2, 0), row(seasons[0]!, "home", 1, 0, 0, 2, 0)])).toThrow("duplicate grain");
    expect(() => run([row(seasons[2]!, "home", 1, 0, 0, 2, 0)])).toThrow("snapshot or coverage");
  });
  it("pins the upstream SQL and exact parameter bindings", () => {
    const seasonsSql = seasons.map(() => "?").join(",");
    const sql = `SELECT snapshot_id, season, competition, venue, opponent_id, played, won, drawn, lost,\n            goals_for, goals_against, lineage_json\n       FROM season_splits WHERE snapshot_id = ? AND season IN (${seasonsSql})\n       ORDER BY season, venue, opponent_id LIMIT 4097`;
    expect(sql).toBe("SELECT snapshot_id, season, competition, venue, opponent_id, played, won, drawn, lost,\n            goals_for, goals_against, lineage_json\n       FROM season_splits WHERE snapshot_id = ? AND season IN (?,?,?)\n       ORDER BY season, venue, opponent_id LIMIT 4097");
    expect([catalog.snapshot_id, ...seasons, null, "club:1001"]).toEqual(["snapshot", "2022-23", "2024-25", "2025-26", null, "club:1001"]);
  });
  it("accepts only approved stable IDs and preserves true zero values", () => {
    expect(() => queryOpponentHistory({ ...request, opponent_id: "club:1045" }, catalog, [])).toThrow("Invalid opponent history: opponent");
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
