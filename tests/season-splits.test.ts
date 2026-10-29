import { describe, expect, it } from "vitest";
import { parseSeasonSplitRequest, querySeasonSplits } from "../worker/src/core/season-splits";
import type { SeasonSplitCatalog, SeasonSplitRequest, SeasonSplitRow } from "../worker/src/core/season-splits";

const request: SeasonSplitRequest = { schema_version: 1, competition: "PL", seasons: ["2024-25"],
  group_by: "venue", venue: null, opponent_id: null };
const metadata: SeasonSplitCatalog = { snapshot_id: "synthetic-snapshot", seasons: [
  { season: "2024-25", coverage: "partial" }, { season: "2025-26", coverage: "missing" },
] };
const home: SeasonSplitRow = { season: "2024-25", competition: "PL", venue: "home", opponent_id: "club:1",
  played: 1, won: 1, drawn: 0, lost: 0, goals_for: 2, goals_against: 0,
  snapshot_id: "synthetic-snapshot", lineage: ["synthetic:home"] };
const away: SeasonSplitRow = { ...home, venue: "away", won: 0, lost: 1, goals_for: 1, goals_against: 3,
  lineage: ["synthetic:away"] };
const run = (rows: unknown = [home, away], req: unknown = request, cat: unknown = metadata) => querySeasonSplits(req, cat, rows);

describe("season split selection", () => {
  it("canonicalizes explicit selections without mutating the caller", () => {
    const input = { ...request, seasons: ["2025-26", "2024-25"] };
    expect(parseSeasonSplitRequest(input, metadata.seasons.map(s => s.season)).seasons).toEqual(["2024-25", "2025-26"]);
    expect(input.seasons).toEqual(["2025-26", "2024-25"]);
  });
  it.each([
    null, [], {}, { ...request, extra: true }, { ...request, schema_version: 2 },
    { ...request, competition: "CL" }, { ...request, group_by: "season" },
    { ...request, venue: "all" }, { ...request, opponent_id: "Manchester" },
    { ...request, opponent_id: "club:01" }, { ...request, opponent_id: "club:0" },
    { ...request, opponent_id: "club:1234567890123456789" },
    { ...request, seasons: [] }, { ...request, seasons: ["2024-25", "2024-25"] },
    { ...request, seasons: ["2024-26"] }, { ...request, seasons: ["2023-24"] },
    { ...request, seasons: "2024-25" }, { ...request, seasons: [2024] },
    { ...request, seasons: Array(17).fill("2024-25") },
  ])("rejects invalid request %#", value => expect(() => run([], value)).toThrow());
  it("requires explicit filter keys", () => {
    const { venue: _venue, ...input } = request;
    expect(() => run([], input)).toThrow();
  });
  it("accepts the exact sixteen-season boundary and 18-digit club IDs", () => {
    const seasons = Array.from({ length: 16 }, (_, i) => `${2000 + i}-${String(i + 1).padStart(2, "0")}`);
    expect(parseSeasonSplitRequest({ ...request, seasons, opponent_id: "club:123456789012345678" }, seasons).seasons).toEqual(seasons);
  });
});

describe("same-grain reduction", () => {
  it("orders opponent groups by played, points, then stable opponent key", () => {
    const rows: SeasonSplitRow[] = [
      { ...home, opponent_id: "club:4", played: 1, won: 1, goals_for: 2, lineage: ["synthetic:four"] },
      { ...home, opponent_id: "club:2", played: 1, won: 0, drawn: 1, goals_for: 1, goals_against: 1, lineage: ["synthetic:two"] },
      { ...home, opponent_id: "club:3", played: 1, won: 0, drawn: 1, goals_for: 1, goals_against: 1, lineage: ["synthetic:three"] },
      { ...home, opponent_id: "club:1", venue: "away", played: 1, won: 0, lost: 1, goals_for: 0, goals_against: 1, lineage: ["synthetic:one"] },
      { ...home, opponent_id: "club:3", venue: "away", played: 1, won: 1, lost: 0, goals_for: 2, goals_against: 0, lineage: ["synthetic:three-away"] },
    ];
    const opponentRequest = { ...request, group_by: "opponent" as const };
    expect(run(rows, opponentRequest).groups.map(g => [g.key, g.played, g.points])).toEqual([
      ["club:3", 2, 4], ["club:4", 1, 3], ["club:2", 1, 1], ["club:1", 1, 0],
    ]);
    expect(run([...rows].reverse(), opponentRequest).groups.map(g => g.key)).toEqual(["club:3", "club:4", "club:2", "club:1"]);
    expect(run(rows).groups.map(g => g.key)).toEqual(["away", "home"]);
  });
  it("reconciles the home/away oracle and opponent regrouping", () => {
    const result = run([away, home]);
    expect(result.groups.map(g => g.key)).toEqual(["away", "home"]);
    const group = run([home, away], { ...request, group_by: "opponent" }).groups[0]!;
    expect(group).toEqual({ key: "club:1", played: 2, won: 1, drawn: 0, lost: 1,
      goals_for: 3, goals_against: 3, points: 3, goal_difference: 0, rate_denominator: 2,
      points_per_match: 1.5, goals_for_per_match: 1.5, goals_against_per_match: 1.5,
      win_rate: 0.5, contributing_seasons: ["2024-25"], lineage: ["synthetic:away", "synthetic:home"] });
    for (const key of ["played", "won", "drawn", "lost", "goals_for", "goals_against", "points"] as const) {
      expect(result.groups.reduce((sum, g) => sum + g[key], 0)).toBe(group[key]);
    }
    expect(result.partial).toBe(true);
  });
  it("counts a completed zero-score draw", () => {
    const g = run([{ ...home, won: 0, drawn: 1, goals_for: 0 }]).groups[0]!;
    expect([g.played, g.points, g.points_per_match, g.goal_difference]).toEqual([1, 1, 1, 0]);
  });
  it("filters venue and opponent together", () => {
    expect(run([home, away], { ...request, venue: "home", opponent_id: "club:1" }).groups.map(g => g.played)).toEqual([1]);
    expect(run([home, away], { ...request, venue: "home", opponent_id: "club:2" }).groups).toEqual([]);
  });
  it("computes weighted rates across seasons, preserves coverage and unions lineage", () => {
    const cat = { ...metadata, seasons: metadata.seasons.map(s => ({ ...s, coverage: "partial" })) };
    const rows = [home, away, { ...home, season: "2025-26" }];
    const g = run(rows, { ...request, seasons: ["2025-26", "2024-25"], group_by: "opponent" }, cat).groups[0]!;
    expect([g.played, g.points, g.points_per_match]).toEqual([3, 6, 2]);
    expect(g.contributing_seasons).toEqual(["2024-25", "2025-26"]);
    expect(g.lineage).toEqual(["synthetic:away", "synthetic:home"]);
  });
  it("distinguishes complete empty, partial empty and missing capability", () => {
    const complete = { ...metadata, seasons: [{ season: "2024-25", coverage: "complete" }] };
    expect(run([], request, complete)).toMatchObject({ status: "no_matches", partial: false, groups: [] });
    expect(run([])).toMatchObject({ status: "missing_capability", partial: true, groups: [] });
    expect(run([], { ...request, seasons: ["2025-26"] })).toMatchObject({ status: "missing_capability", groups: [] });
    const mixed = run([home], { ...request, seasons: ["2024-25", "2025-26"] });
    expect(mixed).toMatchObject({ status: "available", partial: true,
      coverage: [{ season: "2024-25", coverage: "partial" }, { season: "2025-26", coverage: "missing" }] });
  });
  it("does not mutate input or depend on input order", () => {
    const rows = [structuredClone(home), structuredClone(away)];
    const before = structuredClone(rows);
    expect(run(rows)).toEqual(run([...rows].reverse()));
    expect(rows).toEqual(before);
  });
});

