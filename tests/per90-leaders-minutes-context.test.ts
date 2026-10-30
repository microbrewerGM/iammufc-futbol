import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import { calculatePer90Leaders, type PlayerTrendRow } from "../worker/src/core/player-trends";
import { playerTrendsBody } from "../worker/src/views/player-trends";

const season = "2024-25";
const metadata = { snapshot_id: "minutes-context-fixture", person_ids: ["fpl:code:1"], seasons: [season] };
const facts: PlayerTrendRow[] = [{
  person_id: "fpl:code:1", season, competition: "PL", metric: "goals", definition: "goals",
  total: 4, minutes: 1800, snapshot_id: metadata.snapshot_id, lineage: ["fixture:goals"],
}];

function render(locale: "en" | "es") {
  const leaders = calculatePer90Leaders(metadata, season, "goals", 0, facts);
  return playerTrendsBody({
    request: { schema_version: 1, competition: "PL", person_ids: metadata.person_ids, seasons: [season], metric: "goals", normalization: "per90", min_minutes: 0, viz: "table" },
    snapshot_id: metadata.snapshot_id, definition: "goals", series: [], leaders,
    people: [{ person_id: "fpl:code:1", label: "Player One" }], credits: { "fixture:goals": "Synthetic fixture" },
  }, {}, LOCALES[locale]);
}

describe("per-90 leaderboard minutes context", () => {
  it.each([
    ["en", "Supported minutes (per-90 denominator)", "These are the supported minutes used to calculate each player's per-90 value."],
    ["es", "Minutos con datos (denominador por 90)", "Estos son los minutos con datos usados para calcular el valor por 90 de cada jugador."],
  ] as const)("explains the minutes denominator and associates the description with the table in %s", (locale, heading, description) => {
    const html = render(locale);
    const tableTag = html.match(/<table aria-describedby="([^"]+)">/);
    expect(tableTag).not.toBeNull();
    const id = tableTag![1]!;

    expect(html).toContain(`<th scope="col">${heading}</th>`);
    expect(html).toContain(`<p id="${id}">${description.replaceAll("'", "&#39;")}</p>`);
    expect(html).toContain(`<td>${locale === "en" ? "1,800" : "1800"}</td>`);
  });
});
