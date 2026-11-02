import { describe,expect,it } from "vitest";
import { mapQuestionVerdict } from "../worker/src/core/question-request-intent";
import { readQuestionResultStatus } from "../worker/src/core/question-request-status";
import { Catalog } from "../worker/src/core/feasibility";
import { decodeCompiledCatalog } from "../worker/src/core/catalog-contract";
import compiled from "../worker/src/generated/catalog.json";
import type { Env } from "../worker/src/core/db";

const id="a".repeat(64),snapshot="b".repeat(64);
async function fixture() {
  const verdict={version:1,request_id:id,relevant:true,junk_reason:null,restated_question:"Untrusted restated goals question",tables:[{fields:["goals"],filters:{season:["2024-25"],competition:["PL"],person_id:["fpl:code:1"],opponent_id:[]}}],visuals:[{kind:"bar",table_index:0}],field_status:[{field:"goals",status:"available"}],families:[]};
  const mapped=await mapQuestionVerdict(verdict,{requestId:id,revision:4,locale:"en",snapshotId:snapshot,resolvePerson:async p=>p});
  if(mapped.kind!=="ready") throw new Error("fixture_not_ready");
  const row={request_id:id,request_revision:4,parent_revision:4,revision:1,state:"confirmation_required",spec_json:JSON.stringify(mapped.spec),verified_json:null as string|null,expires_at:"2027-01-01T00:00:00Z",parent_expires_at:"2027-01-01T00:00:00Z",response_deadline:"2026-11-03T00:00:00Z",db_now:"2026-11-02T00:00:00Z"};
  const data={snapshot,row,person:{person_id:"fpl:code:1",web_name:"Server <Player>"},duringIdentity:null as (()=>void)|null};
  const queries:{sql:string;args:unknown[]}[]=[];
  const DB={prepare:(sql:string)=>{let args:unknown[]=[];const statement={bind:(...v:unknown[])=>{args=v;queries.push({sql,args});return statement;},first:async()=>sql.includes("FROM question_request_results") ? args[1]==="owner" ? {...data.row,snapshot_id:data.snapshot} : null : sql.includes("FROM snapshots") ? {snapshot_id:data.snapshot} : null,all:async()=>{data.duringIdentity?.();return {results:[data.person]};}};return statement;}};
  return {row,data,mapped,queries,env:{DB} as unknown as Env};
}
describe("account-owned request status projection",()=>{
  it("resolves a current selection using only server identity and catalog",async()=>{
    const x=await fixture(),view=await readQuestionResultStatus(x.env,"owner",id,"es");
    expect(view).toMatchObject({requestId:id,revision:1,state:"confirmation_required",currentBinding:true,personLabel:"Server <Player>",intent:x.mapped.intent});
    expect(JSON.stringify(view)).not.toContain("Untrusted");
    expect(x.queries[0]!.args).toEqual([id,"owner"]);
    expect(x.queries[0]!.sql).not.toMatch(/q\.text|verdict_json|account_sub AS/);
  });
  it("does not resolve identities or disclose another account's request",async()=>{
    const x=await fixture();expect(await readQuestionResultStatus(x.env,"other",id,"en")).toBeUndefined();expect(x.queries).toHaveLength(1);
  });
  it.each(["generation","snapshot","catalog","renderer","path"])("suppresses actions for changed %s",async change=>{
    const x=await fixture();const spec={...x.mapped.spec};
    if(change==="generation") x.row.parent_revision++;
    if(change==="snapshot") x.data.snapshot="c".repeat(64);
    if(change==="catalog") spec.catalog_digest="d".repeat(64);
    if(change==="renderer") spec.renderer_version="old";
    if(change==="path") spec.result_path="https://attacker.invalid";
    x.row.spec_json=JSON.stringify(spec);
    expect(await readQuestionResultStatus(x.env,"owner",id,"en")).toMatchObject({state:"stale",currentBinding:false});
  });
  it("uses the database clock for both retention and response deadlines",async()=>{
    const x=await fixture();x.row.response_deadline=x.row.db_now;
    expect(await readQuestionResultStatus(x.env,"owner",id,"en")).toMatchObject({state:"expired",currentBinding:false});
    x.row.state="building";x.row.parent_expires_at=x.row.db_now;
    expect(await readQuestionResultStatus(x.env,"owner",id,"en")).toMatchObject({state:"expired"});
  });
  it.each(["snapshot","generation","deadline"])("rechecks %s after awaited identity resolution",async change=>{
    const x=await fixture();x.data.duringIdentity=()=>{if(change==="snapshot")x.data.snapshot="c".repeat(64);if(change==="generation")x.row.parent_revision++;if(change==="deadline")x.row.response_deadline=x.row.db_now;};
    const view=await readQuestionResultStatus(x.env,"owner",id,"en");expect(view?.state).toBe(change==="deadline"?"expired":"stale");expect(view?.currentBinding).toBe(false);
  });
  it("shows a localized released link only with finite, bound verified evidence",async()=>{
    const x=await fixture();x.row.state="released";
    expect(await readQuestionResultStatus(x.env,"owner",id,"es")).toMatchObject({state:"stale"});
    const evidence={artifact_key:x.mapped.spec.artifact_key,snapshot_id:snapshot,entity_id:"fpl:code:1",value:0,attribution:new Catalog(decodeCompiledCatalog(compiled)).checkFeasibility(x.mapped.intent,"en").attribution_text};
    x.row.verified_json=JSON.stringify(evidence);
    const result=await readQuestionResultStatus(x.env,"owner",id,"es");expect(result?.state).toBe("released");expect(result?.resultPath).toMatch(/^\/es\/q\?/);
    x.row.verified_json=JSON.stringify({...evidence,entity_id:"fpl:code:2"});
    expect(await readQuestionResultStatus(x.env,"owner",id,"es")).toMatchObject({state:"stale"});
  });
  it("does not advertise release evidence after publication during identity lookup",async()=>{
    const x=await fixture();x.row.state="released";x.row.verified_json=JSON.stringify({artifact_key:x.mapped.spec.artifact_key,snapshot_id:snapshot,entity_id:"fpl:code:1",value:0,attribution:new Catalog(decodeCompiledCatalog(compiled)).checkFeasibility(x.mapped.intent,"en").attribution_text});
    x.data.duringIdentity=()=>{x.data.snapshot="c".repeat(64);};
    const view=await readQuestionResultStatus(x.env,"owner",id,"es");expect(view).toMatchObject({state:"stale",currentBinding:false});expect(view?.resultPath).toBeUndefined();
  });
});
