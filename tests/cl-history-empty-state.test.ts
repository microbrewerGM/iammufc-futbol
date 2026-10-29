import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import { championsLeagueHistoryBody } from "../worker/src/views/cl-history";

const row = { season: "2025-26", played: 2, won: 1, drawn: 0, lost: 1, goals: 3, goals_against: 0, lineage: ["openfootball:CL:2025-26"] };
const credits = { "openfootball:CL:2025-26": "Credit" };

describe("Champions League history empty vs out-of-coverage", () => {
  it.each(["en", "es"] as const)("renders noResults and the gap rows for all-gap input in %s", (code) => {
    const strings = LOCALES[code].strings.clHistory;
    const body = championsLeagueHistoryBody({ entries: [{ state: "gap", season: "2024-25" }, { state: "gap", season: "2023-24" }], credits: {} }, strings, code);
    expect(body).toContain(strings.noResults);
    expect(body).toContain(strings.gap);
    expect(body).toContain("2024-25");
    expect(body).not.toContain(strings.outsideCoverage);
  });

  it.each(["en", "es"] as const)("keeps outsideCoverage for out-of-coverage seasons in %s", (code) => {
    const strings = LOCALES[code].strings.clHistory;
    const body = championsLeagueHistoryBody({ entries: [{ state: "out_of_coverage", season: "2026-27" }], credits: {} }, strings, code);
    expect(body).toContain(strings.outsideCoverage);
    expect(body).not.toContain(strings.noResults);
    expect(body).not.toContain("<table");
  });

  it.each(["en", "es"] as const)("renders a table without noResults for mixed gap and observed in %s", (code) => {
    const strings = LOCALES[code].strings.clHistory;
    const body = championsLeagueHistoryBody({ entries: [{ state: "observed", row }, { state: "gap", season: "2024-25" }], credits }, strings, code);
    expect(body).toContain("<table");
    expect(body).toContain("<td>2</td><td>1</td><td>0</td><td>1</td><td>3</td><td>0</td>");
    expect(body).toContain(strings.gap);
    expect(body).not.toContain(strings.noResults);
  });
});