describe("runtime row boundary", () => {
  it.each([
    null, {}, { ...home, extra: 1 }, { ...home, competition: "CL" }, { ...home, venue: "total" },
    { ...home, opponent_id: "club:01" }, { ...home, snapshot_id: "other" }, { ...home, season: "2025-26" },
    { ...home, lineage: [] }, { ...home, lineage: Array(1) }, { ...home, lineage: ["ref", "ref"] }, { ...home, lineage: [" ref"] },
    { ...home, lineage: Array(33).fill("ref") }, { ...home, lineage: "ref" },
    { ...home, played: true }, { ...home, won: -1 }, { ...home, goals_for: 1.5 },
    { ...home, goals_for: NaN }, { ...home, goals_for: Infinity },
    { ...home, goals_for: Number.MAX_SAFE_INTEGER + 1 }, { ...home, played: 2 },
    { ...home, played: 0, won: 0 }, { ...home, won: 0 }, { ...home, drawn: 1 },
    { ...home, goals_for: 0 }, { ...home, won: 0, drawn: 1 }, { ...away, goals_for: 4 },
  ])("rejects malformed/unsupported row %#", value => expect(() => run([value])).toThrow());
  it("rejects duplicates even outside selection", () => {
    expect(() => run([home, home], { ...request, venue: "away" })).toThrow(/duplicate/);
    expect(() => run([home, { ...home, goals_for: 3 }])).toThrow(/duplicate/);
    expect(() => run([home, { ...away, snapshot_id: "other" }], { ...request, venue: "home" })).toThrow(/snapshots/);
  });
  it("rejects unsafe accumulated counters rather than rounding", () => {
    expect(() => run([{ ...home, goals_for: Number.MAX_SAFE_INTEGER }, away], { ...request, group_by: "opponent" })).toThrow(/overflow/);
  });
  it("rejects row/input/output overflow without truncating", () => {
    expect(() => run(Array(4097).fill(home))).toThrow(/row count/);
    const rows = Array.from({ length: 129 }, (_, i) => ({ ...home, opponent_id: `club:${i + 1}` }));
    expect(() => run(rows, { ...request, group_by: "opponent" })).toThrow(/opponent count/);
    expect(run(rows.slice(0, 128), { ...request, group_by: "opponent" }).groups).toHaveLength(128);
  });
  it("accepts exactly 4096 unique grains and rejects seventeen input seasons", () => {
    const seasons = Array.from({ length: 17 }, (_, i) => `${2000 + i}-${String(i + 1).padStart(2, "0")}`);
    const cat = { ...metadata, seasons: seasons.map(season => ({ season, coverage: "partial" })) };
    const rows = seasons.slice(0, 16).flatMap(season => Array.from({ length: 128 }, (_, i) =>
      ["home", "away"].map(venue => ({ ...home, season, venue, opponent_id: `club:${i + 1}` }))).flat());
    expect(run(rows, { ...request, seasons: seasons.slice(0, 16) }, cat).groups.map(g => g.played)).toEqual([2048, 2048]);
    expect(() => run(seasons.map(season => ({ ...home, season })), { ...request, seasons: seasons.slice(0, 16) }, cat)).toThrow(/input season count/);
  });
  it.each([null, [], {}, { ...metadata, extra: true }, { ...metadata, snapshot_id: "" },
    { ...metadata, seasons: [{ season: "2024-25", coverage: "unknown" }] },
    { ...metadata, seasons: [metadata.seasons[0], metadata.seasons[0]] },
  ])("rejects invalid coverage metadata %#", value => expect(() => run([], request, value)).toThrow());
});
