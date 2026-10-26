import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import { championsLeagueHistoryBody } from "../worker/src/views/cl-history";

const row = { season: "2025-26", played: 2, won: 1, drawn: 0, lost: 1, goals: 3, goals_against: 0, lineage: ["openfootball:CL:2025-26"] };

describe("Champions League history empty vs out-of-coverage", () => {
  it.each(["en", "es"] as const)("renders noResults and no table for empty entries in %s", (code) => {
    const strings = LOCALES[code].strings.clHistory;
    const body = championsLeagueHistoryBody({ entries: [], credits: {} }, strings);
    expect(body).toContain(strings.noResults);
    expect(body).not.toContain(strings.outsideCoverage);
    expect(body).not.toContain("<table");
  });

  it.each(["en", "es"] as const)("keeps outsideCoverage for out-of-coverage seasons in %s", (code) => {
    const strings = LOCALES[code].strings.clHistory;
    const body = championsLeagueHistoryBody({ entries: [{ state: "out_of_coverage", season: "2026-27" }], credits: {} }, strings);
    expect(body).toContain(strings.outsideCoverage);
    expect(body).not.toContain(strings.noResults);
    expect(body).not.toContain("<table");
  });

  it("still renders an observed row", () => {
    const strings = LOCALES.en.strings.clHistory;
    const body = championsLeagueHistoryBody({ entries: [{ state: "observed", row }], credits: { "openfootball:CL:2025-26": "Credit" } }, strings);
    expect(body).toContain("<td>2</td><td>1</td><td>0</td><td>1</td><td>3</td><td>0</td>");
    expect(body).not.toContain(strings.noResults);
  });
});
