import { describe, expect, it } from "vitest";
import type { HistoryRecord, OpponentHistoryResult } from "../worker/src/core/opponent-history";
import { opponentHistoryBody } from "../worker/src/views/opponent-history";

const record = (played = 5): HistoryRecord => ({
  played, won: 2, drawn: 1, lost: 2, goals_for: 9, goals_against: 7, points: 7,
  goal_difference: 2, rate_denominator: played, points_per_match: 1.4,
  goals_for_per_match: 1.8, goals_against_per_match: 1.4, win_rate: 0.4, lineage: [],
});
const result = (combined: HistoryRecord | undefined): OpponentHistoryResult => ({
  request: { schema_version: 1, competition: "PL", seasons: ["2024-25"], group_by: "opponent", venue: null, opponent_id: "club:1001" },
  snapshot_id: "a".repeat(64),
  seasons: [{ season: "2024-25", coverage: "complete", status: combined ? "available" : "no_matches", record: combined }],
  combined, status: combined ? "available" : "no_matches", partial: false,
  contributing_seasons: combined ? ["2024-25"] : [],
});
const render = (combined: HistoryRecord | undefined, locale: "en" | "es") =>
  opponentHistoryBody({ result: result(combined), credits: {} }, locale);
const tableDescription = (html: string) => html.match(/<table aria-describedby="([^"]+)"/)?.[1];
const idCount = (html: string, id: string) => [...html.matchAll(new RegExp(`\\bid="${id}"`, "g"))].length;

describe("opponent history table summary relationship", () => {
  it.each(["en", "es"] as const)("associates the table with its present combined-record summary in %s", locale => {
    const html = render(record(), locale);
    expect(tableDescription(html)).toBe("h2h-summary h2h-record");
    expect(idCount(html, "h2h-summary")).toBe(1);
    expect(idCount(html, "h2h-record")).toBe(1);
  });

  it.each(["en", "es"] as const)("keeps the description valid when no combined-record summary is rendered in %s", locale => {
    const html = render(undefined, locale);
    expect(tableDescription(html)).toBe("h2h-summary");
    expect(idCount(html, "h2h-summary")).toBe(1);
    expect(idCount(html, "h2h-record")).toBe(0);
  });
});
