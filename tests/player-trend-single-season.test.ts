import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import { calculatePlayerTrends, type PlayerTrendsRequest } from "../worker/src/core/player-trends";
import { playerTrendsBody } from "../worker/src/views/player-trends";

const person = "fpl:code:1";
const metadata = { snapshot_id: "snapshot-1", person_ids: [person], seasons: ["2024-25"] };
const request: PlayerTrendsRequest = {
  schema_version: 1, competition: "PL", person_ids: [person], seasons: metadata.seasons,
  metric: "goals", normalization: "total", min_minutes: 0, viz: "line",
};

describe("player trend with one supported season", () => {
  it.each([
    [LOCALES.en, "Only one supported season is available"],
    [LOCALES.es, "Solo hay una temporada disponible"],
  ] as const)("states the single-season limit in %s and retains the table value", (locale, message) => {
    const result = calculatePlayerTrends(request, metadata, [{
      person_id: person, season: "2024-25", competition: "PL", metric: "goals", definition: "goals",
      total: 7, minutes: 900, snapshot_id: metadata.snapshot_id, lineage: ["source:goals"],
    }]);
    const html = playerTrendsBody({ ...result, people: [{ person_id: person, label: "Alex" }], credits: {} }, {}, locale);

    expect(html).toContain(message);
    expect(html).toContain(`<td>2024-25</td><td>7</td>`);
    expect(html).not.toContain("increased");
    expect(html).not.toContain("decreased");
    expect(html).not.toContain("aumentó");
    expect(html).not.toContain("disminuyó");
    expect(html).not.toContain("<polyline");
  });
});
