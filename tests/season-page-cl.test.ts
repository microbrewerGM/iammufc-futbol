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

const FDORG_CREDIT = "Football data provided by the Football-Data.org API";

const squad = [
  { label: "B.Fernandes", secondary: "MF", goals: 8, assists: 6, minutes: 3017, points: 174, xg: 9.93 },
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
  it("renders the European line when a CL row exists", () => {
    const html = seasonPageBody("2018-19", squad as never, plRecord, catalog, LOCALES.en, clRecord);
    expect(html).toContain("Champions League: 10 played");
    expect(html).toContain("4W 2D 4L");
    expect(html).toContain("13–15 goals");
  });

  it("renders football-data.org's mandated attribution verbatim alongside it", () => {
    const html = seasonPageBody("2018-19", squad as never, plRecord, catalog, LOCALES.en, clRecord);
    expect(html).toContain(FDORG_CREDIT);
  });

  it("omits both the line and the credit when United did not enter that season", () => {
    const html = seasonPageBody("2018-19", squad as never, plRecord, catalog, LOCALES.en, null);
    expect(html).not.toContain("Champions League");
    expect(html).not.toContain(FDORG_CREDIT);
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

  it("keeps the licence-mandated credit in English on the Spanish page", () => {
    // attribution_text_es is deliberately null in the manifest for this source:
    // translating a licence-mandated verbatim string would change what the
    // licence requires us to display. Falls back to English by design.
    const html = seasonPageBody("2018-19", squad as never, plRecord, catalog, LOCALES.es, clRecord);
    expect(html).toContain(FDORG_CREDIT);
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
