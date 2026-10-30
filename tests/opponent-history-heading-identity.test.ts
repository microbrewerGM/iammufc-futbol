import { describe, expect, it } from "vitest";
import { queryOpponentHistory } from "../worker/src/core/opponent-history";
import type { SeasonSplitCatalog } from "../worker/src/core/season-splits";
import { opponentHistoryBody } from "../worker/src/views/opponent-history";

const snapshot = "a".repeat(64);
const seasons = ["2024-25"];
const catalog = { snapshot_id: snapshot, seasons: [{ season: seasons[0], coverage: "complete" }] } as SeasonSplitCatalog;
const result = queryOpponentHistory({ schema_version: 1, competition: "PL", seasons, group_by: "opponent", venue: null, opponent_id: "club:1001" }, catalog, []);

describe("opponent history heading identity", () => {
  it.each([
    ["en", "Opponent history: Arsenal"],
    ["es", "Historial contra rivales: Arsenal"],
  ] as const)("names the selected opponent in the %s heading, including the no-meetings state", (locale, heading) => {
    const html = opponentHistoryBody({ result, opponentLabel: "Arsenal", credits: {} }, locale);
    expect(html).toContain(`<h1>${heading}</h1>`);
    expect(html).toContain(locale === "en" ? "No completed matches match this selection." : "Ningún partido finalizado coincide con esta selección.");
  });

  it("escapes the opponent display label in the heading", () => {
    const html = opponentHistoryBody({ result, opponentLabel: '<img src=x onerror="bad">', credits: {} }, "en");
    expect(html).toContain("<h1>Opponent history: &lt;img src=x onerror=&quot;bad&quot;&gt;</h1>");
    expect(html).not.toMatch(/<h1>[^<]*<img\b/);
  });

  it("keeps the localized heading meaningful when no display label is supplied", () => {
    expect(opponentHistoryBody({ result, credits: {} }, "en")).toContain("<h1>Opponent history: club:1001</h1>");
    expect(opponentHistoryBody({ result, credits: {} }, "es")).toContain("<h1>Historial contra rivales: club:1001</h1>");
  });
});
