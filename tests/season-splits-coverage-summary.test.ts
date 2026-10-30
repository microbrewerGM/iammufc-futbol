import { describe, expect, it } from "vitest";
import { querySeasonSplits, type SeasonSplitRequest } from "../worker/src/core/season-splits";
import { LOCALES } from "../worker/src/core/locale";
import { seasonSplitsBody, seasonSplitSelection } from "../worker/src/views/season-splits";

const seasons = ["2023-24", "2024-25", "2025-26"];
const request: SeasonSplitRequest = {
  schema_version: 1, competition: "PL", seasons, group_by: "venue", venue: null, opponent_id: null,
};
const render = (coverage: { season: string; coverage: "complete" | "partial" | "missing" }[], code: "en" | "es") => {
  const result = querySeasonSplits(request, { snapshot_id: "synthetic", seasons: coverage.length ? coverage : request.seasons.map(season => ({ season, coverage: "missing" as const })) }, []);
  result.coverage = coverage;
  return seasonSplitsBody({ selection: seasonSplitSelection(request), seasons, opponents: [], result, credits: {} }, LOCALES[code]);
};

describe("season splits coverage summary", () => {
  it("summarizes selected coverage counts in English", () => {
    const html = render([
      { season: seasons[0]!, coverage: "complete" },
      { season: seasons[1]!, coverage: "partial" },
      { season: seasons[2]!, coverage: "missing" },
    ], "en");

    expect(html).toContain("Coverage across 3 selected seasons: 1 complete, 1 partial, 1 missing.");
  });

  it("uses Spanish labels for the summary", () => {
    const html = render([
      { season: seasons[0]!, coverage: "complete" },
      { season: seasons[1]!, coverage: "partial" },
      { season: seasons[2]!, coverage: "missing" },
    ], "es");

    expect(html).toContain("Cobertura de 3 temporadas seleccionadas: 1 completa, 1 parcial, 1 sin cobertura.");
    expect(html).not.toContain("Coverage across");
  });

  it("omits a positive count when the coverage list is empty", () => {
    const html = render([], "en");

    expect(html).not.toContain("splits-coverage-summary");
    expect(html).not.toContain("Coverage across");
  });
});
