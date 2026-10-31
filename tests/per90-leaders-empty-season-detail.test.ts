import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import type { Per90LeadersResult } from "../worker/src/core/player-trends";
import { playerTrendsBody } from "../worker/src/views/player-trends";

const season = "2024-25";

function render(locale: "en" | "es", selectedSeason = season) {
  const leaders: Per90LeadersResult = {
    snapshot_id: "empty-season-fixture", season: selectedSeason, metric: "goals", min_minutes: 900,
    leaders: [], excluded: [],
  };
  return playerTrendsBody({
    request: {
      schema_version: 1, competition: "PL", person_ids: ["fpl:code:1"], seasons: [selectedSeason],
      metric: "goals", normalization: "per90", min_minutes: 900, viz: "table",
    },
    snapshot_id: leaders.snapshot_id, definition: "goals", series: [], leaders,
    people: [{ person_id: "fpl:code:1", label: "Player One" }], credits: {},
  }, {}, LOCALES[locale]);
}

describe("empty per-90 leaderboard season detail", () => {
  it.each([
    ["en", "No comparable players are available for 2024-25."],
    ["es", "No hay jugadores comparables disponibles para 2024-25."],
  ] as const)("names the selected season in %s", (locale, message) => {
    const html = render(locale);
    expect(html).toContain(`<p role="status">${message}</p>`);
    expect(html).toContain(`<h2>${locale === "en" ? "Per-90 leaderboard" : "Clasificación por 90 minutos"} · 2024-25</h2>`);
    expect(html).not.toContain("<tbody><tr>");
    expect(html).not.toContain("<td>0</td>");
  });

  it.each([["en"], ["es"]] as const)("retains a changed selection in the form model (%s)", locale => {
    expect(render(locale, "2023-24")).toContain("2023-24");
  });
});
