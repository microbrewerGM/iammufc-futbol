import { describe, expect, it } from "vitest";
import { querySeasonSplits, type SeasonSplitRequest, type SeasonSplitRow } from "../worker/src/core/season-splits";
import { LOCALES } from "../worker/src/core/locale";
import { seasonSplitsBody, seasonSplitSelection, type SeasonSplitView } from "../worker/src/views/season-splits";

const seasons = ["2024-25", "2025-26"];
const request: SeasonSplitRequest = {schema_version:1, competition:"PL", seasons, group_by:"venue", venue:null, opponent_id:null};
const row: SeasonSplitRow = { season:seasons[0]!, competition:"PL", venue:"home", opponent_id:"club:1", played:1, won:1, drawn:0, lost:0, goals_for:2, goals_against:0, snapshot_id:"synthetic", lineage:["synthetic:one"] };
const facts: SeasonSplitRow[] = [row, {...row, venue:"away", opponent_id:"club:2", won:0, lost:1, goals_for:1, goals_against:3}];
const run = (rows = facts, req = request, coverage: "complete" | "partial" | "missing" = "complete") => querySeasonSplits(req, {snapshot_id:"synthetic", seasons:seasons.map(season => ({season,coverage}))}, rows);
const model = (): SeasonSplitView => ({selection:seasonSplitSelection(request), seasons, opponents:[{opponent_id:"club:1",label:"Alpha"},{opponent_id:"club:2",label:"Beta"}], result:run(), credits:{"synthetic:one":"Synthetic credit"}});
const render = (value=model(), code: "en"|"es"="en") => seasonSplitsBody(value,LOCALES[code]);
const tableRow = (html:string, name:string) => html.match(new RegExp(`<tr><th scope="row">${name}</th>[\\s\\S]*?</tr>`))?.[0] ?? "";

