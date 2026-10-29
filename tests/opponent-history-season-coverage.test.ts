import { describe, expect, it } from "vitest";
import { queryOpponentHistory } from "../worker/src/core/opponent-history";
import { opponentHistoryBody } from "../worker/src/views/opponent-history";
import type { SeasonSplitCatalog } from "../worker/src/core/season-splits";

const seasons = ["2023-24", "2024-25"];
const snapshot = "a".repeat(64);
const request = { schema_version: 1, competition: "PL", seasons, group_by: "opponent", venue: null, opponent_id: "club:1001" };

describe("opponent history season coverage", () => {
  it.each([
    ["en", "History unavailable for requested seasons: 2024-25"],
    ["es", "Historial no disponible para las temporadas solicitadas: 2024-25"],
  ] as const)("names unavailable requested seasons in %s", (locale, note) => {
    const catalog = { snapshot_id: snapshot, seasons: [
      { season: "2023-24", coverage: "complete" },
      { season: "2024-25", coverage: "missing" },
    ] } as SeasonSplitCatalog;
    const result = queryOpponentHistory(request, catalog, []);
    const html = opponentHistoryBody({ result, credits: {} }, locale);

    expect(result.seasons.map(entry => [entry.season, entry.status])).toEqual([
      ["2023-24", "no_matches"], ["2024-25", "missing_capability"],
    ]);
    expect(html).toContain(note);
    expect(html).not.toMatch(/<td>0<\/td>/);
    expect(html).not.toContain("0-0-0");
  });

  it("does not call a complete season with no meetings unavailable", () => {
    const catalog = { snapshot_id: snapshot, seasons: seasons.map(season => ({ season, coverage: "complete" })) } as SeasonSplitCatalog;
    const html = opponentHistoryBody({ result: queryOpponentHistory(request, catalog, []), credits: {} }, "en");

    expect(html).toContain("No completed matches match this selection.");
    expect(html).not.toContain("History unavailable for requested seasons");
  });
});
