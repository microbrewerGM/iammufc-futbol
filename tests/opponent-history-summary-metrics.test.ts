import { describe, expect, it } from "vitest";
import { queryOpponentHistory } from "../worker/src/core/opponent-history";
import { opponentHistoryBody } from "../worker/src/views/opponent-history";
import type { SeasonSplitCatalog, SeasonSplitRow } from "../worker/src/core/season-splits";

const snapshot = "a".repeat(64);
const seasons = ["2023-24", "2024-25", "2025-26"];
const request = { schema_version: 1, competition: "PL", seasons, group_by: "opponent", venue: null, opponent_id: "club:1001" };
const catalog = { snapshot_id: snapshot, seasons: seasons.map((season, index) => ({ season, coverage: index === 1 ? "partial" : index === 2 ? "missing" : "complete" })) } as SeasonSplitCatalog;
const rows: SeasonSplitRow[] = [
  { snapshot_id: snapshot, season: seasons[0]!, competition: "PL", venue: "home", opponent_id: "club:1001", played: 1, won: 1, drawn: 0, lost: 0, goals_for: 2, goals_against: 0, lineage: ["source:league"] },
  { snapshot_id: snapshot, season: seasons[1]!, competition: "PL", venue: "away", opponent_id: "club:1001", played: 1, won: 0, drawn: 1, lost: 0, goals_for: 1, goals_against: 1, lineage: ["source:league"] },
];
const result = queryOpponentHistory(request, catalog, rows);
const render = (locale: "en" | "es") => opponentHistoryBody({ result, credits: { "source:league": "League data" } }, locale);

describe("opponent history summary metrics", () => {
  it.each(["en", "es"] as const)("renders validated goal difference and points per match in %s", locale => {
    const html = render(locale);
    expect(html).toContain(locale === "en" ? "Goal difference" : "Diferencia de goles");
    expect(html).toContain(locale === "en" ? "Points / match" : "Puntos / partido");
    const table = html.match(/<table\b[\s\S]*?<\/table>/)?.[0] ?? "";
    expect(table).toContain(locale === "en" ? "<td>2</td>" : "<td>2</td>");
    expect(table).toContain(locale === "en" ? "<td>3.00</td>" : "<td>3,00</td>");
    expect(table).toContain(locale === "en" ? "<td>0</td>" : "<td>0</td>");
    expect(table).toContain(locale === "en" ? "<td>1.00</td>" : "<td>1,00</td>");
    expect(table).toContain(locale === "en" ? "<td colspan=\"9\">—</td>" : "<td colspan=\"9\">—</td>");
    expect(table).not.toMatch(/<td>0(?:\.00|,00)<\/td>/);
  });
});
