import { describe, expect, it } from "vitest";
// @ts-expect-error Node's built-in module is available in the configured test runtime.
import * as nodeFs from "node:fs";
import { championsLeagueHistoryBody, type ChampionsLeagueHistoryStrings } from "../worker/src/views/cl-history";

const { readFileSync } = nodeFs as unknown as { readFileSync(path: URL, encoding: "utf8"): string };
const css = readFileSync(new URL("../worker/public/style.css", import.meta.url), "utf8");

const copy: ChampionsLeagueHistoryStrings = {
  heading: "Champions League history", caption: "Recorded matches", season: "Season", played: "Played",
  stage: "Stage reached", stages: { group_stage: "Group stage", league_phase: "League phase", knockout_playoff: "Knockout play-off", round_of_16: "Round of 16", quarter_final: "Quarter-final", semi_final: "Semi-final", final: "Final", winner: "Winner" },
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
      { state: "observed", row: { season: "2022-23", played: 1, won: 1, drawn: 0, lost: 0, goals: 2, goals_against: 0, lineage: ["a", "missing"] } },
    ], credits: { a: "First & <source>", b: "Second", shared: "Shared" } }, {
      ...copy,
      sources: locale === "en" ? "Sources" : "Fuentes",
      attributionUnavailable: locale === "en" ? "Source attribution unavailable" : "Atribución de fuente no disponible",
    }, locale);

    expect(html).toContain(`<a class="cl-history-row-source" href="#cl-history-source-0" aria-label="${locale === "en" ? "Sources" : "Fuentes"}">§</a>`);
    expect(html).toContain(`<a class="cl-history-row-source" href="#cl-history-source-2" aria-label="${locale === "en" ? "Sources" : "Fuentes"}">§</a>`);
    expect(html).toContain(`<a class="cl-history-row-source" href="#cl-history-source-1" aria-label="${locale === "en" ? "Sources" : "Fuentes"}">§</a>`);
    expect(html.match(/href="#cl-history-source-1"/g)).toHaveLength(2);
    expect(html).toContain(locale === "en" ? 'aria-label="Sources"' : 'aria-label="Fuentes"');
    expect(html).toContain("First &amp; &lt;source&gt;");
    expect(html).not.toContain('href="#cl-history-source-3"');
    const unavailableRow = '<tr><th scope="row"><a href="/en/season/2022-23">2022-23</a></th><td colspan="7"><span aria-label="Source attribution unavailable">—</span> <span>Source attribution unavailable</span></td></tr>';
    const expectedUnavailableRow = locale === "en"
      ? unavailableRow
      : '<tr><th scope="row"><a href="/es/season/2022-23">2022-23</a></th><td colspan="7"><span aria-label="Atribución de fuente no disponible">—</span> <span>Atribución de fuente no disponible</span></td></tr>';
    expect(html).toContain(expectedUnavailableRow);
    expect(expectedUnavailableRow).not.toContain('href="#cl-history-source-');
    expect(html).toContain('<tr><th scope="row">2023-24</th><td colspan="7"><span aria-label="No recorded matches">—</span> <span>No recorded matches</span></td></tr>');
  });

  it("keeps source markers compact at narrow viewport widths", () => {
    const html = championsLeagueHistoryBody({ entries: Array.from({ length: 10 }, (_, i) => ({
      state: "observed" as const,
      row: { season: `20${String(i).padStart(2, "0")}-21`, played: 1, won: 1, drawn: 0, lost: 0, goals: 2, goals_against: 0, lineage: ["a"] },
    })), credits: { a: "Example source" } }, copy, "en");
    expect(html).toContain("cl-history-row-source");
    expect(html).toContain('role="region" tabindex="0"');
  });

  it("keeps the history scroll region within the viewport without a forced table width", () => {
    const comparisonRule = css.match(/\.comparison-table\s*,[\s\S]*?\{([^{}]*)\}/)?.[1] ?? "";
    expect(comparisonRule).toMatch(/overflow-x:\s*auto/);
    expect(comparisonRule).toMatch(/max-width:\s*100%/);

    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const historyMinWidth = rules.some(([, selector = "", declarations = ""]) =>
      /min-width\s*:/i.test(declarations) &&
      (/\.comparison-table(?:\s|[.#:[>+~]|$)/.test(selector) || /\.cl-history-row-source/.test(selector)));
    expect(historyMinWidth).toBe(false);
  });
});
