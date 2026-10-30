import { describe, expect, it } from "vitest";
import { championsLeagueHistoryBody, type ChampionsLeagueHistoryStrings } from "../worker/src/views/cl-history";

const copy: ChampionsLeagueHistoryStrings = {
  heading: "Champions League history", caption: "Recorded matches", season: "Season", played: "Played",
  won: "Won", drawn: "Drawn", lost: "Lost", goalsFor: "Goals for", goalsAgainst: "Goals against",
  gap: "No recorded matches", partial: "Partial", outsideCoverage: "Outside coverage", noResults: "No results",
  unavailable: "Temporarily unavailable", snapshotDate: "Data snapshot", sources: "Sources and snapshot",
  attributionUnavailable: "Source attribution unavailable", observedSeasons: "Recorded seasons ({n})", seasonsExcluded: "Excluded: {n}",
};

describe("Champions League history visible row sources", () => {
  it.each(["en", "es"] as const)("links resolved row sources in %s", (locale) => {
    const html = championsLeagueHistoryBody({ entries: [
      { state: "observed", row: { season: "2024-25", played: 1, won: 1, drawn: 0, lost: 0, goals: 2, goals_against: 0, lineage: ["a", "shared"] } },
      { state: "partial", row: { season: "2025-26", played: 2, won: 1, drawn: 1, lost: 0, goals: 3, goals_against: 1, lineage: ["b", "shared"] } },
      { state: "gap", season: "2023-24" },
      { state: "observed", row: { season: "2022-23", played: 1, won: 1, drawn: 0, lost: 0, goals: 2, goals_against: 0, lineage: ["missing"] } },
    ], credits: { a: "First & <source>", b: "Second", shared: "Shared" } }, { ...copy, sources: locale === "en" ? "Sources" : "Fuentes" }, locale);

    expect(html).toContain(`<a class="cl-history-row-source" href="#cl-history-source-0" aria-label="${locale === "en" ? "Sources" : "Fuentes"}">§</a>`);
    expect(html).toContain(`<a class="cl-history-row-source" href="#cl-history-source-2" aria-label="${locale === "en" ? "Sources" : "Fuentes"}">§</a>`);
    expect(html).toContain(`<a class="cl-history-row-source" href="#cl-history-source-1" aria-label="${locale === "en" ? "Sources" : "Fuentes"}">§</a>`);
    expect(html).toContain(locale === "en" ? 'aria-label="Sources"' : 'aria-label="Fuentes"');
    expect(html).toContain("First &amp; &lt;source&gt;");
    expect(html).not.toContain('href="#cl-history-source-3"');
    expect(html).toMatch(/<tr><th scope="row">2023-24<\/th>/);
  });

  it("keeps source markers compact at narrow viewport widths", () => {
    const html = championsLeagueHistoryBody({ entries: Array.from({ length: 10 }, (_, i) => ({
      state: "observed" as const,
      row: { season: `20${String(i).padStart(2, "0")}-21`, played: 1, won: 1, drawn: 0, lost: 0, goals: 2, goals_against: 0, lineage: ["a"] },
    })), credits: { a: "Example source" } }, copy, "en");
    expect(html).not.toMatch(/min-width:\s*\d{3,}px/);
    expect(html).toContain("cl-history-row-source");
    expect(html).toContain('role="region" tabindex="0"');
  });
});
