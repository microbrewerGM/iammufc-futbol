import { describe, expect, it } from "vitest";
import { querySeasonSplits, type SeasonSplitRequest, type SeasonSplitRow } from "../worker/src/core/season-splits";
import { LOCALES } from "../worker/src/core/locale";
import { seasonSplitsBody, seasonSplitSelection, type SeasonSplitView } from "../worker/src/views/season-splits";

const seasons = ["2024-25", "2025-26"];
const request: SeasonSplitRequest = {schema_version:1, competition:"PL", seasons, group_by:"venue", venue:null, opponent_id:null};
let n = 0;
const fx = (venue: "home"|"away", won: number, drawn: number, lost: number, goals_for: number, goals_against: number): SeasonSplitRow =>
  ({ season:seasons[0]!, competition:"PL", venue, opponent_id:"club:" + (++n), played:1, won, drawn, lost, goals_for, goals_against, snapshot_id:"synthetic", lineage:["synthetic:one"] });
const later = (r: SeasonSplitRow): SeasonSplitRow => ({...r, season:seasons[1]!});
const home = [fx("home",1,0,0,2,0), fx("home",1,0,0,3,1), later(fx("home",0,1,0,1,1))];
const away = [fx("away",0,1,0,0,0), later(fx("away",0,0,1,1,3))];
const run = (rows: SeasonSplitRow[], req = request, coverage: "complete" | "partial" | "missing" = "complete") =>
  querySeasonSplits(req, {snapshot_id:"synthetic", seasons:seasons.map(season => ({season,coverage}))}, rows);
const view = (result: SeasonSplitView["result"], req = request): SeasonSplitView => ({selection:seasonSplitSelection(req), seasons, opponents:[], result, credits:{"synthetic:one":"c"}});
const render = (v: SeasonSplitView, code: "en"|"es") => seasonSplitsBody(v, LOCALES[code]);
const totalRow = (html: string, label: string) => html.match(new RegExp(`<tr><th scope="row">${label}[\\s\\S]*?</tr>`))?.[0] ?? "";

describe("season splits overall row", () => {
  // totals: played 5, won 2, drawn 2, lost 1, gf 7, ga 5, gd 2, points 8
  it.each(["en","es"] as const)("sums home and away, recomputes rates in %s", code => {
    const row = totalRow(render(view(run([...home, ...away])), code), code === "en" ? "All matches" : "Todos los partidos");
    const d = code === "en" ? "." : ",";
    expect(row).toContain("<td>5</td><td>2</td><td>2</td><td>1</td><td>7</td><td>5</td><td>2</td><td>8</td>");
    expect(row).toContain(`<td>1${d}60</td><td>1${d}40</td><td>1${d}00</td><td>40${d}00</td>`);
    expect(row).toContain("<td>2024-25, 2025-26</td>");
    expect(row).not.toContain(code === "en" ? "partial subtotals" : "subtotales parciales");
  });
  it.each(["en","es"] as const)("marks partial selection in %s", code => {
    const body = render(view(run([...home, ...away], request, "partial")), code);
    expect(totalRow(body, code === "en" ? "All matches" : "Todos los partidos")).toContain(code === "en" ? "partial subtotals" : "subtotales parciales");
  });
  it.each(["en","es"] as const)("has no total for opponent grouping or empty states in %s", code => {
    const label = code === "en" ? "All matches" : "Todos los partidos";
    const opp = {...request, group_by:"opponent" as const};
    expect(render(view(run([...home, ...away], opp), opp), code)).not.toContain(label);
    for (const v of ["home", "away"] as const) {
      const req = {...request, venue:v};
      expect(render(view(run(v === "home" ? home : away, req), req), code)).not.toContain(label);
    }
    expect(render(view(run([])), code)).not.toContain(label);
    expect(render(view(run([], request, "missing")), code)).not.toContain(label);
  });
});
