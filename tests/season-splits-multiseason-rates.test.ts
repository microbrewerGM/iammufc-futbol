import { describe, expect, it } from "vitest";
import { querySeasonSplits } from "../worker/src/core/season-splits";
import type { SeasonSplitCatalog, SeasonSplitRequest, SeasonSplitRow } from "../worker/src/core/season-splits";

const request: SeasonSplitRequest = {
  schema_version: 1, competition: "PL", seasons: ["2024-25", "2025-26"],
  group_by: "venue", venue: null, opponent_id: null,
};
const catalog: SeasonSplitCatalog = {
  snapshot_id: "synthetic-snapshot",
  seasons: [{ season: "2024-25", coverage: "partial" }, { season: "2025-26", coverage: "partial" }],
};
const row = (season: string, venue: "home" | "away", opponent_id: string, won: number, drawn: number, goals_for: number, goals_against: number): SeasonSplitRow => ({
  season, competition: "PL", venue, opponent_id,
  played: 1, won, drawn, lost: 1 - won - drawn, goals_for, goals_against,
  snapshot_id: "synthetic-snapshot", lineage: [`synthetic:${season}:${opponent_id}`],
});

describe("multi-season season-split rates", () => {
  it("divides combined points and goals by combined played matches when season counts differ", () => {
    const result = querySeasonSplits(request, catalog, [
      row("2024-25", "away", "club:1", 1, 0, 1, 0),
      row("2025-26", "away", "club:1", 1, 0, 2, 0),
      row("2025-26", "away", "club:3", 0, 0, 0, 1),
      row("2025-26", "away", "club:4", 0, 0, 0, 1),
      row("2025-26", "home", "club:2", 1, 0, 4, 0),
    ]);

    expect(result.groups).toHaveLength(2);
    expect(result.groups.find(group => group.key === "away")).toMatchObject({
      key: "away",
      played: 4,
      points: 6,
      rate_denominator: 4,
      points_per_match: 1.5,
      goals_for: 3,
      goals_for_per_match: 0.75,
      goals_against: 2,
      contributing_seasons: ["2024-25", "2025-26"],
    });
    // Weighted points rate is 6/4 = 1.5 (season-rate mean: (3+1)/2 = 2); goals rate is 3/4 = 0.75 (season-rate mean: (1+2/3)/2 = 5/6).
    expect(result.groups.find(group => group.key === "home")).toMatchObject({
      played: 1, points: 3, points_per_match: 3, goals_for: 4, goals_for_per_match: 4,
      contributing_seasons: ["2025-26"],
    });
    expect(result.partial).toBe(true);
  });
});
