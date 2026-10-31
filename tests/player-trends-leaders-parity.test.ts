import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import { calculatePer90Leaders, calculatePlayerTrends, type PlayerTrendRow, type PlayerTrendsRequest } from "../worker/src/core/player-trends";
import { playerTrendsBody } from "../worker/src/views/player-trends";

const season = "2024-25";
const ids = ["fpl:code:5", "fpl:code:3", "fpl:code:2", "fpl:code:4", "fpl:code:1"];
const metadata = { snapshot_id: "parity-fixture", person_ids: ids, seasons: [season, "2025-26"] };
const people = ids.map(person_id => ({ person_id, label: `Player ${person_id.slice(-1)}` }));
const request: PlayerTrendsRequest = {
  schema_version: 1, competition: "PL", person_ids: ["fpl:code:1"], seasons: [season],
  metric: "goals", normalization: "per90", min_minutes: 450, viz: "table",
};
const row = (id: number, total: number, minutes: number): PlayerTrendRow => ({
  person_id: `fpl:code:${id}`, season, competition: "PL", metric: "goals", definition: "goals",
  total, minutes, snapshot_id: metadata.snapshot_id, lineage: ["fixture:goals"],
});
// Equal rates exercise minutes, then canonical-id ties; an eligible zero remains a fact.
const facts = [row(5, 99, 449), row(3, 1, 450), row(2, 1, 450), row(4, 0, 450), row(1, 4, 1800)];

function render(locale: "en" | "es", rows = facts, selectedSeason = season, reverse = false) {
  const meta = { ...metadata, person_ids: reverse ? [...ids].reverse() : ids };
  const input = reverse ? [...rows].reverse() : rows;
  const trends = calculatePlayerTrends({ ...request, seasons: [selectedSeason] }, meta, input);
  const leaders = calculatePer90Leaders(meta, selectedSeason, "goals", 450, input);
  return playerTrendsBody({ ...trends, leaders, people, credits: { "fixture:goals": "Synthetic fixture" } }, {}, LOCALES[locale]);
}

function tableRows(html: string, label: string): string[][] {
  const marker = `<div role="region" tabindex="0" aria-label="${label}">`;
  expect(html.split(marker)).toHaveLength(2);
  const region = html.split(marker)[1]!.split("</div>")[0]!;
  const body = region.split("<tbody>")[1]!.split("</tbody>")[0]!;
  return [...body.matchAll(/<tr>(.*?)<\/tr>/gs)].map(match =>
    [...match[1]!.matchAll(/<(?:td|th)(?: scope="row")?>(.*?)<\/(?:td|th)>/gs)].map((cell, index) =>
      index === 0 ? cell[1]!.replace(/ \((?:tied|empate)\)$/, "") : cell[1]!));
}
const labels = { en: "Per-90 leaderboard", es: "Clasificación por 90 minutos" };
const exclusions = { en: "Excluded players", es: "Jugadores excluidos" };
const expected = [
  ["1", "Player 1", "4", "1,800", "0.20"],
  ["1", "Player 2", "1", "450", "0.20"],
  ["1", "Player 3", "1", "450", "0.20"],
  ["4", "Player 4", "0", "450", "0.00"],
];

describe("bilingual per-90 leaderboard parity", () => {
  it.each([false, true])("pins ranks, values and both tie-breaks across locales (reversed=%s)", reverse => {
    const en = tableRows(render("en", facts, season, reverse), labels.en);
    const es = tableRows(render("es", facts, season, reverse), labels.es);
    expect(en).toEqual(expected);
    expect(en[0]![3]).toBe("1,800");
    // es-ES groups five-digit integers, but leaves four-digit integers ungrouped.
    expect(es[0]![3]).toBe("1800");
    expect(es).toEqual([
      ["1", "Player 1", "4", "1800", "0,20"],
      ["1", "Player 2", "1", "450", "0,20"],
      ["1", "Player 3", "1", "450", "0,20"],
      ["4", "Player 4", "0", "450", "0,00"],
    ]);
    const normalizedCells = (rows: string[][]) => rows.map(cells => cells.map((value, index) =>
      index === 3 ? value.replace(",", "") : index === 4 ? value.replace(",", ".") : value));
    expect(normalizedCells(es)).toEqual(normalizedCells(en));
  });

  it.each(["en", "es"] as const)("lists the low-minute player outside the ranking in %s", locale => {
    const html = render(locale);
    expect(tableRows(html, labels[locale]).map(cells => cells[1])).toEqual(["Player 1", "Player 2", "Player 3", "Player 4"]);
    expect(tableRows(html, exclusions[locale])).toEqual([
      ["Player 5", locale === "en" ? "Below minimum minutes" : "Por debajo del mínimo de minutos"],
    ]);
  });

  it.each(["en", "es"] as const)("renders an empty season without fabricated ranking facts in %s", locale => {
    // Other-season facts are present: no cross-season fallback may populate the ranking.
    const html = render(locale, facts, "2025-26");
    const message = locale === "en" ? "No comparable players are available for 2025-26." : "No hay jugadores comparables disponibles para 2025-26.";
    expect(html).toContain(`<p role="status">${message}</p>`);
    expect(html).not.toContain(`<div role="region" tabindex="0" aria-label="${labels[locale]}">`);
    expect(html).not.toContain("<td>1</td><th scope=\"row\">");
    expect(html).not.toMatch(/<td>\d[\d.,]*<\/td><\/tr>/);
    const missing = locale === "en" ? "Data unavailable" : "Datos no disponibles";
    expect(tableRows(html, exclusions[locale])).toEqual([1, 2, 3, 4, 5].map(id => [`Player ${id}`, missing]));
  });
});
