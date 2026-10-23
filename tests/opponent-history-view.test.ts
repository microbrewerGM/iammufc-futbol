import { describe, expect, it } from "vitest";
import { queryOpponentHistory } from "../worker/src/core/opponent-history";
import { opponentHistoryBody } from "../worker/src/views/opponent-history";
import type { SeasonSplitCatalog, SeasonSplitRow } from "../worker/src/core/season-splits";

const seasons = ["2023-24", "2024-25", "2025-26"];
const snapshot = "a".repeat(64);
const catalog: SeasonSplitCatalog = { snapshot_id: snapshot, seasons: seasons.map((season, i) => ({ season, coverage: i === 1 ? "partial" : i === 2 ? "missing" : "complete" })) } as SeasonSplitCatalog;
const request = { schema_version: 1, competition: "PL", seasons, group_by: "opponent", venue: null, opponent_id: "club:1001" };
const row = (season: string, venue: "home" | "away", won: number, drawn: number, lost: number, gf: number, ga: number): SeasonSplitRow => ({ snapshot_id: snapshot, season, competition: "PL", venue, opponent_id: "club:1001", played: 1, won, drawn, lost, goals_for: gf, goals_against: ga, lineage: ["source:league"] });
const result = queryOpponentHistory(request, catalog, [row(seasons[0]!, "home", 1, 0, 0, 2, 0), row(seasons[1]!, "away", 0, 1, 0, 0, 0)]);
const render = (locale: "en" | "es") => opponentHistoryBody({ result, opponentLabel: "Arsenal", credits: { "source:league": "League data credit" } }, locale);

describe("opponent history view", () => {
  it.each(["en", "es"] as const)("renders the table, chart, partial and missing seasons in %s", locale => {
    const html = render(locale);
    expect(html).toContain("<table"); expect(html).toContain('scope="col"'); expect(html).toContain('scope="row"');
    expect(html).toContain('role="img"'); expect(html).toContain("aria-labelledby=");
    expect(html).toContain(locale === "en" ? "Recorded subtotal" : "Subtotal registrado");
    expect(html).toContain(locale === "en" ? "Record unavailable" : "Balance no disponible");
    expect(html).toContain("League data credit"); expect(html).toContain(snapshot);
    expect(html).toContain(locale === "en" ? "3.00" : "3,00"); expect(html).toContain(locale === "en" ? "1.00" : "1,00");
  });
  it("escapes labels, keeps a true zero mark, and distinguishes empty from unavailable", () => {
    const unsafe = opponentHistoryBody({ result, opponentLabel: '<img src=x onerror="x">', credits: {} }, "en");
    expect(unsafe).not.toMatch(/<img\b/); expect(unsafe).toContain("&lt;img");
    expect(unsafe).toContain('width="24" height="46"');
    expect(unsafe).toContain("Source attribution unavailable");
  });
});
