import { describe, expect, it } from "vitest";
import { championsLeagueHistoryBody, type ChampionsLeagueHistoryStrings, type ChampionsLeagueHistoryView } from "../worker/src/views/cl-history";
import { LOCALES } from "../worker/src/core/locale";
// @ts-expect-error Node's built-in module is available in the configured test runtime.
import * as nodeFs from "node:fs";
const { readFileSync } = nodeFs as unknown as { readFileSync(path: URL, encoding: "utf8"): string };

const lineage = "openfootball:CL:2025-26";
const row = { season: "2025-26", played: 2, won: 1, drawn: 0, lost: 1, goals: 3, goals_against: 0, lineage: [lineage] };
const strings = (locale: "en" | "es"): ChampionsLeagueHistoryStrings => LOCALES[locale].strings.clHistory;

describe("Champions League stage reached view", () => {
  it.each([["en", "Stage reached", "Group stage"], ["es", "Fase alcanzada", "Fase de grupos"]] as const)(
    "renders localized stage labels after season in %s",
    (locale, header, group) => {
      const text = strings(locale);
      const body = championsLeagueHistoryBody({
        entries: [{ state: "observed", row: { ...row, stage_reached: "group_stage" } }],
        credits: { [lineage]: "OpenFootball" },
      }, text, locale);
      expect(body).toContain(`<th scope="col">${header}</th><th scope="col">${text.played}</th>`);
      expect(body).toContain(`<td>${group}</td><td>2</td><td>1</td><td>0</td><td>1</td><td>3</td><td>0</td>`);
      expect(body.match(/<th scope="col">/g)).toHaveLength(8);
    },
  );

  it.each([["en", "Source attribution unavailable for some data."], ["es", "Atribución de fuente no disponible para algunos datos."]] as const)(
    "keeps stage unavailable in its own cell while preserving totals in %s",
    (locale, unavailable) => {
      const text = strings(locale);
      const labels = strings(locale).stages!;
      const model: ChampionsLeagueHistoryView = {
        entries: [
          { state: "observed", row: { ...row, stage_reached: null } },
          { state: "observed", row: { ...row, season: "2024-25", stage_reached: "winner" } },
          { state: "gap", season: "2023-24" },
        ],
        credits: { [lineage]: "OpenFootball" },
      };
      const body = championsLeagueHistoryBody(model, text, locale);
      expect(body).toContain(`<th scope="col">${text.stage}</th>`);
      expect(body).toContain(`<td><span aria-label="${unavailable}">—</span> <span>${unavailable}</span></td><td>2</td><td>1</td><td>0</td><td>1</td><td>3</td><td>0</td>`);
      expect(body).toContain(`<td>${labels.winner}</td><td>2</td>`);
      expect(body).toContain(`<td colspan="7"><span aria-label="${text.gap}">—</span> <span>${text.gap}</span></td>`);
      expect(body).toContain("<tfoot>");
    },
  );

  it("keeps the wide table inside the existing scroll region at 320 px", () => {
    const css = readFileSync(new URL("../worker/public/style.css", import.meta.url), "utf8");
    const comparisonRule = css.match(/\.comparison-table\s*,[\s\S]*?\{([^{}]*)\}/)?.[1] ?? "";
    expect(comparisonRule).toMatch(/overflow-x\s*:\s*auto/);
    expect(comparisonRule).toMatch(/max-width\s*:\s*100%/);
    expect(championsLeagueHistoryBody({ entries: [{ state: "observed", row: { ...row, stage_reached: "final" } }], credits: { [lineage]: "OpenFootball" } }, strings("en"), "en"))
      .toContain('class="comparison-table" role="region"');
  });
});
