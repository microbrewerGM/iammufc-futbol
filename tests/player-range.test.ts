import { describe, expect, it } from "vitest";
import { calculatePlayerRange, parsePlayerRangeRequest } from "../worker/src/core/player-range";
import type { PlayerRangeCatalog, PlayerRangeRequest, PlayerRangeRow } from "../worker/src/core/player-range";
const a = "fpl:code:101", b = "fpl:code:202";
const cat: PlayerRangeCatalog = { snapshot_id: "synthetic", person_ids: [a, b], seasons: ["2024-25", "2025-26"] };
const req: PlayerRangeRequest = { schema_version: 1, competition: "PL", person_ids: [a,b], seasons: cat.seasons,
  metric: "goals", normalization: "per90", min_minutes: 0, viz: "table" };
const row: PlayerRangeRow = { person_id: a, season: "2024-25", competition: "PL", metric: "goals", definition: "goals",
  total: 1, minutes: 90, snapshot_id: "synthetic", lineage: ["synthetic:one"] };
const rows = [row, { ...row, season: "2025-26", minutes: 180, lineage: ["synthetic:two"] }];
const run = (facts: unknown = rows, request: unknown = req, metadata: unknown = cat) => calculatePlayerRange(request, metadata, facts);
describe("player range", () => {
  it("uses the weighted oracle and preserves missing selected people", () => {
    const result = run(); const player = result.players[0]!;
    expect(player.total).toBe(2); expect(player.eligible_minutes).toBe(270);
    expect(player.rate).toBeCloseTo(2/3); expect(player.rate).not.toBe(.75);
    expect(player.comparable).toBe(true); expect(result.ranked_person_ids).toEqual([a]);
    expect(player.lineage).toEqual(["synthetic:one", "synthetic:two"]);
    expect(result.players[1]).toMatchObject({ person_id:b, total:null, rate:null, partial:true, comparable:false,
      missing_seasons:cat.seasons, eligible_minutes:0 });
  });
  it("canonicalizes copies, defaults thresholds and reopens identically", () => {
    const { min_minutes: _min, ...input } = req;
    const parsed = parsePlayerRangeRequest({ ...input, person_ids:[b,a], seasons:[...cat.seasons].reverse() }, cat);
    expect(parsed).toEqual({ ...req, min_minutes:450 });
    expect(input.seasons).toEqual(cat.seasons);
    expect(run(rows, parsed)).toEqual(run(rows, JSON.parse(JSON.stringify(parsed))));
    expect(parsePlayerRangeRequest({ ...input, normalization:"total" },cat).min_minutes).toBe(0);
  });
  it("keeps partial subtotals visible but excludes ranking", () => {
    const result = run([row]).players[0]!;
    expect(result).toMatchObject({ total:1, eligible_minutes:90, rate:1, comparable:false, partial:true,
      contributing_seasons:["2024-25"], missing_seasons:["2025-26"], reasons:["partial_subtotal"] });
    expect(result.cells[1]).toMatchObject({ total:null, minutes:null, reason:"missing_row" });
  });
  it("uses identical support for numerator and denominator", () => {
    const result = run([row,{ ...rows[1], total:null, minutes:1000 }]).players[0]!;
    expect(result.total).toBe(1); expect(result.eligible_minutes).toBe(90); expect(result.rate).toBe(1);
    expect(result.cells[1]).toMatchObject({ reason:"missing_support", total:null, minutes:1000 });
    expect(run([row,{...rows[1], total:99, minutes:null}]).players[0]!.total).toBe(1);
  });
  it("distinguishes complete zero, zero minutes, and minimum boundary", () => {
    const zero = run(rows.map(r => ({...r,total:0,minutes:0}))).players[0]!;
    expect(zero).toMatchObject({ total:0, rate:null, partial:false, comparable:false, reasons:["zero_minutes"] });
    expect(run(rows.map(r => ({...r,total:0}))).players[0]).toMatchObject({ total:0, rate:0, comparable:true });
    expect(run(rows,{...req,min_minutes:270}).players[0]!.comparable).toBe(true);
    expect(run(rows,{...req,min_minutes:271}).players[0]!.reasons).toContain("below_minimum");
    expect(run(rows.map(r => ({...r,total:0,minutes:0})),{...req,normalization:"total"}).players[0]!.comparable).toBe(true);
  });
  it("labels FPL assists and ranks exactly with stable ties", () => {
    const facts = [...rows,...rows.map(r => ({...r,person_id:b,total:2}))].map(r => ({...r,metric:"assists",definition:"fpl_assists"}));
    const result = run(facts,{...req,metric:"assists"});
    expect(result.definition).toBe("fpl_assists"); expect(result.ranked_person_ids).toEqual([b,a]);
    expect(run([...rows,...rows.map(r=>({...r,person_id:b}))]).ranked_person_ids).toEqual([a,b]);
    expect(run(facts,{...req,metric:"assists",normalization:"total"}).players[1]!.value).toBe(4);
  });
  it.each([
    null, {}, {...req,extra:1}, {...req,schema_version:2}, {...req,competition:"CL"}, {...req,metric:"minutes"},
    {...req,normalization:"average"}, {...req,viz:"sql"}, {...req,min_minutes:-1}, {...req,min_minutes:20001},
    {...req,min_minutes:NaN}, {...req,min_minutes:1.5}, {...req,min_minutes:undefined},
    {...req,person_ids:[a]}, {...req,person_ids:[a,a]}, {...req,person_ids:[a,"fpl:code:999"]},
    {...req,person_ids:Array(2)}, {...req,seasons:Array(1)}, {...req,seasons:[]},
    {...req,seasons:["2024-26"]}, {...req,seasons:["2023-24"]}, {...req,seasons:["2024-25","2024-25"]},
  ])("rejects invalid request %#", value => expect(()=>run(rows,value)).toThrow());
  it.each([
    {...row,extra:1}, {...row,person_id:"unknown"}, {...row,season:"2023-24"}, {...row,competition:"CL"},
    {...row,total:-1}, {...row,total:Infinity}, {...row,total:1.5}, {...row,minutes:-1}, {...row,minutes:NaN},
    {...row,snapshot_id:"other"}, {...row,definition:"official_assists"}, {...row,metric:"assists"},
    {...row,lineage:[]}, {...row,lineage:Array(1)}, {...row,lineage:["x","x"]}, {...row,lineage:[""]},
    {...row,lineage:Array(33).fill("x")}, null,
  ])("rejects invalid facts even outside selected metric %#", value => expect(()=>run([value])).toThrow());
  it("rejects duplicates, sparse rows, unsafe sums/rates and bounded input", () => {
    expect(()=>run([row,row])).toThrow("duplicate fact");
    expect(()=>run(Array(1))).toThrow(); expect(()=>run(Array(2049))).toThrow();
    expect(()=>run(rows.map(r=>({...r,total:Number.MAX_SAFE_INTEGER})))).toThrow("overflow");
    expect(()=>run(rows.map(r=>({...r,minutes:Number.MAX_SAFE_INTEGER})))).toThrow("overflow");
    expect(()=>run([{...row,total:Number.MAX_SAFE_INTEGER}])).toThrow("overflow");
  });
  it.each([
    {...cat,extra:1}, {...cat,snapshot_id:""}, {...cat,person_ids:[a,a]}, {...cat,person_ids:Array(2)},
    {...cat,seasons:["2024-26"]}, {...cat,seasons:Array(1)}, {...cat,seasons:["2024-25","2024-25"]},
  ])("rejects malformed metadata %#", metadata=>expect(()=>run([],req,metadata)).toThrow());
  it("accepts maximum selection, canonical order and threshold", () => {
    const people = [a,b,"fpl:code:303","fpl:code:404","fpl:code:505"];
    const seasons = Array.from({length:8},(_,i)=>`${2010+i}-${11+i}`);
    const metadata = {...cat,person_ids:people,seasons};
    expect(run([],{...req,person_ids:people,seasons,min_minutes:20000,viz:"bar"},metadata).players).toHaveLength(5);
    expect(()=>run([],{...req,person_ids:[...people,"fpl:code:606"]},metadata)).toThrow();
    expect(()=>run([],{...req,seasons:[...seasons,"2018-19"]},metadata)).toThrow();
  });
  it("does not mutate input or share caller arrays", () => {
    const before=JSON.stringify({req,cat,rows}); const result=run();
    result.players[0]!.cells[0]!.lineage.push("changed"); result.request.person_ids.reverse();
    expect(JSON.stringify({req,cat,rows})).toBe(before);
    expect(run([...rows].reverse())).toEqual(run());
  });
});
