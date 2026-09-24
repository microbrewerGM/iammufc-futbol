/**
 * Champions League on the season page.
 *
 * The property that matters most here is NOT "does the line render" -- it is
 * that football-data.org's mandated attribution (their terms, clause 7.1) can
 * never be separated from their data. The line and its credit render together
 * or neither renders. A test that only checked the happy path would let a
 * future refactor drop the credit silently, which is a licence breach rather
 * than a cosmetic bug.
 */

import { describe, expect, it } from "vitest";

import { Catalog, type CompiledCatalog } from "../worker/src/core/feasibility";
import { LOCALES } from "../worker/src/core/locale";
import { coverageMatrix, seasonPageBody } from "../worker/src/views/pages";
import compiled from "../worker/src/generated/catalog.json" with { type: "json" };

const catalog = new Catalog(compiled as unknown as CompiledCatalog);

const squad = [
  { label: "B.Fernandes", route_key: "fpl:code:101", secondary: "MF", goals: 8, assists: 6, minutes: 3017, points: 174, xg: 9.93 },
];

const plRecord = {
  season: "2018-19",
  played: 38,
  won: 19,
  drawn: 9,
  lost: 10,
  goals: 65,
  goals_against: 54,
};

const clRecord = {
  season: "2018-19",
  played: 10,
  won: 4,
  drawn: 2,
  lost: 4,
  goals: 13,
  goals_against: 15,
};

describe("season page — Champions League record", () => {
  it.each(["missing", "no_rights", "expensive"])("hides a supplied CL row when coverage is %s", (condition) => {
    const data = structuredClone(compiled) as unknown as CompiledCatalog;
    const matches = (cell: CompiledCatalog["coverage"][number]) => cell.metric === "goals" && cell.season === "2018-19" && cell.competition === "CL";
    if (condition === "missing") data.coverage = data.coverage.filter((cell) => !matches(cell));
    else for (const cell of data.coverage.filter(matches)) {
      if (condition === "no_rights") cell.redistributable = false;
      else cell.cost_class = "expensive";
    }
    const html = seasonPageBody("2018-19", squad as never, plRecord, new Catalog(data), LOCALES.en, clRecord);
    expect(html).not.toContain("Champions League: 10 played");
    expect(html).toContain("League record: 38 played");
  });

  it("renders the European line when a CL row exists", () => {
    const html = seasonPageBody("2018-19", squad as never, plRecord, catalog, LOCALES.en, clRecord);
    expect(html).toContain("Champions League: 10 played");
    expect(html).toContain("4W 2D 4L");
    expect(html).toContain("13–15 goals");
    expect(html).toContain("/player/fpl%3Acode%3A101/2018-19");
  });

  it("renders the line for a public-domain source that mandates no credit", () => {
    // Regression: an earlier guard required attribution_text to be non-null,
    // which silently hid the entire Champions League line once the source
    // became openfootball. Publishing rights gate the line, not credit text.
    const html = seasonPageBody("2018-19", squad as never, plRecord, catalog, LOCALES.en, clRecord);
    expect(html).toContain("Champions League: 10 played");
    expect(html).not.toContain("Football-Data.org");
  });

  it("omits the line entirely when United did not enter that season", () => {
    const html = seasonPageBody("2018-19", squad as never, plRecord, catalog, LOCALES.en, null);
    expect(html).not.toContain("Champions League");
  });

  it("still renders any credit a source does mandate, alongside its data", () => {
    // The invariant the old guard was protecting, kept and pinned properly:
    // the player table's source (FPL) requires a credit, and it appears.
    const html = seasonPageBody("2018-19", squad as never, plRecord, catalog, LOCALES.en, clRecord);
    expect(html).toContain("Fantasy Premier League");
  });

  it("still renders the league record when the CL record is absent", () => {
    const html = seasonPageBody("2018-19", squad as never, plRecord, catalog, LOCALES.en, null);
    expect(html).toContain("League record: 38 played");
  });

  it("localises the European line into Spanish", () => {
    const html = seasonPageBody("2018-19", squad as never, plRecord, catalog, LOCALES.es, clRecord);
    expect(html).toContain("Liga de Campeones: 10 jugados");
    expect(html).toContain("4G 2E 4P");
  });

  it("renders the Spanish line without inventing a credit the licence never asked for", () => {
    const html = seasonPageBody("2018-19", squad as never, plRecord, catalog, LOCALES.es, clRecord);
    expect(html).toContain("Liga de Campeones: 10 jugados");
    expect(html).not.toContain("Football-Data.org");
  });
});


describe("coverage matrix — competition scoping", () => {
  /**
   * Adding Champions League cells made the homepage matrix credit
   * football-data.org for the Goals row, which is FPL player data. The bare
   * `metric/season` key had no competition dimension, so the last matching
   * cell in the YAML won. These pin the source shown per metric so a new
   * competition can never silently reattribute an existing row again.
   */
  const html = coverageMatrix(catalog, LOCALES.en);

  it("credits FPL for player box-score metrics, not football-data.org", () => {
    expect(html).toContain("Fantasy Premier League public API");
    expect(html).not.toContain("football-data.org API");
  });

  it("shows a column for each season and no Champions League leakage", () => {
    expect(html).toContain("2016-17");
    expect(html).toContain("2025-26");
    expect(html).not.toContain("Champions League");
  });

  it("still marks the no-rights metric as such", () => {
    // progressive_passes is FBref-sourced and deliberately non-redistributable
    expect(html).toContain("✕");
  });
});
