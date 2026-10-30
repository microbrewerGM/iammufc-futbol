import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import { championsLeagueHistoryBody } from "../worker/src/views/cl-history";

const mk = (season: string, played: number, won: number, drawn: number, lost: number, goals: number, goals_against: number, lineage: string[] | null = [`s:${season}`]) =>
  ({ season, played, won, drawn, lost, goals, goals_against, lineage });
const credits = { "s:2025-26": "C1", "s:2024-25": "C2", "s:2023-24": "C3" };
// Column totals are all different: played 12, won 5, drawn 4, lost 3, goals 17, against 13.
const a = mk("2025-26", 5, 3, 1, 1, 9, 4);
const b = mk("2024-25", 4, 2, 2, 0, 6, 3);
const c = mk("2023-24", 3, 0, 1, 2, 2, 6);
const cells = "<td>12</td><td>5</td><td>4</td><td>3</td><td>17</td><td>13</td></tr></tfoot>";

describe("Champions League totals row", () => {
  it.each(["en", "es"] as const)("totals every row with valid lineage and counts the rest in %s", (code) => {
    const strings = LOCALES[code].strings.clHistory;
    const body = championsLeagueHistoryBody({
      entries: [
        { state: "observed", row: a },
        { state: "observed", row: b },
        { state: "partial", row: c },
        { state: "gap", season: "2022-23" },
        { state: "observed", row: mk("2021-22", 20, 20, 0, 0, 99, 0, []) },
        { state: "out_of_coverage", season: "2026-27" },
      ],
      credits,
    }, strings, code);
    const label = strings.observedSeasons.replace("{n}", "3");
    expect(body).toContain(`<tfoot><tr><th scope="row">${label} <span>${strings.seasonsExcluded.replace("{n}", "2")}</span></th>${cells}`);
    expect(body.indexOf("<tfoot>")).toBeGreaterThan(body.indexOf("</tbody>"));
  });

  it.each(["en", "es"] as const)("omits the partial label and excluded span when nothing is excluded in %s", (code) => {
    const strings = LOCALES[code].strings.clHistory;
    const body = championsLeagueHistoryBody({ entries: [{ state: "observed", row: a }, { state: "observed", row: b }], credits }, strings, code);
    expect(body).toContain(`<tfoot><tr><th scope="row">${strings.observedSeasons.replace("{n}", "2")}</th><td>9</td><td>5</td><td>3</td><td>1</td><td>15</td><td>7</td></tr></tfoot>`);
  });

  it.each(["en", "es"] as const)("omits totals for all-gap in %s", (code) => {
    const strings = LOCALES[code].strings.clHistory;
    const body = championsLeagueHistoryBody({ entries: [{ state: "gap", season: "2024-25" }, { state: "gap", season: "2023-24" }], credits: {} }, strings, code);
    expect(body).toContain(strings.noResults);
    expect(body).not.toContain("<tfoot");
  });
});
