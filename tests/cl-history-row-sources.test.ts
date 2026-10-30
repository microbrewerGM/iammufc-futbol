import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import { championsLeagueHistoryBody, type ChampionsLeagueTotals } from "../worker/src/views/cl-history";

const row = (season: string, lineage: string[]): ChampionsLeagueTotals => ({ season, lineage, played: 2, won: 1, drawn: 1, lost: 0, goals: 3, goals_against: 1 });

describe("row source associations", () => {
  it.each(["en", "es"] as const)("associates all resolved credits once without invented references in %s", (locale) => {
    const strings = LOCALES[locale].strings.clHistory;
    const body = championsLeagueHistoryBody({ entries: [
      { state: "observed", row: row("2025-26", ["a", "b", "alias", "", " "]) },
      { state: "partial", row: row("2024-25", ["b"]) },
      { state: "observed", row: row("2023-24", ["missing"]) },
      { state: "gap", season: "2022-23" },
    ], credits: { a: "First <source>", b: "Second & source", alias: "First <source>", "": "Excluded blank", " ": "Excluded whitespace" } }, strings, locale);
    const rows = body.match(/<tbody>(.*?)<\/tbody>/s)![1]!.match(/<tr>.*?<\/tr>/gs)!;
    const ids = [...body.matchAll(/<p id="([^"]+)">/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(body).not.toContain("Excluded");
    const refs = (html: string) => html.match(/aria-describedby="([^"]+)"/)?.[1]?.split(" ") ?? [];
    expect(refs(rows[0]!)).toEqual(ids);
    expect(refs(rows[1]!)).toEqual([ids[1]]);
    expect(refs(rows[2]!)).toEqual([]);
    expect(refs(rows[3]!)).toEqual([]);
    expect(rows[2]!).toContain(strings.attributionUnavailable);
    expect(rows[2]!).not.toContain("<td>2</td>");
    expect(body.match(/First &lt;source&gt;/g)).toHaveLength(1);
    expect(body.match(/Second &amp; source/g)).toHaveLength(1);
    expect(body).not.toContain("First <source>");
    for (const r of rows.flatMap(refs)) expect(ids).toContain(r);
  });
});
