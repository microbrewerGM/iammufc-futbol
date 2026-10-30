import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import { championsLeagueHistoryBody } from "../worker/src/views/cl-history";

const row = { season: "2025-26", played: 2, won: 1, drawn: 0, lost: 1, goals: 3, goals_against: 0, lineage: ["cl:2025-26"] };

describe("finished Champions League season labels", () => {
  it.each(["en", "es"] as const)("keeps completeness in the caption without partial labels in %s", (locale) => {
    const strings = LOCALES[locale].strings.clHistory;
    const body = championsLeagueHistoryBody({
      entries: [{ state: "partial", row }],
      credits: { "cl:2025-26": "OpenFootball" },
    }, strings, locale);

    expect(body).toContain(`<caption>${strings.caption}</caption>`);
    expect(body).toContain(`<a href="/${locale}/season/2025-26">2025-26</a>`);
    expect(body).toContain(`<tfoot><tr><th scope="row">${strings.observedSeasons.replace("{n}", "1")}</th>`);
    expect(body).not.toContain("(Partial)");
    expect(body).not.toContain("(Parcial)");
    expect(body).not.toContain(", partial");
    expect(body).not.toContain(", parcial");

    const missingLineage = championsLeagueHistoryBody({
      entries: [{ state: "partial", row: { ...row, lineage: ["missing"] } }],
      credits: {},
    }, strings, locale);
    expect(missingLineage).toContain(strings.attributionUnavailable);
    expect(missingLineage).not.toMatch(/<td>\d+<\/td>/);
    expect(missingLineage).toContain(`<caption>${strings.caption}</caption>`);
  });
});
