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
const render = (locale: "en" | "es", cat = catalog, rows: unknown[] = squad, season = "2018-19") =>
  seasonPageBody(season, rows as never, null, cat, LOCALES[locale]);
const totalRow = (html: string) => html.match(/<tfoot>.*?<\/tfoot>/s)![0];
const totalCells = (html: string) =>
  [...totalRow(html).matchAll(/<td[^>]*>.*?<\/td>/gs)].map((m) => m[0]);
const without = (metric: string, season = "2018-19") => {
  const data = structuredClone(compiled) as unknown as CompiledCatalog;
  data.coverage = data.coverage.filter(
    (c) => !(c.metric === metric && c.season === season && c.competition === "PL"),
  );
  return new Catalog(data);
};
const dash = /^<td class="num no" title="[^"]+">–<\/td>$/;
const num = (v: string, title = "") => `<td class="num"${title ? ` title="${title}"` : ""}>${v}</td>`;

describe("season squad totals row", () => {
  it("EN pins every total cell by position", () => {
    const html = render("en", catalog, squad, "2023-24");
    expect(totalRow(html)).toContain('<th scope="row">Squad total</th>');
    expect(totalCells(html)).toEqual([
      num("6"), num("4"), num("2,700"), num("30"), num("4.00"),
      num("0.20", "Squad goals per 90 player-minutes"),
      num("0.13", "Squad assists per 90 player-minutes"),
      "<td></td>",
    ]);
  });

  it("ES pins every total cell by position", () => {
    const html = render("es", catalog, squad, "2023-24");
    expect(totalRow(html)).toContain('<th scope="row">Total de la plantilla</th>');
    expect(totalCells(html)).toEqual([
      num("6"), num("4"), num("2700"), num("30"), num("4,00"),
      num("0,20", "Goles de la plantilla por 90 minutos de jugador"),
      num("0,13", "Asistencias de la plantilla por 90 minutos de jugador"),
      "<td></td>",
    ]);
  });

  it("shows dash for xg when it has no coverage", () => {
    const c = totalCells(render("en", without("xg", "2023-24"), squad, "2023-24"));
    expect(c[4]).toMatch(dash);
    expect(c[0]).toBe(num("6"));
  });

  it("shows dash for a covered metric when any row is null", () => {
    const rows = [squad[0], { ...squad[1], xg: null }];
    const c = totalCells(render("en", catalog, rows, "2023-24"));
    // Same null rendering as a per-player null cell (formatNumber's em dash).
    expect(c[4]).toBe(num("—"));
    expect(c[3]).toBe(num("30"));
  });

  it("has caption and column scopes", () => {
    for (const l of ["en", "es"] as const) {
      const html = render(l);
      expect(html).toContain(`<caption class="sr-only">${LOCALES[l].strings.squadTableLabel("2018-19")}</caption>`);
      const head = html.match(/<thead>.*?<\/thead>/s)![0];
      expect(head.match(/<th(?=[ >])(?![^>]*scope="col")/g)).toBeNull();
    }
  });

  it("omits the totals row for an empty squad", () => {
    expect(render("en", catalog, [])).not.toContain("<tfoot>");
  });

  it("gates per metric: no goals coverage -> G/90 dash, A/90 value", () => {
    const c = totalCells(render("en", without("goals")));
    expect(c[0]).toMatch(dash);
    expect(c[5]).toMatch(dash);
    expect(c[6]).toBe(num("0.13", "Squad assists per 90 player-minutes"));
  });
});
