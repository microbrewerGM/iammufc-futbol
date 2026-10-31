import { describe, expect, it } from "vitest";
import { querySeasonSplits, type SeasonSplitRequest, type SeasonSplitRow } from "../worker/src/core/season-splits";
import { LOCALES } from "../worker/src/core/locale";
import { seasonSplitsBody, seasonSplitSelection, type SeasonSplitView } from "../worker/src/views/season-splits";

const seasons = ["2023-24", "2024-25"];
const request: SeasonSplitRequest = {
  schema_version: 1, competition: "PL", seasons, group_by: "venue", venue: null, opponent_id: null,
};
const row = (season: string, venue: "home" | "away", opponent_id: string): SeasonSplitRow => ({
  season, competition: "PL", venue, opponent_id, played: 1, won: 1, drawn: 0, lost: 0,
  goals_for: 2, goals_against: 0, snapshot_id: "venue-context", lineage: ["source"],
});
const rows = [row(seasons[0]!, "home", "club:1"), row(seasons[1]!, "home", "club:2"), row(seasons[1]!, "away", "club:3")];
const result = querySeasonSplits(request, {
  snapshot_id: "venue-context", seasons: seasons.map(season => ({ season, coverage: "complete" as const })),
}, rows);
const model: SeasonSplitView = {
  selection: seasonSplitSelection(request), seasons, opponents: [], result, credits: { source: "Credit" },
};
const rowFor = (html: string, label: string) => html.match(new RegExp(`<tr><th scope="row">${label}</th>[\\s\\S]*?</tr>`))?.[0] ?? "";

describe("venue contributing seasons", () => {
  it.each(["en", "es"] as const)("renders season context for each venue and the combined row in %s", code => {
    const body = seasonSplitsBody(model, LOCALES[code]);
    const home = rowFor(body, code === "en" ? "Home" : "Local");
    const away = rowFor(body, code === "en" ? "Away" : "Visitante");
    const combined = rowFor(body, code === "en" ? "All matches" : "Todos los partidos");
    const header = `<th scope="col">${code === "en" ? "Contributing seasons" : "Temporadas con datos"}</th>`;

    expect(body).toContain(header);
    expect(home.match(/<td>2023-24, 2024-25<\/td><\/tr>$/)?.[0]).toBe("<td>2023-24, 2024-25</td></tr>");
    expect(away.match(/<td>2024-25<\/td><\/tr>$/)?.[0]).toBe("<td>2024-25</td></tr>");
    expect(combined.match(/<td>2023-24, 2024-25<\/td><\/tr>$/)?.[0]).toBe("<td>2023-24, 2024-25</td></tr>");
    expect([home, away, combined].every(row => row.split("<td>").length === 14)).toBe(true);
  });
});
