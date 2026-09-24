import { describe, expect, it } from "vitest";

import { Catalog, type CompiledCatalog } from "../worker/src/core/feasibility";
import { LOCALES } from "../worker/src/core/locale";
import { coverageMatrix, playerPageBody, seasonPageBody } from "../worker/src/views/pages";
import compiled from "../worker/src/generated/catalog.json" with { type: "json" };

const catalog = new Catalog(compiled as unknown as CompiledCatalog);
const career = [
  { season: "2024-25", goals: 2, assists: 1, minutes: 180, points: 20, xg: 1.2, position: "MF" },
];
const record = {
  season: "2017-18", played: 38, won: 25, drawn: 6, lost: 7, goals: 68, goals_against: 28,
};

describe("player coverage boundary", () => {
  it.each([
    ["en", "No verified Manchester United player data for Synthetic in 2017-18."],
    ["es", "No hay datos verificados del Manchester United para Synthetic en 2017-18."],
  ] as const)("renders an explicit %s gap instead of another season", (code, message) => {
    const html = playerPageBody("Synthetic", "2017-18", career, catalog, LOCALES[code]);
    expect(html).toContain("no_data");
    expect(html).toContain(message);
    expect(html).not.toContain("Current: 2024-25");
    expect(html).not.toContain("Actual: 2024-25");
  });

  it("keeps early seasons visible as player-data gaps in the matrix", () => {
    const html = coverageMatrix(catalog, LOCALES.en);
    const goals = html.match(/<tr><th scope="row">Goals<\/th>(.*?)<\/tr>/s)?.[1] ?? "";
    expect(goals).toContain("no source integrated");
    expect(goals).not.toContain("Football-Data.co.uk");
  });

  it("retains an early league record when squad data is unavailable", () => {
    const html = seasonPageBody("2017-18", [], record, catalog, LOCALES.en);
    expect(html).toContain("League record: 38 played");
    expect(html).toContain("No squad data integrated for 2017-18.");
  });

  it("contains a populated squad table in a labelled keyboard-scrollable region", () => {
    const html = seasonPageBody(
      "2024-25",
      [{ label: "Synthetic", route_key: "fpl:code:101", secondary: "MF", goals: 2, assists: 1, minutes: 180, points: 20, xg: 1.2 }],
      { ...record, season: "2024-25" },
      catalog,
      LOCALES.en,
    );
    expect(html).toContain('class="squad-table" tabindex="0" role="region"');
    expect(html).toContain('aria-label="Manchester United squad output for 2024-25"');
  });

  it.each([
    ["en", "Goals / 90", "1.00", "0.50"],
    ["es", "Goles / 90", "1,00", "0,50"],
  ] as const)("renders localized %s trajectory rates with stable links", (code, heading, goals, assists) => {
    const html = playerPageBody(
      "Synthetic",
      "2024-25",
      career,
      catalog,
      LOCALES[code],
      "fpl:code:101",
    );
    expect(html).toContain(heading);
    expect(html).toContain(`>${goals}</td>`);
    expect(html).toContain(`>${assists}</td>`);
    expect(html).toContain("fpl%3Acode%3A101/2024-25");
    expect(html).toContain('class="career-table" tabindex="0" role="region"');
    expect(html).toContain(LOCALES[code].strings.careerRateExplainer);
    expect(html).toContain('aria-current="page"');
  });

  it.each([
    ["minutes", "No integrated source provides Minutes"],
    ["goals", "No integrated source provides Goals"],
  ] as const)("explains a derived-rate gap using its unavailable %s dependency", (missing, reason) => {
    const data = structuredClone(compiled) as unknown as CompiledCatalog;
    data.coverage = data.coverage.filter(
      (cell) =>
        !(cell.metric === missing && cell.entity_type === "player" && cell.season === "2024-25"),
    );
    const html = playerPageBody("Synthetic", "2024-25", career, new Catalog(data), LOCALES.en);
    expect(html).toContain(reason);
    expect(html.match(new RegExp(reason, "g"))?.length ?? 0).toBeGreaterThan(1);
    expect(html).not.toContain('title="Feasible and cheap; generated on request."');
  });
});
