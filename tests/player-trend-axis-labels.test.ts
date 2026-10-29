import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import { calculatePlayerTrends, type PlayerTrendsRequest } from "../worker/src/core/player-trends";
import { playerTrendsBody } from "../worker/src/views/player-trends";

const person = "fpl:code:1";
const seasons = ["2024-25", "2025-26"];
const request: PlayerTrendsRequest = {
  schema_version: 1,
  competition: "PL",
  person_ids: [person],
  seasons,
  metric: "goals",
  normalization: "per90",
  min_minutes: 450,
  viz: "line",
};
const rows = seasons.map(season => ({
  person_id: person,
  season,
  competition: "PL" as const,
  metric: "goals" as const,
  definition: "goals" as const,
  total: 3,
  minutes: 900,
  snapshot_id: "snapshot-1",
  lineage: ["source:goals"],
}));
const render = (locale: typeof LOCALES.en) => {
  const meta = { snapshot_id: "snapshot-1", person_ids: [person], seasons };
  const result = calculatePlayerTrends(request, meta, rows);
  return playerTrendsBody({ ...result, people: [{ person_id: person, label: "Alex" }], credits: {} }, {}, locale);
};

describe("player trend chart axis labels", () => {
  it.each([
    ["English", LOCALES.en, "Horizontal axis: season", "Vertical axis: Goals per 90 minutes"],
    ["Spanish", LOCALES.es, "Eje horizontal: temporada", "Eje vertical: Goles por 90 minutos"],
  ])("describes the season and active per-90 metric axes in %s", (_name, locale, xAxis, yAxis) => {
    const html = render(locale);
    expect(html).toContain(xAxis);
    expect(html).toContain(yAxis);
    expect(html).toContain("2024-25");
    expect(html).toContain("2025-26");
    expect(html).toContain("<table><caption>");
  });
});
