import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import { calculatePer90Leaders, calculatePlayerTrends, type PlayerTrendRow, type PlayerTrendsRequest } from "../worker/src/core/player-trends";
import { playerTrendsBody } from "../worker/src/views/player-trends";

const season = "2024-25";
const metadata = { snapshot_id: "rounding-fixture", person_ids: ["fpl:code:1", "fpl:code:2"], seasons: [season] };
const facts: PlayerTrendRow[] = [
  { person_id: "fpl:code:2", season, competition: "PL", metric: "goals", definition: "goals", total: 1, minutes: 451, snapshot_id: metadata.snapshot_id, lineage: ["fixture:goals"] },
  { person_id: "fpl:code:1", season, competition: "PL", metric: "goals", definition: "goals", total: 1, minutes: 450, snapshot_id: metadata.snapshot_id, lineage: ["fixture:goals"] },
];
const request: PlayerTrendsRequest = { schema_version: 1, competition: "PL", person_ids: metadata.person_ids, seasons: [season], metric: "goals", normalization: "per90", min_minutes: 450, viz: "table" };
const players = [
  { person_id: "fpl:code:1", label: "Higher rate" },
  { person_id: "fpl:code:2", label: "Lower rate" },
];

function render(locale: "en" | "es") {
  const leaders = calculatePer90Leaders(metadata, season, "goals", 450, facts);
  const trends = calculatePlayerTrends(request, metadata, facts);
  return playerTrendsBody({ ...trends, people: players, credits: { "fixture:goals": "Synthetic fixture" }, leaders }, {}, LOCALES[locale]);
}

describe("per-90 leaderboard display rounding", () => {
  it.each([
    ["en", "Per-90 leaderboard", "0.20"],
    ["es", "Clasificación por 90 minutos", "0,20"],
  ] as const)("keeps supplied rank order when distinct rates display identically in %s", (locale, label, displayRate) => {
    const html = render(locale);
    const region = html.split(`<div role="region" tabindex="0" aria-label="${label}">`)[1]!.split("</div>")[0]!;
    const body = region.split("<tbody>")[1]!.split("</tbody>")[0]!;
    const rows = [...body.matchAll(/<tr>(.*?)<\/tr>/gs)].map(match => match[1]!);

    // 1/450 is a higher exact rate than 1/451; both round to 0.20 per 90.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("<td>1</td><th scope=\"row\">Higher rate</th>");
    expect(rows[1]).toContain("<td>2</td><th scope=\"row\">Lower rate</th>");
    expect(rows.map(row => row.match(/<td>(?:0[.,]\d+)<\/td>/)?.[0])).toEqual([`<td>${displayRate}</td>`, `<td>${displayRate}</td>`]);
  });
});
