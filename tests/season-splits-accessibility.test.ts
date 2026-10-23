import { describe, expect, it } from "vitest";
import { querySeasonSplits, type SeasonSplitRequest, type SeasonSplitRow } from "../worker/src/core/season-splits";
import { LOCALES } from "../worker/src/core/locale";
import { page } from "../worker/src/views/layout";
import { seasonSplitsBody, seasonSplitSelection, type SeasonSplitView } from "../worker/src/views/season-splits";

// Structural regressions only: actual keyboard/focus/phone measurements are
// recorded separately. A Node string assertion cannot measure a browser layout.
const request: SeasonSplitRequest = {
  schema_version: 1, competition: "PL", seasons: ["2024-25", "2025-26"],
  group_by: "opponent", venue: null, opponent_id: null,
};
const row: SeasonSplitRow = {
  season: "2024-25", competition: "PL", venue: "home", opponent_id: "club:1",
  played: 1, won: 1, drawn: 0, lost: 0, goals_for: 2, goals_against: 0,
  snapshot_id: "synthetic-a11y", lineage: ["synthetic:one"],
};
const longLabel = "Club de fútbol con un nombre muy largo para comprobar la navegación accesible";
function model(partial = false): SeasonSplitView {
  return {
    selection: seasonSplitSelection(request), seasons: request.seasons,
    opponents: [{ opponent_id: "club:1", label: longLabel }],
    result: querySeasonSplits(request, {
      snapshot_id: "synthetic-a11y",
      seasons: request.seasons.map(season => ({ season, coverage: partial ? "partial" : "complete" })),
    }, [row]), credits: { "synthetic:one": "Synthetic source" },
  };
}
const matches = (text: string, pattern: RegExp) => [...text.matchAll(pattern)];

describe.each(["en", "es"] as const)("season-split accessibility structure (%s)", code => {
  const render = (value = model()) => seasonSplitsBody(value, LOCALES[code]);

  it("names every native form control and retains a named season fieldset", () => {
    const body = render();
    const ids = matches(body, /\bid="([^"]+)"/g).map(m => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    const labels = matches(body, /<label for="([^"]+)">([\s\S]*?)<\/label>/g);
    const controls = matches(body, /<(?:input|select)\b[^>]*\bid="([^"]+)"[^>]*>/g);
    expect(controls).toHaveLength(5);
    const selectNames: Record<string, string> = {
      "splits-group_by": code === "en" ? "Group by" : "Agrupar por",
      "splits-venue": code === "en" ? "Venue" : "Localía",
      "splits-opponent_id": code === "en" ? "Opponent" : "Rival",
    };
    for (const control of controls) {
      const associated = labels.filter(label => label[1] === control[1]);
      expect(associated).toHaveLength(1);
      if (control[1]!.startsWith("splits-season-")) {
        const seasonIndex = Number(control[1]!.slice("splits-season-".length));
        expect(associated[0]![2]).toBe(`${control[0]}${request.seasons[seasonIndex]}`);
      } else {
        expect(associated[0]![2]).toBe(selectNames[control[1]!]);
      }
      expect(control[0]).not.toMatch(/\b(?:disabled|hidden)\b|tabindex="-1"/);
    }
    expect(body).toContain(`<legend>${code === "en" ? "Seasons (choose 1–16)" : "Temporadas (elige 1–16)"}</legend>`);
    expect(body).toContain(`<button type="submit">${code === "en" ? "Explore seasons" : "Explorar temporadas"}</button>`);
    expect(body).toContain(`method="get" action="/${code}/seasons/explore"`);
    expect(body).not.toMatch(/tabindex="[1-9]/);
  });

  it("gives the wide result a named keyboard-reachable scrolling region", () => {
    const body = render();
    const heading = body.match(/<h1>([^<]+)<\/h1>/)![1];
    expect(body).toContain(`<div class="comparison-table" role="region" tabindex="0" aria-label="${heading}"><table`);
    expect(body).toContain(`<caption>${code === "en" ? "Season performance" : "Rendimiento por temporada"}</caption>`);
    expect(body).toContain(`<th scope="row">${longLabel}</th>`);
  });

  it("associates all result cells with column and row headers", () => {
    const body = render();
    const head = body.match(/<thead>([\s\S]*?)<\/thead>/)![1]!;
    const headers = matches(head, /<th scope="col">([^<]+)<\/th>/g);
    expect(headers).toHaveLength(14);
    expect(headers[0]![1]).toBe(code === "en" ? "Opponent" : "Rival");
    expect(headers.at(-1)![1]).toBe(code === "en" ? "Contributing seasons" : "Temporadas con datos");
    const rows = matches(body.match(/<tbody>([\s\S]*?)<\/tbody>/)![1]!, /<tr>([\s\S]*?)<\/tr>/g);
    expect(rows).toHaveLength(1);
    for (const resultRow of rows) {
      expect(matches(resultRow[1]!, /<th scope="row">/g)).toHaveLength(1);
      expect(matches(resultRow[1]!, /<td>/g)).toHaveLength(headers.length - 1);
    }
  });

  it.each([false, true])("resolves every table description, including partial warning (%s)", partial => {
    const body = render(model(partial));
    const refs = body.match(/<table aria-describedby="([^"]+)"/)![1]!.split(" ");
    expect(refs).toEqual(partial ? ["splits-summary", "splits-method", "splits-warning"] : ["splits-summary", "splits-method"]);
    for (const ref of refs) expect(matches(body, new RegExp(`id="${ref}"`, "g"))).toHaveLength(1);
    if (partial) {
      expect(body).toContain('id="splits-warning" role="note"');
      expect(body).toContain(code === "en" ? "Missing matches are not zero" : "Los partidos ausentes no equivalen a cero");
    }
  });

  it("announces validation errors while keeping controls and removing stale results", () => {
    const value = model();
    value.error = code === "en" ? "Invalid season selection." : "Selección de temporada no válida.";
    const body = render(value);
    expect(body).toContain(`<p role="alert">${value.error}</p>`);
    expect(body).toContain('id="splits-group_by"');
    expect(body).not.toContain("<table");
    expect(body).not.toContain('role="region"');
  });

  it("retains the document language and main landmark around the real fragment", () => {
    const body = render();
    const document = page(body, { title: "Synthetic accessibility fixture", locale: LOCALES[code], unprefixedPath: "/seasons/explore" });
    expect(document).toContain(`<html lang="${LOCALES[code].htmlLang}">`);
    expect(document).toContain(`<main>\n${body}\n</main>`);
    expect(document).toContain('name="viewport" content="width=device-width, initial-scale=1"');
  });
});
