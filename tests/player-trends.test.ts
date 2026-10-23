import {describe,it,expect} from "vitest";
import {calculatePlayerTrends,calculatePer90Leaders,parsePlayerTrendsRequest} from "../worker/src/core/player-trends";
const a="fpl:code:10", b="fpl:code:20", c="fpl:code:30";
const meta={snapshot_id:"s1",person_ids:[a,b,c],seasons:["2023-24","2024-25"]};
const request={schema_version:1,competition:"PL",person_ids:[b,a],seasons:["2024-25","2023-24"],metric:"goals",normalization:"per90",min_minutes:450,viz:"line"};
const row=(person_id:string,season:string,total:number|null,minutes:number|null)=>({person_id,season,competition:"PL",metric:"goals",definition:"goals",total,minutes,snapshot_id:"s1",lineage:[`${person_id}/${season}`]});
describe("player trends",()=>{
 it("canonicalizes identity and season order and keeps gaps distinct",()=>{
  const result=calculatePlayerTrends({...request,min_minutes:0},meta,[row(a,"2024-25",2,450),row(a,"2023-24",0,90)]);
  expect(result.series[0]!.person_id).toBe(a); expect(result.request.seasons).toEqual(["2023-24","2024-25"]);
  expect(result.series[0]!.cells.map(x=>x.rate)).toEqual([0,.4]); expect(result.series[1]!.cells[0]!.reason).toBe("missing_row");
 });
 it("reports all per season exclusions and threshold-zero handling",()=>{
  const result=calculatePlayerTrends({...request,min_minutes:0},meta,[row(a,"2023-24",1,0),row(a,"2024-25",null,500),row(b,"2023-24",1,449),row(b,"2024-25",1,null)]);
  expect(result.series[0]!.cells.map(c=>c.reason)).toEqual(["zero_minutes","missing_numerator"]);
  expect(result.series[1]!.cells.map(c=>c.reason)).toEqual(["supported","missing_minutes"]);
 });
 it("rejects bounds, malformed selectors, duplicate facts and mixed snapshots",()=>{
  expect(()=>parsePlayerTrendsRequest({...request,person_ids:[a,a]},meta)).toThrow();
  expect(()=>parsePlayerTrendsRequest({...request,extra:true},meta)).toThrow();
  expect(()=>parsePlayerTrendsRequest({...request,normalization:"total",min_minutes:1},meta)).toThrow();
  expect(()=>calculatePlayerTrends(request,meta,[row(a,"2024-25",1,450),row(a,"2024-25",1,450)])).toThrow();
  expect(()=>calculatePlayerTrends(request,meta,[{...row(a,"2024-25",1,450),snapshot_id:"s2"}])).toThrow();
  expect(()=>calculatePlayerTrends(request,meta,Array(41).fill(row(a,"2024-25",1,450)))).toThrow();
 });
 it("ranks leaders by rate, minutes, then canonical ID and reports exclusions",()=>{
  const facts=[row(a,"2024-25",2,450),row(b,"2024-25",1,225),row(c,"2024-25",0,449)];
  const result=calculatePer90Leaders(meta,"2024-25","goals",450,facts);
  expect(result.leaders.map(x=>x.person_id)).toEqual([a]);
  expect(result.excluded).toEqual([{person_id:b,reason:"below_minimum"},{person_id:c,reason:"below_minimum"}]);
 });
 it("is deterministic, validates bad counters, and handles empty input",()=>{
  const one=calculatePlayerTrends(request,meta,[]), two=calculatePlayerTrends(request,meta,[]);
  expect(JSON.stringify(one)).toBe(JSON.stringify(two)); expect(one.series[0]!.cells[0]!.reason).toBe("missing_row");
  expect(()=>calculatePlayerTrends(request,meta,[row(a,"2024-25",-1,90)])).toThrow();
  expect(()=>calculatePlayerTrends(request,meta,[row(a,"2024-25",Number.MAX_SAFE_INTEGER,1)])).toThrow();
 });
});
