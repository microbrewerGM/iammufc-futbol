import { describe, expect, it } from "vitest";
import { calculatePlayerRange } from "../worker/src/core/player-range";
import type { PlayerRangeRequest, PlayerRangeRow } from "../worker/src/core/player-range";
import { LOCALES } from "../worker/src/core/locale";
import { playerRangeBody, playerRangeSelection, type PlayerRangeView } from "../worker/src/views/player-range";

const a = "fpl:code:101", b = "fpl:code:202";
const seasons = ["2024-25", "2025-26"];
const request: PlayerRangeRequest = { schema_version: 1, competition: "PL", person_ids: [a,b], seasons,
  metric: "goals", normalization: "per90", min_minutes: 0, viz: "table" };
const row: PlayerRangeRow = { person_id: a, season: seasons[0]!, competition: "PL", metric: "goals",
  definition: "goals", total: 1, minutes: 90, snapshot_id: "synthetic", lineage: ["synthetic:one"] };
const facts = [row, { ...row, season: seasons[1]!, minutes: 180 }];
const run = (rows = facts, req = request) => calculatePlayerRange(req, { snapshot_id: "synthetic", person_ids: [a,b], seasons }, rows);
const model = (): PlayerRangeView => ({ selection: playerRangeSelection(request), people: [{ person_id:a, label:"Alpha" }, { person_id:b, label:"Beta" }], seasons,
  result: run(), credits: { "synthetic:one":"Synthetic fixture credit" } });
const render = (value = model(), code: "en" | "es" = "en") => playerRangeBody(value, LOCALES[code]);
const playerRow = (html: string, label: string) => html.match(new RegExp(`<tr><th scope="row">${label}</th>[\\s\\S]*?</tr>`))?.[0] ?? "";

