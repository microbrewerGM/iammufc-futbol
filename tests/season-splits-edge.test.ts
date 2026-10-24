import { describe, expect, it } from "vitest";
import { querySeasonSplits } from "../worker/src/core/season-splits";

const request = { schema_version: 1, competition: "PL", seasons: ["1999-00"],
  group_by: "venue", venue: null, opponent_id: null } as const;
const catalog = { snapshot_id: "edge-snapshot", seasons: [{ season: "1999-00", coverage: "complete" }] };
const row = { season: "1999-00", competition: "PL", venue: "home", opponent_id: "club:1",
  played: 1, won: 1, drawn: 0, lost: 0, goals_for: 1, goals_against: 0,
  snapshot_id: "edge-snapshot", lineage: ["synthetic:edge"] };
const run = (rows: unknown[]) => querySeasonSplits(request, catalog, rows);

describe("season split edge cases", () => {
  it("accepts the 1999-00 century boundary season", () => {
    expect(run([row])).toMatchObject({ status: "available", partial: false,
      coverage: [{ season: "1999-00", coverage: "complete" }],
      groups: [{ key: "home", played: 1, won: 1 }] });
  });

  it("rejects a row whose season suffix does not follow its starting year", () => {
    expect(() => run([{ ...row, season: "1999-01" }])).toThrow(/row season coverage/);
  });
});
