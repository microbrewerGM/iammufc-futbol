import { describe, expect, it } from "vitest";
import { querySeasonSplits, type SeasonSplitRequest } from "../worker/src/core/season-splits";
import { LOCALES } from "../worker/src/core/locale";
import { seasonSplitsBody, seasonSplitSelection } from "../worker/src/views/season-splits";

const seasons = ["2023-24", "2024-25", "2025-26"];
const request: SeasonSplitRequest = {
  schema_version: 1, competition: "PL", seasons, group_by: "venue", venue: null, opponent_id: null,
};
const render = (coverage: { season: string; coverage: "complete" | "partial" | "missing" }[], code: "en" | "es") => {
  const selectedSeasons = coverage.length ? coverage.map(entry => entry.season) : request.seasons;
  const selectedRequest = { ...request, seasons: selectedSeasons };
  const result = querySeasonSplits(selectedRequest, { snapshot_id: "synthetic", seasons: coverage.length ? coverage : request.seasons.map(season => ({ season, coverage: "missing" as const })) }, []);
  result.coverage = coverage;
  return seasonSplitsBody({ selection: seasonSplitSelection(selectedRequest), seasons, opponents: [], result, credits: {} }, LOCALES[code]);
};

describe("season splits coverage summary", () => {
  it("uses singular English labels for one season", () => {
    const coverage = [{ season: seasons[0]!, coverage: "complete" as const }];
    expect(render(coverage, "en")).toContain("Coverage across 1 selected season: 1 complete, 0 partial schedules, 0 missing split coverage.");
    expect(render(coverage, "es")).toContain("Cobertura de 1 temporada seleccionada: 1 completa, 0 parciales, 0 sin cobertura.");
  });

  it("uses plural English labels for multiple seasons in the same state", () => {
    const coverage = [
      { season: seasons[0]!, coverage: "partial" as const },
      { season: seasons[1]!, coverage: "partial" as const },
    ];
    expect(render(coverage, "en")).toContain("Coverage across 2 selected seasons: 0 complete, 2 partial schedules, 0 missing split coverage.");
    expect(render(coverage, "es")).toContain("Cobertura de 2 temporadas seleccionadas: 0 completas, 2 parciales, 0 sin cobertura.");
  });

  it("uses plural labels in English and Spanish for mixed coverage", () => {
    const coverage = [
      { season: seasons[0]!, coverage: "complete" as const },
      { season: seasons[1]!, coverage: "partial" as const },
      { season: seasons[2]!, coverage: "missing" as const },
    ];
    const english = render(coverage, "en");
    expect(english).toContain("Coverage across 3 selected seasons: 1 complete, 1 partial schedule, 1 missing split coverage.");
    const spanish = render(coverage, "es");
    expect(spanish).toContain("Cobertura de 3 temporadas seleccionadas: 1 completa, 1 parcial, 1 sin cobertura.");
    expect(spanish).not.toContain("Coverage across");
  });

  it("omits the summary when the coverage list becomes empty", () => {
    const nonempty = render([{ season: seasons[0]!, coverage: "complete" }], "en");
    expect(nonempty).toContain("id=\"splits-coverage-summary\"");

    const html = render([], "en");
    expect(html).not.toContain("splits-coverage-summary");
    expect(html).not.toContain("Coverage across");
  });
});
