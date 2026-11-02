import { describe, expect, it } from "vitest";
// @ts-expect-error Node test runtime module.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test runtime module.
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { ackQuestion, claimQuestion, TRIAGE_CAPABILITY, type TriageDeps } from "../worker/src/core/question-triage-bridge";
import { mapQuestionVerdict } from "../worker/src/core/question-request-intent";
import { D1QuestionTriageStore } from "../worker/src/routes/question-triage-sweep";
import { createQuestionTriageBridgeRouter, type QuestionTriageEnv } from "../worker/src/routes/question-triage-bridge";

type Db=InstanceType<typeof DatabaseSync>;
class Statement {
  values:unknown[]=[];
  constructor(readonly db:Db,readonly sql:string){}
  bind(...values:unknown[]){this.values=values;return this;}
  async first<T>(){return (this.db.prepare(this.sql).get(...this.values)??null) as T|null;}
  async all<T>(){return {results:this.db.prepare(this.sql).all(...this.values) as T[]};}
}
class SqliteD1 {
  beforeBatch:(()=>void)|null=null;
  constructor(readonly db:Db){}
  prepare(sql:string){return new Statement(this.db,sql);}
  async batch(statements:Statement[]){const hook=this.beforeBatch;this.beforeBatch=null;hook?.();this.db.exec("BEGIN");try{const result=[];for(const s of statements)result.push(await s.all());this.db.exec("COMMIT");return result;}catch(error){this.db.exec("ROLLBACK");throw error;}}
}
const id="a".repeat(64), snapshot="b".repeat(64), caller={service:"triage_service",capability:TRIAGE_CAPABILITY};
const stamp=(ms:number)=>new Date(Math.floor(ms/1000)*1000).toISOString().replace(".000Z","Z");
function verdict(){return {version:1,request_id:id,relevant:true,junk_reason:null,restated_question:"Show goals",tables:[{fields:["goals"],filters:{season:["2024-25"],competition:["PL"],person_id:["fpl:code:1"],opponent_id:[]}}],visuals:[{kind:"bar",table_index:0}],field_status:[],families:[] as string[]};}
function fixture(){
  const db:Db=new DatabaseSync(":memory:");db.exec("PRAGMA foreign_keys=ON");
  for(const name of ["0001_schema","0003_p16_dot_plot","0004_cache_slots","0005_account_question_history","0006_season_splits","0008_exploration_request_links","0009_manager_era_records","0010_question_requests","0011_opponent_labels","0012_cl_season_stage","0013_question_request_results"])db.exec(readFileSync(`infra/migrations/${name}.sql`,"utf8"));
  const now=stamp(Date.now()),expires=stamp(Date.parse(now)+90*86400_000);
  let time=Date.parse(now);const clockDb=new DatabaseSync(":memory:");
  db.function("strftime",{varargs:true},(...args:(string|number|null)[])=>{const bound=args.map(arg=>arg==="now"?stamp(time):arg);return clockDb.prepare(`SELECT strftime(${bound.map(()=>"?").join(",")}) AS value`).get(...bound).value;});
  db.prepare("INSERT INTO snapshots(snapshot_id,created_at,sources_json,row_counts) VALUES(?,?,'{}','{}')").run(snapshot,now);
  db.prepare("INSERT INTO question_requests(request_id,account_sub,text,locale,text_hash,status,created_at,updated_at,expires_at) VALUES(?,'owner','Show goals','en',?,'received',?,?,?)").run(id,snapshot,now,now,expires);
  const d1=new SqliteD1(db);
  const deps:TriageDeps={store:new D1QuestionTriageStore(d1 as unknown as D1Database),now:()=>new Date(time),newLeaseId:()=>"lease-1",cursorKey:new TextEncoder().encode("fixture")};
  deps.answerNow=async(row,v)=>{
    const mapped=await mapQuestionVerdict(v,{requestId:row.request_id,revision:row.revision+2,locale:row.locale,snapshotId:snapshot,resolvePerson:async p=>p});
    if(mapped.kind==="ready")return {state:"confirmation_required",specJson:JSON.stringify(mapped.spec),snapshotId:snapshot};
    if(mapped.kind==="clarification_required")return {state:mapped.kind,specJson:null,snapshotId:null};
    if(mapped.kind==="unsupported"||mapped.kind==="unavailable")return {state:mapped.kind,specJson:null,snapshotId:null};
    throw new Error("bad_fixture");
  };
  const claim=()=>claimQuestion(deps,caller,JSON.stringify({version:1,kind:"claim",payload:{request_id:id,expected_attempt:0,operation_id:"qt:claim"}}));
  const ack=(value=verdict())=>JSON.stringify({version:1,kind:"ack",payload:{request_id:id,attempt:1,lease_id:"lease-1",operation_id:"qt:ack",outcome:{status:"verdict",verdict:value}}});
  return {db,d1,deps,claim,ack,advance:(seconds:number)=>{time+=seconds*1000;}};
}
describe("answer-now triage transaction",()=>{
  it("atomically stores a confirmation proposal at the final parent revision",async()=>{
    const x=fixture();await x.claim();const result=await ackQuestion(x.deps,caller,x.ack());
    expect(result.ok).toBe(true);
    const row=x.db.prepare("SELECT * FROM question_request_results WHERE request_id=?").get(id);
    expect(row.state).toBe("confirmation_required");expect(row.request_revision).toBe(4);
    expect(JSON.parse(row.spec_json).request_revision).toBe(4);
    expect(x.db.prepare("SELECT status FROM question_requests").get().status).toBe("filled");
    await ackQuestion(x.deps,caller,x.ack());
    expect(x.db.prepare("SELECT count(*) n FROM question_request_results").get().n).toBe(1);
  });
  it("records unsupported families without queuing exploration or discarding the original verdict",async()=>{
    const x=fixture();await x.claim();const v=verdict();v.families=["arrival_manager"];
    await ackQuestion(x.deps,caller,x.ack(v));
    expect(x.db.prepare("SELECT state FROM question_request_results").get().state).toBe("unsupported");
    expect(x.db.prepare("SELECT count(*) n FROM exploration_shared_jobs").get().n).toBe(0);
    expect(JSON.parse(x.db.prepare("SELECT verdict_json FROM question_requests").get().verdict_json).families).toEqual(["arrival_manager"]);
  });
  it("keeps missing identity as clarification",async()=>{
    const x=fixture();await x.claim();const v=verdict();v.tables[0]!.filters.person_id=[];
    await ackQuestion(x.deps,caller,x.ack(v));
    expect(x.db.prepare("SELECT state FROM question_request_results").get().state).toBe("clarification_required");
  });
  it("rolls back parent and idempotency writes when the sidecar spec is invalid",async()=>{
    const x=fixture();await x.claim();x.deps.answerNow=async()=>({state:"confirmation_required",specJson:"{}",snapshotId:snapshot});
    await expect(ackQuestion(x.deps,caller,x.ack())).rejects.toThrow();
    expect(x.db.prepare("SELECT status,revision FROM question_requests").get()).toMatchObject({status:"triaging",revision:2});
    expect(x.db.prepare("SELECT count(*) n FROM exploration_bridge_operations WHERE operation_type='ack'").get().n).toBe(0);
  });
  it("refuses snapshot changes at the first transactional write",async()=>{
    const x=fixture();await x.claim();x.d1.beforeBatch=()=>x.db.prepare("INSERT INTO snapshots(snapshot_id,created_at,sources_json,row_counts) VALUES(?,?,'{}','{}')").run("c".repeat(64),stamp(Date.now()+1000));
    const result=await ackQuestion(x.deps,caller,x.ack());
    if(!result.ok)throw new Error(result.error);
    expect(JSON.parse(result.body).payload.outcome).toBe("conflict");
    expect(x.db.prepare("SELECT status FROM question_requests").get().status).toBe("triaging");
    expect(x.db.prepare("SELECT count(*) n FROM question_request_results").get().n).toBe(0);
  });
  it("does not replay a legacy ack as answer-now success",async()=>{
    const x=fixture();await x.claim();const legacy={...x.deps,answerNow:undefined};
    await ackQuestion(legacy,caller,x.ack());
    const result=await ackQuestion(x.deps,caller,x.ack());
    if(!result.ok)throw new Error(result.error);
    expect(JSON.parse(result.body).payload.outcome).toBe("conflict");
  });
  it("refuses a lease that expires immediately before the batch write",async()=>{
    const x=fixture();await x.claim();x.d1.beforeBatch=()=>x.advance(901);
    const result=await ackQuestion(x.deps,caller,x.ack());if(!result.ok)throw new Error(result.error);
    expect(JSON.parse(result.body).payload.outcome).toBe("conflict");
    expect(x.db.prepare("SELECT status FROM question_requests").get().status).toBe("triaging");
    expect(x.db.prepare("SELECT count(*) n FROM question_request_results").get().n).toBe(0);
  });
});
describe("answer-now context probe",()=>{
  it("denies an unrecognized caller before any database read",async()=>{
    const app=new Hono<QuestionTriageEnv>();app.route("/",createQuestionTriageBridgeRouter(()=>null));
    const response=await app.request("https://site.invalid/answer-now/context",{method:"POST",body:'{"version":1,"kind":"context","payload":{}}'},{} as never);
    expect(response.status).toBe(403);
  });
  it("checks schema readiness and returns only bounded server metadata",async()=>{
    const x=fixture(),app=new Hono<QuestionTriageEnv>();app.route("/",createQuestionTriageBridgeRouter(()=>caller));
    const response=await app.request("https://site.invalid/answer-now/context",{method:"POST",body:'{"version":1,"kind":"context","payload":{}}'},{DB:x.d1,BRIDGE_CURSOR_KEY:"fixture"} as never);
    expect(response.status).toBe(200);
    const body=await response.json() as {payload:{people:unknown[];catalog_digest:string}};
    expect(body.payload.people).toEqual([]);expect(body.payload.catalog_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(body)).not.toContain("Show goals");
  });
  it("accepts canonical Python-style key ordering",async()=>{
    const x=fixture(),app=new Hono<QuestionTriageEnv>();app.route("/",createQuestionTriageBridgeRouter(()=>caller));
    const response=await app.request("https://site.invalid/answer-now/context",{method:"POST",body:'{"kind":"context","payload":{},"version":1}'},{DB:x.d1,BRIDGE_CURSOR_KEY:"fixture"} as never);
    expect(response.status).toBe(200);
  });
});
