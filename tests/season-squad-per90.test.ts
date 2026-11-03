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
  [...html.match(/<thead>.*?<\/thead>/s)![0].matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ""));
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
const sortingRows = [
  { label: "Lower", route_key: "k:lower", secondary: "MF", goals: 2, assists: 1, minutes: 901, points: 10, xg: 1 },
  { label: "Higher", route_key: "k:higher", secondary: "MF", goals: 2, assists: 1, minutes: 900, points: 10, xg: 1 },
  { label: "Tie", route_key: "k:tie", secondary: "MF", goals: 4, assists: 2, minutes: 1800, points: 10, xg: 1 },
  { label: "Assist leader", route_key: "k:assists", secondary: "MF", goals: 1, assists: 10, minutes: 900, points: 10, xg: 1 },
  { label: "Zero", route_key: "k:zero", secondary: "MF", goals: 0, assists: 0, minutes: 90, points: 0, xg: 0 },
  { label: "No totals", route_key: "k:null", secondary: "MF", goals: null, assists: null, minutes: 900, points: 0, xg: 0 },
  { label: "No minutes", route_key: "k:none", secondary: "MF", goals: 3, assists: 2, minutes: 0, points: 0, xg: 0 },
  { label: "Unknown minutes", route_key: "k:unknown", secondary: "MF", goals: 3, assists: 2, minutes: null, points: 0, xg: 0 },
];
const playerOrder = (html: string) => [...html.match(/<tbody>.*?<\/tbody>/s)![0]
  .matchAll(/<tr><td><a[^>]*>(.*?)<\/a>/g)].map(match => match[1]);
const sortHeader = (html: string, metric: string) => {
  for (const match of html.match(/<thead>.*?<\/thead>/s)![0].matchAll(/<th\b[^>]*>.*?<\/th>/g)) {
    const href = match[0].match(/href="([^"]+)"/)?.[1];
    if (!href) continue;
    const url = new URL(href.replaceAll("&amp;", "&"), "https://site.invalid");
    if (url.searchParams.get("sort") === metric) return { header: match[0], url };
  }
  throw new Error("missing metric sort link");
};

