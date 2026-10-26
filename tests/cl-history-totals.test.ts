import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import { championsLeagueHistoryBody } from "../worker/src/views/cl-history";

const mk = (season: string, n: number, lineage: string[] | null = [`s:${season}`]) => ({ season, played: n, won: n, drawn: 1, lost: 2, goals: 3 * n, goals_against: n + 1, lineage });
const credits = { "s:2025-26": "C1", "s:2024-25": "C2", "s:2023-24": "C3", "s:2022-23": "C4" };

describe("Champions League totals row", () => {
  it.each(["en", "es"] as const)("sums observed only in %s", (code) => {
    const strings = LOCALES[code].strings.clHistory;
    const body = championsLeagueHistoryBody({
      entries: [
        { state: "observed", row: mk("2025-26", 1) },
        { state: "observed", row: mk("2024-25", 2) },
        { state: "observed", row: mk("2023-24", 3) },
        { state: "partial", row: mk("2022-23", 10) },
        { state: "gap", season: "2021-22" },
        { state: "observed", row: mk("2020-21", 20, null) },
      ],
      credits,
    }, strings);
    const label = strings.observedSeasons.replace("{n}", "3");
    const excluded = strings.seasonsExcluded.replace("{n}", "3");
    expect(body).toContain(`<th scope="row">${label} <span>${excluded}</span></th><td>6</td><td>6</td><td>3</td><td>6</td><td>18</td><td>9</td></tr>`);
  });

  it.each(["en", "es"] as const)("omits totals for all-gap in %s", (code) => {
    const strings = LOCALES[code].strings.clHistory;
    const body = championsLeagueHistoryBody({ entries: [{ state: "gap", season: "2024-25" }, { state: "gap", season: "2023-24" }], credits: {} }, strings);
    expect(body).toContain(strings.noResults);
    expect(body).not.toContain(strings.observedSeasons.split("(")[0]);
  });
});
