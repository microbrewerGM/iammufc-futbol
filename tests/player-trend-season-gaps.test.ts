import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import { calculatePlayerTrends, type PlayerTrendsRequest } from "../worker/src/core/player-trends";
import { playerTrendsBody } from "../worker/src/views/player-trends";

const person = "fpl:code:1";
const metadata = { snapshot_id: "snapshot-1", person_ids: [person], seasons: ["2023-24", "2024-25"] };
const request: PlayerTrendsRequest = {
  schema_version: 1, competition: "PL", person_ids: [person], seasons: metadata.seasons,
  metric: "goals", normalization: "total", min_minutes: 0, viz: "table",
};

describe("player trend season gaps", () => {
  it.each([
    [LOCALES.en, "Data unavailable"],
    [LOCALES.es, "Datos no disponibles"],
  ] as const)("labels a selected season with no fact as unavailable (%s)", (locale, unavailable) => {
    const result = calculatePlayerTrends(request, metadata, [{
      person_id: person, season: "2023-24", competition: "PL", metric: "goals", definition: "goals",
      total: 3, minutes: 900, snapshot_id: metadata.snapshot_id, lineage: ["source:goals"],
    }]);
    const html = playerTrendsBody({ ...result, people: [{ person_id: person, label: "Alex" }], credits: {} }, {}, locale);

    expect(html).toContain(`<td>2023-24</td><td>3</td>`);
    expect(html).toContain(`<td>2024-25</td><td>${unavailable}</td>`);
    expect(html).not.toContain(`<td>2024-25</td><td>0</td>`);
  });
});
