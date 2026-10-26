import { describe, expect, it } from "vitest";

import { Catalog, type CompiledCatalog } from "../worker/src/core/feasibility";
import { LOCALES } from "../worker/src/core/locale";
import { seasonPageBody } from "../worker/src/views/pages";
import compiled from "../worker/src/generated/catalog.json" with { type: "json" };

const catalog = new Catalog(compiled as unknown as CompiledCatalog);
const squad = [
  { label: "A", route_key: "k:1", secondary: "MF", goals: 2, assists: 1, minutes: 900, points: 10, xg: 1.5 },
  { label: "B", route_key: "k:2", secondary: "FW", goals: 4, assists: 3, minutes: 1800, points: 20, xg: 2.5 },
];
const render = (locale: "en" | "es", cat = catalog) =>
  seasonPageBody("2018-19", squad as never, null, cat, LOCALES[locale]);
const totalRow = (html: string) => html.match(/<tfoot>.*?<\/tfoot>/s)![0];
const totalCells = (html: string) =>
  [...totalRow(html).matchAll(/<td[^>]*>.*?<\/td>/gs)].map((m) => m[0]);
const without = (metric: string) => {
  const data = structuredClone(compiled) as unknown as CompiledCatalog;
  data.coverage = data.coverage.filter(
    (c) => !(c.metric === metric && c.season === "2018-19" && c.competition === "PL"),
  );
  return new Catalog(data);
};
const dash = /^<td class="num no" title="[^"]+">–<\/td>$/;

describe("season squad totals row", () => {
  it("EN totals sum counts and recompute per-90 from totals", () => {
    const html = render("en");
    expect(totalRow(html)).toContain('<th scope="row">Squad total</th>');
    const c = totalCells(html);
    // goals 6, assists 4, minutes 2700 -> 0.20 and 0.13 (recomputed, not averaged)
    expect(c.slice(0, 3)).toEqual([
      '<td class="num">6</td>', '<td class="num">4</td>', '<td class="num">2,700</td>',
    ]);
    expect(c.slice(-3, -1)).toEqual(['<td class="num">0.20</td>', '<td class="num">0.13</td>']);
  });

  it("ES totals use ES label and decimal comma", () => {
    const html = render("es");
    expect(totalRow(html)).toContain('<th scope="row">Total de la plantilla</th>');
    const c = totalCells(html);
    expect(c.slice(-3, -1)).toEqual(['<td class="num">0,20</td>', '<td class="num">0,13</td>']);
  });

  it("has caption and column scopes", () => {
    for (const l of ["en", "es"] as const) {
      const html = render(l);
      expect(html).toContain(`<caption class="sr-only">${LOCALES[l].strings.squadTableLabel("2018-19")}</caption>`);
      const head = html.match(/<thead>.*?<\/thead>/s)![0];
      expect(head.match(/<th(?=[ >])(?![^>]*scope="col")/g)).toBeNull();
    }
  });

  it("gates per metric: no goals coverage -> G/90 dash, A/90 value", () => {
    const c = totalCells(render("en", without("goals")));
    expect(c[0]).toMatch(dash);
    const rates = c.slice(-3, -1);
    expect(rates[0]).toMatch(dash);
    expect(rates[1]).toBe('<td class="num">0.13</td>');
  });
});
