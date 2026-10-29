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

const chartRates = (html: string): string[] => {
  const svg = html.match(/<svg\b[\s\S]*?<\/svg>/)?.[0] ?? "";
  return [...svg.matchAll(/<(?:rect|circle)\b[^>]*\/><text x="\d+" y="(?:\d+)" text-anchor="middle">([^<]+)<\/text>/g)].map(match => match[1]!);
};

const tableRates = (html: string): string[] => {
  const table = html.match(/<table\b[\s\S]*?<\/table>/)?.[0] ?? "";
  return [...table.matchAll(/<tr><th scope="row">\d{4}-\d{2}<\/th>(?:<td>[^<]*<\/td>){8}<td>([^<]*)<\/td><td>[^<]*<\/td><\/tr>/g)].map(match => match[1]!);
};

describe("opponent history view", () => {
  it.each(["en", "es"] as const)("renders the table, chart, partial and missing seasons in %s", locale => {
    const html = render(locale);
    expect(html).toContain("<table"); expect(html).toContain('scope="col"'); expect(html).toContain('scope="row"');
    expect(html).toContain('role="img"'); expect(html).toContain("aria-labelledby=");
    expect(html).toContain(locale === "en" ? "Recorded subtotal" : "Subtotal registrado");
    expect(html).toContain(locale === "en" ? "Record unavailable" : "Balance no disponible");
    expect(html).toContain("League data credit"); expect(html).toContain(snapshot);
    expect(html).toContain(locale === "en" ? "3.00" : "3,00"); expect(html).toContain(locale === "en" ? "1.00" : "1,00");
    expect(html).toMatch(/<th scope="col">(?:Status|Estado)<\/th>/);
    expect(html).toContain('aria-describedby="h2h-summary"');
    expect(html).toContain("Arsenal");
    expect(html).toContain(locale === "en" ? "All venues" : "Todas las localías");
    expect(html).toContain("2023-24, 2024-25, 2025-26");
    expect(html).toContain(locale === "en" ? "Record unavailable; missing matches are not zero" : "Balance no disponible; los partidos ausentes no equivalen a cero");
    expect(html).toContain(locale === "en" ? "Combined record for selected seasons" : "Balance conjunto de las temporadas seleccionadas");
    expect(html).toContain(locale === "en" ? "Points / match" : "Puntos / partido");
    expect(chartRates(html)).toEqual(locale === "en" ? ["3.00", "1.00"] : ["3,00", "1,00"]);
    expect(tableRates(html)).toEqual(locale === "en" ? ["3.00", "1.00"] : ["3,00", "1,00"]);
  });
  it("escapes labels, keeps a true zero mark, and distinguishes empty from unavailable", () => {
    const unsafe = opponentHistoryBody({ result, opponentLabel: '<img src=x onerror="x">', credits: {} }, "en");
    expect(unsafe).not.toMatch(/<img\b/); expect(unsafe).toContain("&lt;img");
    expect(unsafe).toContain('width="24" height="46"');
    expect(unsafe).toContain("Source attribution unavailable");
    const desc = unsafe.match(/<desc id="h2h-chart-desc">([\s\S]*?)<\/desc>/)?.[1] ?? "";
    expect(desc).toContain("&lt;img src=x onerror=&quot;x&quot;&gt;");
  });
  it("labels an observed zero and describes opponent, venue, values, and coverage states", () => {
    const zeroSeasons = ["2023-24", "2024-25", "2025-26"];
    const zeroRequest = { ...request, seasons: zeroSeasons };
    const completeCatalog: SeasonSplitCatalog = { snapshot_id: snapshot, seasons: zeroSeasons.map((season, i) => ({ season, coverage: i === 2 ? "missing" as const : "complete" as const })) } as SeasonSplitCatalog;
    const withZero = queryOpponentHistory(zeroRequest, completeCatalog, [row("2023-24", "home", 0, 0, 1, 0, 1)]);
    const html = opponentHistoryBody({ result: withZero, opponentLabel: "Arsenal", credits: {} }, "en");
    expect(html).toContain('<circle cx="42" cy="74" r="3" class="zero-mark"/>');
    expect(html).toContain('<text x="42" y="65" text-anchor="middle">0.00</text>');
    expect(html).toContain("No completed matches match this selection.");
    expect(html).toContain("Record unavailable; missing matches are not zero");
    expect(html).toContain("Arsenal"); expect(html).toContain("All venues");
    const desc = html.match(/<desc id="h2h-chart-desc">([\s\S]*?)<\/desc>/)?.[1] ?? "";
    expect(desc).toContain("2023-24: 0.00 Points / match");
    expect(desc).toContain("2024-25: No completed matches match this selection.");
    expect(desc).toContain("2025-26: Record unavailable; missing matches are not zero");
  });
  it("describes combined partial record and Spanish chart values and limitations", () => {
    const html = render("es");
    const desc = html.match(/<desc id="h2h-chart-desc">([\s\S]*?)<\/desc>/)?.[1] ?? "";
    expect(desc).toContain("Arsenal");
    expect(desc).toContain("Todas las localías");
    expect(desc).toContain("2023-24: 3,00 Puntos / partido");
    expect(desc).toContain("2024-25: 1,00 Puntos / partido, Subtotal registrado; faltan datos seleccionados o son parciales");
    expect(desc).toContain("Balance conjunto de las temporadas seleccionadas: 2,00 Puntos / partido");
    expect(desc).toContain("Subtotal registrado; faltan datos seleccionados o son parciales");
    expect(chartRates(html)).toEqual(["3,00", "1,00"]);
  });
});
