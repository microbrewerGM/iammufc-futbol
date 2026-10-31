import { describe, expect, it } from "vitest";
import { Catalog, type CompiledCatalog, type FeasibilityResult } from "../worker/src/core/feasibility";
import type { ResultRow } from "../worker/src/core/db";
import { withDefaults } from "../worker/src/core/intent";
import { LOCALES } from "../worker/src/core/locale";
import { resultPanel } from "../worker/src/views/pages";
import compiled from "../worker/src/generated/catalog.json" with { type: "json" };

const catalog = new Catalog(compiled as unknown as CompiledCatalog);
const rows: ResultRow[] = [
  { label: "Alpha", route_key: "fpl:code:1", secondary: "FW", value: 7 },
  { label: "Beta", route_key: "fpl:code:2", secondary: "MF", value: 3 },
  { label: "Gamma", route_key: "fpl:code:3", secondary: "FW", value: 1 },
];
const feasible: FeasibilityResult = { state: "computable_now_queued", reason: "fixture", cost_class: "cheap" };

function tableRows(html: string) {
  const table = html.match(/<table>[\s\S]*?<\/table>/)?.[0] ?? "";
  return [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].slice(1).map((match) => {
    const row = match[1]!;
    return {
      name: row.match(/<a[^>]*>([^<]+)<\/a>/)?.[1],
      rank: row.match(/<td class="num">([^<]+)<\/td>/)?.[1],
    };
  });
}

describe("ask result ranking", () => {
  it.each([
    ["en", "Rank"],
    ["es", "Puesto"],
  ] as const)("renders ordered player ranks in %s", (language, heading) => {
    const html = resultPanel(
      { ...withDefaults({ metric: "goals", entity_type: "player", entity_id: "all", season: "2025-26", competition: "PL", limit: 3 }), viz: "table" },
      feasible, rows, catalog, "rank-fixture", LOCALES[language],
    );
    const table = html.match(/<table>[\s\S]*?<\/table>/)?.[0] ?? "";
    expect(table).toContain(`<th class="num" scope="col">${heading}</th>`);
    expect(tableRows(html)).toEqual([
      { name: "Alpha", rank: "1" },
      { name: "Beta", rank: "2" },
      { name: "Gamma", rank: "3" },
    ]);
  });

  it("does not add a rank header to season data tables", () => {
    const html = resultPanel(
      { ...withDefaults({ metric: "goals", entity_type: "season", entity_id: "all", season: "2025-26", competition: "PL", limit: 3 }), viz: "table" },
      feasible, rows, catalog, "season-fixture", LOCALES.en,
    );
    const table = html.match(/<table>[\s\S]*?<\/table>/)?.[0] ?? "";
    expect(table).not.toContain(">Rank</th>");
    expect(table).not.toContain(">Puesto</th>");
  });
});
