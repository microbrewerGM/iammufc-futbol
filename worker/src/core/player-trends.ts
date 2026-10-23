/** Pure calculator for bounded, snapshot-bound player trend facts. */
export type TrendMetric = "goals" | "assists";
export type TrendNormalization = "total" | "per90";
export interface PlayerTrendsRequest {
  schema_version: 1; competition: "PL"; person_ids: string[]; seasons: string[];
  metric: TrendMetric; normalization: TrendNormalization; min_minutes: number; viz: "table" | "line";
}
export interface PlayerTrendsCatalog { snapshot_id: string; person_ids: string[]; seasons: string[] }
export interface PlayerTrendRow {
  person_id: string; season: string; competition: "PL"; metric: TrendMetric;
  definition: "goals" | "fpl_assists"; total: number | null; minutes: number | null;
  snapshot_id: string; lineage: string[];
}
export type PlayerTrendReason = "supported" | "missing_row" | "missing_numerator" | "missing_minutes" | "zero_minutes" | "below_minimum";
export interface PlayerTrendCell {
  season: string; total: number | null; minutes: number | null; rate: number | null;
  reason: PlayerTrendReason; lineage: string[];
}
export interface PlayerTrendSeries { person_id: string; cells: PlayerTrendCell[] }
export interface Per90Leader { person_id: string; total: number; minutes: number; rate: number; lineage: string[] }
export interface Per90LeadersResult {
  snapshot_id: string; season: string; metric: TrendMetric; min_minutes: number;
  leaders: Per90Leader[]; excluded: { person_id: string; reason: "missing_row" | "missing_numerator" | "missing_minutes" | "zero_minutes" | "below_minimum" }[];
}
function fail(message: string): never { throw new Error(`Invalid player trends: ${message}`); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("object");
  const x = value as Record<string, unknown>;
  if (Object.keys(x).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(x,k))) fail("closed fields");
  return x;
}
function text(v: unknown): v is string { return typeof v === "string" && v.length > 0 && v.length <= 128 && v.trim() === v; }
function person(v: unknown): v is string { return typeof v === "string" && /^fpl:code:[1-9][0-9]{0,17}$/.test(v); }
function season(v: unknown): v is string { return typeof v === "string" && /^[0-9]{4}-[0-9]{2}$/.test(v) && Number(v.slice(-2)) === (Number(v.slice(0,4))+1)%100; }
function integer(v: unknown): v is number { return typeof v === "number" && Number.isSafeInteger(v) && v >= 0; }
function safeRateCompare(a: Per90Leader, b: Per90Leader): number {
  const left = BigInt(a.total) * BigInt(b.minutes);
  const right = BigInt(b.total) * BigInt(a.minutes);
  return left === right ? 0 : left > right ? -1 : 1;
}
function strings(v: unknown, min: number, max: number, valid: (x: unknown)=>boolean): string[] {
  if (!Array.isArray(v) || v.length < min || v.length > max || !v.every(valid) || new Set(v).size !== v.length) fail("list bounds or entries");
  return [...v as string[]].sort();
}
function catalog(value: unknown): PlayerTrendsCatalog {
  const x = object(value,["snapshot_id","person_ids","seasons"]);
  if (!text(x.snapshot_id)) fail("snapshot");
  return {snapshot_id:x.snapshot_id,person_ids:strings(x.person_ids,1,512,person),seasons:strings(x.seasons,1,64,season)};
}
export function parsePlayerTrendsRequest(value: unknown, metadataValue: unknown): PlayerTrendsRequest {
  const meta = catalog(metadataValue);
  const x = object(value,["schema_version","competition","person_ids","seasons","metric","normalization","viz","min_minutes"]);
  if (x.schema_version !== 1 || x.competition !== "PL" || (x.metric !== "goals" && x.metric !== "assists")
    || (x.normalization !== "total" && x.normalization !== "per90") || (x.viz !== "table" && x.viz !== "line")) fail("request selector");
  const people = strings(x.person_ids,1,5,person), seasons = strings(x.seasons,1,8,season);
  if (people.some(p=>!meta.person_ids.includes(p)) || seasons.some(s=>!meta.seasons.includes(s))) fail("unknown selection");
  if (!integer(x.min_minutes) || x.min_minutes > 20000 || (x.normalization === "total" && x.min_minutes !== 0)) fail("minimum");
  return {schema_version:1,competition:"PL",person_ids:people,seasons,metric:x.metric,min_minutes:x.min_minutes,normalization:x.normalization,viz:x.viz};
}
function validateRows(meta: PlayerTrendsCatalog, rowsValue: unknown): Map<string, PlayerTrendRow> {
  if (!Array.isArray(rowsValue) || rowsValue.length > 40) fail("fact bound");
  const rows = new Map<string,PlayerTrendRow>();
  for (const value of rowsValue) {
    const x = object(value,["person_id","season","competition","metric","definition","total","minutes","snapshot_id","lineage"]);
    if (!person(x.person_id) || !meta.person_ids.includes(x.person_id) || !season(x.season) || !meta.seasons.includes(x.season) || x.competition !== "PL") fail("row identity");
    if ((x.metric !== "goals" && x.metric !== "assists") || x.definition !== (x.metric === "goals" ? "goals" : "fpl_assists")) fail("metric definition");
    if ((x.total !== null && !integer(x.total)) || (x.minutes !== null && !integer(x.minutes))) fail("counter");
    if (x.snapshot_id !== meta.snapshot_id) fail("mixed snapshots");
    const lineage = strings(x.lineage,1,32,text);
    const key = JSON.stringify([x.person_id,x.season,x.metric]); if(rows.has(key)) fail("duplicate fact");
    rows.set(key,{...x,lineage} as unknown as PlayerTrendRow);
  }
  return rows;
}
function cell(seasonName: string, row: PlayerTrendRow | undefined, min: number, normalization: TrendNormalization): PlayerTrendCell {
  if (!row) return {season:seasonName,total:null,minutes:null,rate:null,reason:"missing_row",lineage:[]};
  if (row.total === null) return {season:seasonName,total:null,minutes:row.minutes,rate:null,reason:"missing_numerator",lineage:[...row.lineage]};
  if (row.minutes === null) return {season:seasonName,total:row.total,minutes:null,rate:null,reason:"missing_minutes",lineage:[...row.lineage]};
  if (row.minutes === 0) return {season:seasonName,total:row.total,minutes:0,rate:null,reason:"zero_minutes",lineage:[...row.lineage]};
  const rate = 90 * row.total / row.minutes;
  if (!Number.isFinite(rate) || !Number.isSafeInteger(90 * row.total)) fail("rate overflow");
  const reason = normalization === "per90" && row.minutes < min ? "below_minimum" : "supported";
  return {season:seasonName,total:row.total,minutes:row.minutes,rate:reason !== "supported" ? null : normalization === "total" ? row.total : rate,reason,lineage:[...row.lineage]};
}
export function calculatePlayerTrends(value: unknown, metadataValue: unknown, rowsValue: unknown): {request:PlayerTrendsRequest;snapshot_id:string;definition:"goals"|"fpl_assists";series:PlayerTrendSeries[]} {
  const meta = catalog(metadataValue), request = parsePlayerTrendsRequest(value,meta), rows = validateRows(meta,rowsValue);
  const series = request.person_ids.map(person_id=>({person_id,cells:request.seasons.map(s=>cell(s,rows.get(JSON.stringify([person_id,s,request.metric])),request.min_minutes,request.normalization))}));
  for (const person_id of request.person_ids) {
    let total = 0, minutes = 0;
    for (const s of request.seasons) {
      const row = rows.get(JSON.stringify([person_id,s,request.metric]));
      if (!row) continue;
      // A season is an atomic contribution: never combine one counter from a
      // season whose other required counter is unavailable.
      if (row.total === null || row.minutes === null) continue;
      total += row.total; if (!Number.isSafeInteger(total)) fail("total sum overflow");
      minutes += row.minutes; if (!Number.isSafeInteger(minutes)) fail("minutes sum overflow");
    }
  }
  return {request,snapshot_id:meta.snapshot_id,definition:request.metric === "goals" ? "goals" : "fpl_assists",series};
}
export function calculatePer90Leaders(metadataValue: unknown, seasonValue: unknown, metricValue: unknown, minMinutesValue: unknown, rowsValue: unknown): Per90LeadersResult {
  const meta = catalog(metadataValue);
  if (!season(seasonValue) || !meta.seasons.includes(seasonValue) || (metricValue !== "goals" && metricValue !== "assists") || !integer(minMinutesValue) || minMinutesValue > 20000) fail("leader selector");
  const rows = validateRows(meta,rowsValue), excluded: Per90LeadersResult["excluded"] = [], leaders: Per90Leader[] = [];
  for (const id of meta.person_ids) {
    const row = rows.get(JSON.stringify([id,seasonValue,metricValue]));
    let reason: Per90LeadersResult["excluded"][number]["reason"] | undefined;
    if (!row) reason="missing_row"; else if(row.total===null) reason="missing_numerator"; else if(row.minutes===null) reason="missing_minutes"; else if(row.minutes===0) reason="zero_minutes"; else if(row.minutes<minMinutesValue) reason="below_minimum";
    if(reason) { excluded.push({person_id:id,reason}); continue; }
    const rate=90*row!.total!/row!.minutes!; if(!Number.isFinite(rate)||!Number.isSafeInteger(90*row!.total!)) fail("rate overflow");
    leaders.push({person_id:id,total:row!.total!,minutes:row!.minutes!,rate,lineage:[...row!.lineage]});
  }
  leaders.sort((a,b)=>safeRateCompare(a,b) || b.minutes-a.minutes || (a.person_id < b.person_id ? -1 : a.person_id > b.person_id ? 1 : 0));
  return {snapshot_id:meta.snapshot_id,season:seasonValue,metric:metricValue,min_minutes:minMinutesValue,leaders:leaders.slice(0,50),excluded};
}
