import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import { calculatePlayerTrends, type PlayerTrendsRequest } from "../worker/src/core/player-trends";
import { playerTrendsBody } from "../worker/src/views/player-trends";

const personId = "fpl:code:1";
const metadata = { snapshot_id: "snapshot-1", person_ids: [personId], seasons: ["2024-25"] };
const request: PlayerTrendsRequest = {
  schema_version: 1,
  competition: "PL",
  person_ids: [personId],
  seasons: metadata.seasons,
  metric: "goals",
  normalization: "total",
  min_minutes: 0,
  viz: "table",
};

function render(label: string, locale: typeof LOCALES.en | typeof LOCALES.es): string {
  const result = calculatePlayerTrends(request, metadata, [{
    person_id: personId,
    season: "2024-25",
    competition: "PL",
    metric: "goals",
    definition: "goals",
    total: 3,
    minutes: 900,
    snapshot_id: metadata.snapshot_id,
    lineage: ["source:goals"],
  }]);
  return playerTrendsBody({ ...result, people: [{ person_id: personId, label }], credits: {} }, {}, locale);
}

describe("player trend selected identity", () => {
  it.each([
    { localeName: LOCALES.en.code, locale: LOCALES.en, heading: "Player trends", caption: "Season by season values and availability" },
    { localeName: LOCALES.es.code, locale: LOCALES.es, heading: "Evolución de jugadores", caption: "Valores y disponibilidad por temporada" },
  ] as const)("shows the selected player in the $localeName heading and table caption", ({ locale, heading, caption }) => {
    const html = render("Alex Morgan", locale);
    expect(html).toContain(`<h1>${heading} · Alex Morgan</h1>`);
    expect(html).toContain(`<caption>${caption} · Alex Morgan</caption>`);
  });

  it("escapes untrusted resolved display text in the heading and caption", () => {
    const html = render("<img src=x onerror=alert(1)>", LOCALES.en);
    expect(html).toContain("<h1>Player trends · &lt;img src=x onerror=alert(1)&gt;</h1>");
    expect(html).toContain("<caption>Season by season values and availability · &lt;img src=x onerror=alert(1)&gt;</caption>");
    expect(html).not.toContain("<img src=x");
  });
});