describe.each(["en", "es"] as const)("season sorting in %s", locale => {
  const sorted = (
    sort?: "goals_per90" | "assists_per90", direction: "asc" | "desc" = "desc", cat = catalog,
  ) => seasonPageBody("2018-19", sortingRows as never, null, cat, LOCALES[locale], null, null, {
    sort, direction, query: "keep=a%26b",
  });

  it.each(["goals_per90", "assists_per90"] as const)("sorts unrounded %s with stable ties and missing last", sort => {
    const before = structuredClone(sortingRows);
    const desc = sorted(sort, "desc");
    const missing = ["No totals", "No minutes", "Unknown minutes"];
    expect(playerOrder(desc)).toEqual(sort === "goals_per90"
      ? ["Higher", "Tie", "Lower", "Assist leader", "Zero", ...missing]
      : ["Assist leader", "Higher", "Tie", "Lower", "Zero", ...missing]);
    const asc = sorted(sort, "asc");
    expect(playerOrder(asc)).toEqual(sort === "goals_per90"
      ? ["Zero", "Assist leader", "Lower", "Higher", "Tie", ...missing]
      : ["Zero", "Lower", "Higher", "Tie", "Assist leader", ...missing]);
    expect(sortingRows).toEqual(before);
    for (const html of [desc, asc]) {
      const total = locale === "es" ? "Total de la plantilla" : "Squad total";
      expect(html.match(new RegExp(total, "g"))).toHaveLength(1);
      expect(html.match(/<tbody>.*?<\/tbody>/s)![0]).not.toContain(total);
      expect(html.indexOf(total)).toBeGreaterThan(html.indexOf("</tbody>"));
    }
  });

  it("distinguishes full precision values that display identically", () => {
    const html = sorted("goals_per90");
    for (const label of ["Lower", "Higher", "Tie"]) {
      const row = html.match(new RegExp(`<tr><td><a[^>]*>${label}</a></td>.*?</tr>`))![0];
      const rates = [...row.matchAll(/<td[^>]*>.*?<\/td>/g)].slice(-3, -1).map(match => match[0]);
      expect(rates).toEqual(locale === "es"
        ? ['<td class="num">0,20</td>', '<td class="num">0,10</td>']
        : ['<td class="num">0.20</td>', '<td class="num">0.10</td>']);
    }
  });

  it("preserves aggregate totals for a fully known squad", () => {
    const known = sortingRows.slice(0, 5);
    const renderKnown = (sort?: "goals_per90" | "assists_per90", direction?: "asc" | "desc") =>
      seasonPageBody("2018-19", known as never, null, catalog, LOCALES[locale], null, null, { sort, direction });
    const total = renderKnown().match(/<tfoot>.*?<\/tfoot>/s)![0];
    for (const metric of ["goals_per90", "assists_per90"] as const) {
      for (const direction of ["asc", "desc"] as const) {
        expect(renderKnown(metric, direction).match(/<tfoot>.*?<\/tfoot>/s)![0]).toBe(total);
      }
    }
  });

  it("preserves original order when selectors are absent", () => {
    expect(playerOrder(sorted())).toEqual(sortingRows.map(row => row.label));
  });

  it.each(["goals_per90", "assists_per90"] as const)("exposes a localized keyboard link and current %s direction", sort => {
    for (const direction of ["asc", "desc"] as const) {
      const html = sorted(sort, direction);
      const { header, url } = sortHeader(html, sort);
      expect(header).toContain(`aria-sort="${direction === "asc" ? "ascending" : "descending"}"`);
      const label = sort === "goals_per90"
        ? (locale === "es" ? "Goles / 90" : "Goals / 90")
        : (locale === "es" ? "Asistencias / 90" : "Assists / 90");
      const action = locale === "es"
        ? `Ordenar ${label} ${direction === "desc" ? "de menor a mayor" : "de mayor a menor"}`
        : `Sort ${label} in ${direction === "desc" ? "ascending" : "descending"} order`;
      expect(header).toContain(`aria-label="${action}"`);
      expect(header).toContain(`>${label}</a>`);
      expect(url.pathname).toBe(`/${locale}/season/2018-19`);
      expect(url.searchParams.get("sort")).toBe(sort);
      expect(url.searchParams.get("direction")).toBe(direction === "asc" ? "desc" : "asc");
      expect(url.searchParams.get("keep")).toBe("a&b");
      expect(html.match(/aria-sort=/g)).toHaveLength(1);
      const inactive = sortHeader(html, sort === "goals_per90" ? "assists_per90" : "goals_per90");
      expect(inactive.url.searchParams.get("direction")).toBe("desc");
      expect(inactive.header).not.toContain("aria-sort=");
    }
  });

  it("starts each inactive metric with descending order", () => {
    const html = sorted();
    expect(html).not.toContain("aria-sort=");
    for (const metric of ["goals_per90", "assists_per90"]) {
      expect(sortHeader(html, metric).url.searchParams.get("direction")).toBe("desc");
    }
  });

  it("keeps unavailable coverage in its original order", () => {
    const data = structuredClone(compiled) as unknown as CompiledCatalog;
    data.coverage = data.coverage.filter(cell => !(cell.metric === "minutes" && cell.season === "2018-19" && cell.competition === "PL"));
    for (const direction of ["asc", "desc"] as const) {
      expect(playerOrder(sorted("goals_per90", direction, new Catalog(data)))).toEqual(sortingRows.map(row => row.label));
    }
  });

  it.each(["goals", "assists"] as const)("uses the selected %s coverage without hiding the other rate", metric => {
    const data = structuredClone(compiled) as unknown as CompiledCatalog;
    data.coverage = data.coverage.filter(cell => !(cell.metric === metric && cell.season === "2018-19" && cell.competition === "PL"));
    const cat = new Catalog(data);
    expect(playerOrder(sorted(metric === "goals" ? "goals_per90" : "assists_per90", "desc", cat))).toEqual(sortingRows.map(row => row.label));
    expect(playerOrder(sorted(metric === "goals" ? "assists_per90" : "goals_per90", "desc", cat))[0]).toBe(metric === "goals" ? "Assist leader" : "Higher");
  });
});