describe("season split body", () => {
  it.each(["en","es"] as const)("renders oracle venue totals and rates in %s", code => {
    const body=render(model(),code);
    expect(tableRow(body,code==="en"?"Home":"Local")).toContain("<td>1</td><td>1</td><td>0</td><td>0</td><td>2</td><td>0</td><td>2</td><td>3</td>");
    expect(tableRow(body,code==="en"?"Away":"Visitante")).toContain("<td>1</td><td>0</td><td>0</td><td>1</td><td>1</td><td>3</td><td>-2</td><td>0</td>");
    expect(body).toContain(code==="en"?"100.00":"100,00");
    expect(body).toContain(`action="/${code}/seasons/explore"`);
    expect(body).toContain("Synthetic credit");expect(body).toContain("synthetic");
    expect(body).not.toContain(code==="en"?"Partial schedule:":"Calendario parcial:");
  });
  it.each(["en","es"] as const)("uses opponent grouping and weighted rates in %s", code=>{
    const value=model(); const req={...request,group_by:"opponent" as const};
    value.result=run([row,{...facts[1]!,opponent_id:"club:1"}],req); value.selection=seasonSplitSelection(req);
    const body=render(value,code), r=tableRow(body,"Alpha");
    expect(r).toContain("<td>2</td><td>1</td><td>0</td><td>1</td><td>3</td><td>3</td><td>0</td><td>3</td>");
    expect(r).toContain(code==="en"?"1.50":"1,50"); expect(r).toContain(code==="en"?"50.00":"50,00");
    // Uneven seasons: 1 win over three games is 1 point/game, not mean seasonal 1.5.
    value.result=run([row,{...row,season:seasons[1]!,won:0, lost:1, goals_for:0,goals_against:1},{...row,season:seasons[1]!,venue:"away",won:0,lost:1,goals_for:0,goals_against:1}],req);
    expect(tableRow(render(value,code),"Alpha")).toContain(code==="en"?"1.00":"1,00");
  });
  it("shows canonical filters and ID fallback instead of name-based inference",()=>{
    const value=model(), req={...request,venue:"away" as const,opponent_id:"club:2",group_by:"opponent" as const};
    value.result=run(facts,req);value.selection=seasonSplitSelection(req); value.opponents=[];
    const body=render(value);expect(body).toContain('value="away" selected');expect(body).toContain('value="club:2" selected');
    expect(tableRow(body,"club:2")).toContain("<td>1</td>");expect(body).not.toContain('<th scope="row">Alpha');
  });
  it.each(["en","es"] as const)("retains partial totals, missing seasons and absent venue in %s",code=>{
    const value=model();value.result=querySeasonSplits(request,{snapshot_id:"synthetic",seasons:[{season:seasons[0],coverage:"partial"},{season:seasons[1],coverage:"missing"}]},[row]);
    const body=render(value,code);expect(body).toContain(code==="en"?"partial subtotals":"subtotales parciales");
    expect(body).toContain(code==="en"?"Missing split coverage":"Sin cobertura de desgloses");
    expect(body).toContain('aria-describedby="splits-summary splits-method splits-warning"');
    expect(body).not.toContain(`<th scope="row">${code==="en"?"Away":"Visitante"}</th>`);
    expect(body).toContain(seasons[1]);
  });
  it.each(["en","es"] as const)("distinguishes no matches from missing capability in %s",code=>{
    const value=model();value.result=run([]);expect(render(value,code)).toContain(code==="en"?"No completed matches match":"Ningún partido finalizado coincide");
    value.result=run([],request,"partial");expect(render(value,code)).toContain(code==="en"?"No zero-match total is implied":"No se afirma un total de cero partidos");
    expect(render(value,code)).not.toContain("<table");
  });
  it.each(["en","es"] as const)("names the season with unavailable validated coverage and keeps the GET selector in %s",code=>{
    const value=model();
    value.result=querySeasonSplits(request,{snapshot_id:"synthetic",seasons:[{season:seasons[0],coverage:"complete"},{season:seasons[1],coverage:"missing"}]},[]);
    const body=render(value,code);
    expect(body).toContain(code==="en"?`${seasons[1]}: Missing split coverage`:`${seasons[1]}: Sin cobertura de desgloses`);
    expect(body).toContain(code==="en"?`Split coverage is unavailable for ${seasons[1]}`:`La cobertura de desgloses no está disponible para ${seasons[1]}`);
    expect(body).toContain('method="get" action="/');
    expect(body).toContain(`value="${seasons[1]}" checked`);
    expect(body).toContain(code==="en"?"Revise season selection":"Cambie la selección de temporada");
    expect(body).not.toContain(code==="en"?"No completed matches match":"Ningún partido finalizado coincide");
  });
  it("keeps supported zero draws as zero counts and rates",()=>{
    const value=model();value.result=run([{...row,won:0,drawn:1,goals_for:0}]);
    const r=tableRow(render(value),"Home");expect(r).toContain("<td>1</td><td>0</td><td>1</td><td>0</td><td>0</td><td>0</td><td>0</td><td>1</td>");
    expect(r).toContain("0.00");
  });
  it.each(["en","es"] as const)("preserves escaped invalid controls and hides stale results in %s",code=>{
    const value=model();value.error='Bad <selection> "test"';value.selection={seasons:["2099-00<"],group_by:"bad<",venue:"bad<",opponent_id:'<img src=x>'};
    const body=render(value,code);expect(body).toContain('role="alert">Bad &lt;selection&gt; &quot;test&quot;');
    expect(body).toContain('value="2099-00&lt;" checked');expect(body).toContain('value="bad&lt;" selected');expect(body).toContain('value="&lt;img src=x&gt;" selected');
    expect(body).not.toContain("<table");expect(body).not.toContain("Synthetic credit");
  });
  it("escapes external labels, snapshot and lineage credits",()=>{
    const value=model();value.result=run(facts,{...request,group_by:"opponent"});value.opponents[0]!.label='<img src=x onerror="bad()">';value.credits={"synthetic:one":"<script>credit</script>"};value.result.snapshot_id="<svg>";
    const body=render(value);expect(body).not.toMatch(/<(script|img|svg)\b/);expect(body).toContain("&lt;script&gt;credit&lt;/script&gt;");expect(body).toContain("&lt;svg&gt;");expect(body).toContain("&lt;img");
  });
  it.each(["toString","constructor","__proto__"])("does not trust inherited credit %s",ref=>{
    const value=model();value.result=run([{...row,lineage:[ref]}]);value.credits=Object.create({[ref]:"Inherited credit"}) as Record<string,string>;
    expect(render(value)).not.toContain("Inherited credit");expect(render(value)).toContain("Source attribution unavailable");
  });
  it("rejects blank/non-string credits and ignores unrelated credits",()=>{
    const value=model();for(const invalid of ["", "  ",null,7,{}]){value.credits={"synthetic:one":invalid,unrelated:"Not a source"} as unknown as Record<string,string>;const body=render(value);expect(body).toContain("Source attribution unavailable");expect(body).not.toContain("Not a source");}
    value.credits={"synthetic:one":"One credit"};expect(render(value).match(/One credit/g)).toHaveLength(1);
  });
  it("provides native controls, unique labels and scrollable table semantics",()=>{
    const body=render(), ids=[...body.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);expect(new Set(ids).size).toBe(ids.length);
    for(const m of body.matchAll(/<label for="([^"]+)"/g))expect(ids).toContain(m[1]);
    expect(body).toContain("<legend>");expect(body).toContain("<caption>");expect(body).toContain('scope="col"');expect(body).toContain('scope="row"');expect(body).toContain('tabindex="0"');expect(body).toContain('method="get"');
    expect(body).not.toMatch(/<script|<style|style=|onclick=/);
  });
  it("renders initial controls without invented results",()=>{const value=model();delete value.result;expect(render(value)).not.toContain("<table");expect(render(value)).not.toContain("No completed matches");});
});
