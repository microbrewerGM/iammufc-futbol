import { describe, expect, it } from "vitest";

import { Catalog, type CompiledCatalog } from "../worker/src/core/feasibility";
import { LOCALES } from "../worker/src/core/locale";
import { seasonPageBody } from "../worker/src/views/pages";
import compiled from "../worker/src/generated/catalog.json" with { type: "json" };

const catalog = new Catalog(compiled as unknown as CompiledCatalog);
const DASH = "–";
const row = (minutes: number) => ({
  label: "B.Fernandes", route_key: "fpl:code:101", secondary: "MF",
  goals: 2, assists: 1, minutes, points: 10, xg: 1.5,
});
const render = (minutes: number, locale: "en" | "es", cat = catalog) =>
  seasonPageBody("2018-19", [row(minutes)] as never, null, cat, LOCALES[locale]);
const cells = (html: string) =>
  [...html.match(/<tbody><tr>.*?<\/tr>/s)![0].matchAll(/<td[^>]*>.*?<\/td>/gs)].map((m) => m[0]);
const heads = (html: string) =>
  [...html.match(/<thead>.*?<\/thead>/s)![0].matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((m) => m[1]);
const dashCell = new RegExp(`^<td class="num no" title="[^"]+">${DASH}</td>$`);

describe("season squad per-90 columns", () => {
  it("renders 0.20 in EN and 0,20 in ES for 2 goals over 900 minutes", () => {
    // 2 goals / 900 min -> 0.20 ; 1 assist / 900 min -> 0.10 ; pinned by position.
    const en = cells(render(900, "en")).slice(-3, -1);
    expect(en[0]).toBe('<td class="num">0.20</td>');
    expect(en[1]).toBe('<td class="num">0.10</td>');
    const es = cells(render(900, "es")).slice(-3, -1);
    expect(es[0]).toBe('<td class="num">0,20</td>');
    expect(es[1]).toBe('<td class="num">0,10</td>');
  });

  it("orders per-90 headers after the metric columns and before position", () => {
    const h = heads(render(900, "en"));
    expect(h.slice(-3, -1)).toEqual(["Goals / 90", "Assists / 90"]);
    expect(h.indexOf("Goals / 90")).toBeGreaterThan(h.indexOf("Minutes"));
  });

  it("uses ES headers", () => {
    const h = heads(render(900, "es"));
    expect(h.slice(-3, -1)).toEqual(["Goles / 90", "Asistencias / 90"]);
  });

  it("shows a dash with a title, never 0, when minutes is 0", () => {
    for (const cell of cells(render(0, "en")).slice(-3, -1)) expect(cell).toMatch(dashCell);
  });

  it("shows the dash when coverage is not executable", () => {
    const data = structuredClone(compiled) as unknown as CompiledCatalog;
    data.coverage = data.coverage.filter(
      (cell) => !(cell.metric === "minutes" && cell.season === "2018-19" && cell.competition === "PL"),
    );
    for (const cell of cells(render(900, "en", new Catalog(data))).slice(-3, -1)) expect(cell).toMatch(dashCell);
  });
});
