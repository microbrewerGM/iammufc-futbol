import { describe, expect, it } from "vitest";
import { LOCALES, type LocaleCode } from "../worker/src/core/locale";
import type { ChampionsLeagueHistoryStrings } from "../worker/src/views/cl-history";

const requiredKeys: readonly (keyof ChampionsLeagueHistoryStrings)[] = [
  "heading", "caption", "season", "played", "won", "drawn", "lost", "goalsFor", "goalsAgainst",
  "gap", "partial", "outsideCoverage", "noResults", "unavailable", "snapshotDate", "sources", "attributionUnavailable",
  "observedSeasons", "seasonsExcluded",
];

describe("Champions League history locales", () => {
  it.each(["en", "es"] as const satisfies readonly LocaleCode[])("provides every view string in %s", (code) => {
    const strings = LOCALES[code].strings.clHistory;
    for (const key of requiredKeys) expect(strings[key], `${code}.${key}`).toEqual(expect.any(String));
    expect(Object.keys(strings).sort()).toEqual([...requiredKeys].sort());
  });

  it("uses distinct language appropriate copy for empty, partial, gap, and withheld states", () => {
    for (const code of ["en", "es"] as const) {
      const strings = LOCALES[code].strings.clHistory;
      expect(strings.caption.toLowerCase()).toContain(code === "en" ? "incomplete" : "incompletos");
      expect(strings.partial).not.toBe(strings.gap);
      expect(strings.noResults).not.toBe(strings.outsideCoverage);
      expect(strings.unavailable).not.toBe(strings.gap);
      expect(strings.gap.toLowerCase()).not.toMatch(/\b0\b|\bcero\b/);
    }
  });
});