describe("player range body", () => {
  it.each(["en", "es"] as const)("renders weighted result and all selected people in %s", code => {
    const body = render(model(), code);
    expect(playerRow(body, "Alpha")).toMatch(code === "en" ? /0\.67/ : /0,67/);
    expect(playerRow(body, "Alpha")).toMatch(/<td>2<\/td>\s*<td>270<\/td>/);
    expect(body).not.toContain("0.75");
    expect(playerRow(body,"Beta")).toContain(code === "en" ? "No supported rows" : "Sin filas con datos suficientes");
    expect(body).toContain(code === "en" ? "2 selected players · 1 comparable players" : "2 jugadores seleccionados · 1 jugadores comparables");
    expect(body).toContain(`action="/${code}/compare/players"`);
    expect(body).toContain("Synthetic fixture credit");
    expect(body).toContain("synthetic");
  });
  it.each(["en", "es"] as const)("labels partial subtotal and missing season without ranking in %s", code => {
    const value = model(); value.result = run([row]);
    const body = render(value,code), partial = playerRow(body,"Alpha");
    expect(partial).toContain(code === "en" ? "partial subtotal" : "subtotal parcial");
    expect(partial).toContain(code === "en" ? "excluded from ranking" : "excluido de la clasificación");
    expect(partial).toContain(code === "en" ? "Missing row" : "Fila ausente");
    expect(partial).toContain("2025-26");
    expect(partial).toMatch(/<\/th>\s*<td>—<\/td>/);
    expect(partial).toContain('aria-label="' + (code === "en" ? "Missing data" : "Datos ausentes") + '"');
  });
  it("distinguishes supported zero, zero minutes and absent support", () => {
    const value = model(); value.result = run(facts.map(r=>({...r,total:0})));
    expect(playerRow(render(value),"Alpha")).toContain("0.00");
    value.result = run(facts.map(r=>({...r,total:0,minutes:0})));
    expect(playerRow(render(value),"Alpha")).toContain("Per 90 unavailable: zero minutes");
    value.result = run([{...row,total:null,minutes:900}]);
    expect(playerRow(render(value),"Alpha")).toContain("Incomplete metric or minutes");
    expect(playerRow(render(value),"Alpha")).toContain("900 minutes");
  });
  it("shows below-minimum context and preserves the selected comparison mode", () => {
    const value = model(); value.result = run(facts,{...request,min_minutes:450});
    value.selection = playerRangeSelection(value.result.request);
    expect(playerRow(render(value),"Alpha")).toContain("Below minimum minutes");
    expect(render(value)).toContain('value="450"');
    expect(render(value)).toContain('value="per90" selected');
  });
  it.each(["en", "es"] as const)("preserves raw controls on error and withholds a stale result in %s", code => {
    const value = model(); value.error = 'Bad <selection> "test"';
    value.selection = { person_ids:[b,"unknown<id>"], seasons:["2099-00"], metric:"unknown<metric>", normalization:"total", min_minutes:"invalid<value>", viz:"bar" };
    const body = render(value,code);
    expect(body).toContain('role="alert">Bad &lt;selection&gt; &quot;test&quot;');
    expect(body).toContain(`value="${b}" checked`);
    expect(body).toContain('value="unknown&lt;id&gt;" checked');
    expect(body).toContain('value="2099-00" checked');
    expect(body).toContain('value="unknown&lt;metric&gt;" selected');
    expect(body).toContain('value="invalid&lt;value&gt;"');
    expect(body).toContain('value="total" selected');
    expect(body).toContain('value="bar" selected');
    expect(body).not.toContain("<table"); expect(body).not.toContain("<meter");
  });
  it("escapes labels, snapshot and credits and marks unresolved credits honestly", () => {
    const value = model(); value.people[0]!.label = '<img src=x onerror="bad()">';
    value.credits = { "synthetic:one": '<script>credit</script>' };
    value.result!.snapshot_id = '<svg onload="bad()">';
    const body = render(value);
    expect(body).not.toMatch(/<(script|img|svg)\b/);
    expect(body).toContain("&lt;script&gt;credit&lt;/script&gt;");
    expect(body).toContain("&lt;img"); expect(body).toContain("&lt;svg");
    value.credits = {};
    expect(render(value)).toContain("Source attribution unavailable for some data.");
    expect(render(value)).not.toContain("Synthetic fixture credit");
  });
  it.each(["en", "es"] as const)("shows FPL definition boundary in %s", code => {
    const req = {...request,metric:"assists" as const};
    const value = model(); value.result = run(facts.map(r=>({...r,metric:"assists",definition:"fpl_assists"})), req);
    value.selection = playerRangeSelection(req);
    const body = render(value,code);
    expect(body).toContain(code === "en" ? "Assists use FPL definitions, which changed in 2025–26" : "Las asistencias siguen las definiciones FPL, que cambiaron en 2025–26");
  });
  it.each(["en", "es"] as const)("retains table fallback and shows bars only for comparable people in %s", code => {
    const value = model(); value.result = run(facts, {...request,viz:"bar"});
    value.selection = playerRangeSelection(value.result.request);
    const body = render(value,code);
    expect(body).toContain("<table"); expect(body.match(/<meter /g)).toHaveLength(1);
    expect(body).toContain('aria-label="Alpha"');
    expect(body).not.toContain('aria-label="Beta"');
    expect(body).toContain('value="0.6666666666666666"');
    value.result = run([row], {...request,viz:"bar"});
    expect(render(value,code)).not.toContain("<meter");
    expect(render(value,code)).toContain(code === "en" ? "No comparable players" : "No hay jugadores comparables");
  });
  it("provides native keyboard controls, explicit labels, table semantics and no script/style", () => {
    const body = render();
    const ids = [...body.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const match of body.matchAll(/<label for="([^"]+)"/g)) expect(ids).toContain(match[1]);
    expect(body.match(/<fieldset>/g)).toHaveLength(2);
    expect(body.match(/<legend>/g)).toHaveLength(2);
    expect(body).toContain('<caption>'); expect(body).toContain('scope="col"'); expect(body).toContain('scope="row"');
    expect(body).toContain('tabindex="0"'); expect(body).toContain('aria-describedby="range-summary range-method"');
    expect(body).not.toMatch(/<script|<style|style=|onclick=/);
    expect(body).toContain('value="0" required');
  });
  it("renders initial controls without inventing a result", () => {
    const value = model(); delete value.result;
    expect(render(value)).not.toContain("<table");
    expect(render(value)).toContain('method="get"');
    expect(render(value)).not.toContain("No supported rows");
  });
});
