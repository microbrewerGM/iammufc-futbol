import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import { calculatePer90Leaders, calculatePlayerTrends, type PlayerTrendRow, type PlayerTrendsRequest } from "../worker/src/core/player-trends";
import { playerTrendsBody } from "../worker/src/views/player-trends";

const season = "2024-25";
const ids = ["fpl:code:1", "fpl:code:2", "fpl:code:3", "fpl:code:4"];
const metadata = { snapshot_id: "tie-fixture", person_ids: ids, seasons: [season] };
const request: PlayerTrendsRequest = {
  schema_version: 1, competition: "PL", person_ids: [ids[0]!], seasons: [season],
  metric: "goals", normalization: "per90", min_minutes: 0, viz: "table",
};
const row = (person_id: string, total: number, minutes: number): PlayerTrendRow => ({
  person_id, season, competition: "PL", metric: "goals", definition: "goals",
  total, minutes, snapshot_id: metadata.snapshot_id, lineage: ["fixture:goals"],
});
const facts = [row(ids[0]!, 4, 1800), row(ids[1]!, 2, 900), row(ids[2]!, 1, 450), row(ids[3]!, 0, 450)];

function render(locale: "en" | "es") {
  const trends = calculatePlayerTrends(request, metadata, facts);
  const leaders = calculatePer90Leaders(metadata, season, "goals", 0, facts);
  return playerTrendsBody({
    ...trends, leaders, people: ids.map((person_id, index) => ({ person_id, label: `Player ${index + 1}` })),
    credits: { "fixture:goals": "Synthetic fixture" },
  }, {}, LOCALES[locale]);
}

describe("leaderboard minutes denominator", () => {
  it.each(["en", "es"] as const)("associates the minutes explanation with the table in %s", locale => {
    const html = render(locale);
    const label = locale === "en" ? "Per-90 leaderboard" : "Clasificación por 90 minutos";
    const table = html.split(`<div role="region" tabindex="0" aria-label="${label}">`)[1]!.split("</div>")[0]!;
    const caption = table.match(/<caption>(.*?)<\/caption>/s)![1]!;
    expect(caption).toContain(locale === "en"
      ? "Minutes played are the supported minutes used to calculate each per-90 value."
      : "Los minutos jugados son los minutos disponibles utilizados para calcular cada valor por 90 minutos.");
    const rows = [...table.matchAll(/<tr>(.*?)<\/tr>/gs)].slice(1).map(m => m[1]!);
    // Keep the underlying denominator and its corresponding rate in each rendered row.
    expect(rows[0]).toContain(locale === "en" ? "<td>1,800</td><td>0.20</td>" : "<td>1800</td><td>0,20</td>");
    expect(rows[1]).toContain(locale === "en" ? "<td>900</td><td>0.20</td>" : "<td>900</td><td>0,20</td>");
  });
});
