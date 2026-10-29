import { describe, expect, it } from "vitest";
import { championsLeagueHistoryBody, type ChampionsLeagueHistoryStrings } from "../worker/src/views/cl-history";

const strings = (locale: "en" | "es"): ChampionsLeagueHistoryStrings => ({
  heading: locale === "en" ? "Champions League history" : "Historial de la Liga de Campeones",
  caption: locale === "en" ? "Recorded matches" : "Partidos registrados",
  season: locale === "en" ? "Season" : "Temporada",
  played: "Played", won: "Won", drawn: "Drawn", lost: "Lost", goalsFor: "Goals for", goalsAgainst: "Goals against",
  gap: "No recorded matches", partial: locale === "en" ? "partial" : "parcial",
  outsideCoverage: "Outside coverage", noResults: "No results", unavailable: "Unavailable", snapshotDate: "Snapshot",
  sources: "Sources", attributionUnavailable: "Attribution unavailable", observedSeasons: "Seasons ({n})", seasonsExcluded: "Excluded: {n}",
});

const row = { season: "2025-26", played: 2, won: 1, drawn: 0, lost: 1, goals: 3, goals_against: 1, lineage: ["source"] };

describe("Champions League history season links", () => {
  it.each([
    ["en", "observed", "/en/season/2025-26"],
    ["en", "partial", "/en/season/2025-26"],
    ["es", "observed", "/es/season/2025-26"],
    ["es", "partial", "/es/season/2025-26"],
  ] as const)("links %s %s rows to the localized season page", (locale, state, href) => {
    const body = championsLeagueHistoryBody({ entries: [{ state, row }], credits: { source: "Source credit" } }, strings(locale), locale);
    expect(body).toContain(`<th scope="row"><a href="${href}">2025-26</a>`);
    expect(body).toContain("<td>2</td>");
    if (state === "partial") expect(body).toContain(`(${locale === "en" ? "partial" : "parcial"})`);
  });

  it.each([["en", "/en/"], ["es", "/es/"]] as const)("keeps %s gap rows unlinked", (locale, prefix) => {
    const body = championsLeagueHistoryBody({ entries: [{ state: "gap", season: "2024-25" }], credits: {} }, strings(locale), locale);
    expect(body).toContain('<th scope="row">2024-25</th>');
    expect(body).not.toContain(`${prefix}season/2024-25`);
  });

  it("renders a malformed malicious season as escaped text without a link", () => {
    const maliciousSeason = '2025-26"><img src=x onerror=alert(1)>/../../admin';
    const body = championsLeagueHistoryBody({
      entries: [{ state: "observed", row: { ...row, season: maliciousSeason } }],
      credits: { source: "Source credit" },
    }, strings("en"), "en");
    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;/../../admin");
    expect(body).not.toContain('<a href="/en/season/2025-26%22%3E%3Cimg');
    expect(body).not.toContain("<img");
  });

  it.each(["2025-99", "2025-25", "1999-99"])("keeps invalid season %s unlinked", (season) => {
    const body = championsLeagueHistoryBody({
      entries: [{ state: "observed", row: { ...row, season } }],
      credits: { source: "Source credit" },
    }, strings("en"), "en");
    expect(body).toContain(`<th scope="row">${season}</th>`);
    expect(body).not.toContain(`<a href="/en/season/${season}">`);
  });

  it("accepts the century rollover season 1999-00", () => {
    const body = championsLeagueHistoryBody({
      entries: [{ state: "observed", row: { ...row, season: "1999-00" } }],
      credits: { source: "Source credit" },
    }, strings("en"), "en");
    expect(body).toContain('<a href="/en/season/1999-00">1999-00</a>');
  });
});
