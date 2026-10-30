// @ts-expect-error Node's filesystem is used only by this Vitest test; worker types intentionally omit it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import { calculatePlayerTrends, type PlayerTrendsRequest } from "../worker/src/core/player-trends";
import { playerTrendsBody } from "../worker/src/views/player-trends";

const a = "fpl:code:1";
const seasons = ["2024-25"];
const request: PlayerTrendsRequest = {
  schema_version: 1,
  competition: "PL",
  person_ids: [a],
  seasons,
  metric: "goals",
  normalization: "total",
  min_minutes: 0,
  viz: "line",
};
const row = {
  person_id: a,
  season: seasons[0]!,
  competition: "PL" as const,
  metric: "goals" as const,
  definition: "goals" as const,
  total: 3,
  minutes: 900,
  snapshot_id: "snapshot-1",
  lineage: ["source:goals"],
};
const render = (locale: typeof LOCALES.en) => {
  const meta = { snapshot_id: "snapshot-1", person_ids: [a], seasons };
  const result = calculatePlayerTrends(request, meta, [row]);
  return playerTrendsBody({ ...result, people: [{ person_id: a, label: "Alex" }], credits: {} }, {}, locale);
};
const readStylesheet = () => readFileSync(new URL("../worker/public/style.css", import.meta.url), "utf8");

describe("player trend mobile table", () => {
  it.each([
    ["English", LOCALES.en, "Season by season values and availability · Alex"],
    ["Spanish", LOCALES.es, "Valores y disponibilidad por temporada · Alex"],
  ])("keeps the season table labelled and keyboard-focusable in %s", (_name, locale, label) => {
    const html = render(locale);
    expect(html).toContain(`<div class="player-trend-season-table" role="region" tabindex="0" aria-label="${label}"><table><caption>${label}</caption>`);
  });

  it("styles only the six-column season table region as a bounded horizontal scroller", () => {
    const css = readStylesheet();
    expect(css).toMatch(/main\s*>\s*\.player-trend-season-table:has\(>\s*table thead th:nth-child\(6\)\)/);
    expect(css).not.toMatch(/main\s*>\s*div(?:\[role="region"\])?:has\(>\s*table thead th:nth-child\(6\)\)/);
    expect(css).not.toMatch(/main\s*>\s*div\[role="region"\]:has\(>\s*table thead th:nth-child\(6\)\)/);
    expect(css).toMatch(/main\s*>\s*\.player-trend-season-table:has\(>\s*table thead th:nth-child\(6\)\)[\s\S]*?max-width:\s*100%/);
    expect(css).toMatch(/main\s*>\s*\.player-trend-season-table:has\(>\s*table thead th:nth-child\(6\)\)[\s\S]*?overflow-x:\s*auto/);
  });

  it("keeps desktop layout unchanged and gives the phone scroller room to overflow internally", () => {
    const css = readStylesheet();
    const mobile = css.match(/@media\s*\(max-width:\s*620px\)\s*\{([\s\S]*?main\s*>\s*\.player-trend-season-table:has\(>\s*table thead th:nth-child\(6\)\)[\s\S]*?)\n\}/)?.[1];
    expect(mobile).toBeDefined();
    expect(mobile).toMatch(/:focus-visible[\s\S]*?outline:\s*2px solid var\(--focus-ring\)/);
    expect(mobile).toMatch(/>\s*table\s*\{\s*min-width:\s*620px/);
  });
});
