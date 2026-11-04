import {describe,expect,it} from "vitest";
// @ts-expect-error Node test runtime module.
import {readFileSync} from "node:fs";
// @ts-expect-error Node test runtime module.
import {DatabaseSync} from "node:sqlite";
import {Hono} from "hono";
import {ackQuestion,claimQuestion,readQuestions,sweepQuestions,TRIAGE_CAPABILITY,type TriageDeps,type TriageResult} from "../worker/src/core/question-triage-bridge";
import {mapQuestionVerdict,requestCatalogDigest} from "../worker/src/core/question-request-intent";
import {D1QuestionTriageStore,resetQuestionSweepForTest,sweepQuestionBeforeRequest} from "../worker/src/routes/question-triage-sweep";
import {createQuestionTriageBridgeRouter,type QuestionTriageEnv} from "../worker/src/routes/question-triage-bridge";
type DB=InstanceType<typeof DatabaseSync>;
class Statement{
  values:unknown[]=[];constructor(readonly db:DB,readonly sql:string){}
  bind(...values:unknown[]){this.values=values;return this;}
  async first<T>(){return (this.db.prepare(this.sql).get(...this.values)??null) as T|null;}
  async all<T>(){return {results:this.db.prepare(this.sql).all(...this.values) as T[]};}
}
class SqliteD1{
  beforeBatch:(()=>void)|null=null;private tail:Promise<unknown>=Promise.resolve();
  constructor(readonly db:DB){}prepare(sql:string){return new Statement(this.db,sql);}
  batch(statements:Statement[]){const result=this.tail.then(async()=>{const hook=this.beforeBatch;this.beforeBatch=null;hook?.();this.db.exec("BEGIN");try{const results=[];for(const statement of statements)results.push(await statement.all());this.db.exec("COMMIT");return results;}catch(error){this.db.exec("ROLLBACK");throw error;}});this.tail=result.catch(()=>{});return result;}
}
const id="a".repeat(64),snapshot="b".repeat(64),caller={service:"triage_service",capability:TRIAGE_CAPABILITY};
const stamp=(ms:number)=>new Date(Math.floor(ms/1000)*1000).toISOString().replace(".000Z","Z");
const metadata={catalog_digest:await requestCatalogDigest(),data_snapshot_id:snapshot};
const wire=(kind:string,payload:unknown,version=2)=>JSON.stringify({version,kind,payload:version===2 && ["claim","ack"].includes(kind)?{...metadata,...payload as object}:payload});
function body(result:TriageResult){if(!result.ok)throw new Error(result.error);return JSON.parse(result.body);}
function verdict(missing=false){return {version:1,request_id:id,relevant:true,junk_reason:null as string|null,restated_question:"Show goals",tables:[{fields:["goals"],filters:{season:["2024-25"],competition:["PL"],person_id:missing?[]:["fpl:code:1"],opponent_id:[]}}],visuals:[{kind:"bar",table_index:0}],field_status:[],families:[]};}
function fixture(){
  resetQuestionSweepForTest();const db:DB=new DatabaseSync(":memory:"),clockDb:DB=new DatabaseSync(":memory:");db.exec("PRAGMA foreign_keys=ON");let now=Date.now(),lease=0;
  db.function("strftime",{varargs:true},(...args:(string|number|null)[])=>{const bound=args.map(arg=>arg==="now"?stamp(now):arg);return clockDb.prepare(`SELECT strftime(${bound.map(()=>"?").join(",")}) AS value`).get(...bound).value;});
  for(const name of ["0001_schema","0003_p16_dot_plot","0004_cache_slots","0005_account_question_history","0006_season_splits","0008_exploration_request_links","0009_manager_era_records","0010_question_requests","0011_opponent_labels","0012_cl_season_stage","0013_question_request_results","0014_question_request_clarifications","0015_question_request_notifications","0016_question_request_refresh","0017_exploration_null_checks"])db.exec(readFileSync(`infra/migrations/${name}.sql`,"utf8"));
  db.prepare("INSERT INTO snapshots(snapshot_id,created_at,sources_json,row_counts)VALUES(?,?,'{}','{}')").run(snapshot,stamp(now));
  db.prepare("INSERT INTO question_requests(request_id,account_sub,text,locale,text_hash,status,created_at,updated_at,expires_at)VALUES(?,'owner','Original question','en',?,'received',?,?,?)").run(id,snapshot,stamp(now),stamp(now),stamp(now+90*86400_000));
  const d1=new SqliteD1(db),store=new D1QuestionTriageStore(d1 as unknown as D1Database,2),legacyStore=new D1QuestionTriageStore(d1 as unknown as D1Database,1);
  const deps:TriageDeps={protocol:2,store,currentContext:async()=>({...metadata,data_snapshot_id:db.prepare("SELECT snapshot_id FROM snapshots ORDER BY created_at DESC LIMIT 1").get()?.snapshot_id??null}),now:()=>new Date(now),newLeaseId:()=>"lease-"+(++lease),cursorKey:new TextEncoder().encode("fixture")};
  deps.answerNow=async(row,value)=>{const mapped=await mapQuestionVerdict(value,{requestId:id,revision:row.revision+2,locale:row.locale,snapshotId:snapshot,resolvePerson:async p=>p});if(mapped.kind==="ready")return {state:"confirmation_required",specJson:JSON.stringify(mapped.spec),snapshotId:snapshot};if(mapped.kind==="clarification_required")return {state:mapped.kind,specJson:null,snapshotId:null};if(mapped.kind==="unsupported"||mapped.kind==="unavailable")return {state:mapped.kind,specJson:null,snapshotId:null};throw new Error("bad_fixture");};
  const legacy:TriageDeps={...deps,protocol:1,store:legacyStore,answerNow:undefined};
  const q=()=>db.prepare("SELECT * FROM question_requests WHERE request_id=?").get(id),r=()=>db.prepare("SELECT * FROM question_request_results WHERE request_id=?").get(id);
  const advance=(seconds:number)=>{now+=seconds*1000;};
  const claim=async()=>{const row=(await store.get(id))!;const request=wire("claim",{request_id:id,expected_revision:row.revision,expected_generation:row.generation,expected_attempt:row.attempt,operation_id:"qt:c-"+row.revision+"-"+row.generation});const result=body(await claimQuestion(deps,caller,request));return {request,question:result.payload.question};};
  const ackBody=(question:Record<string,unknown>,outcome:unknown={status:"verdict",verdict:verdict()})=>wire("ack",{request_id:id,expected_revision:question.revision,expected_generation:question.generation,attempt:question.attempt,lease_id:question.lease_id,operation_id:"qt:a-"+question.revision+"-"+question.generation,outcome});
  const ack=(question:Record<string,unknown>,value=verdict())=>ackQuestion(deps,caller,ackBody(question,{status:"verdict",verdict:value}));
  const requeue=(text="Latest clarified question")=>{
    advance(1);const parent=q(),sidecar=r();db.exec("BEGIN");try{
      db.prepare("UPDATE question_requests SET status='received',attempt=0,verdict_json=NULL,exploration_request_id=NULL,lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,claimed_at=NULL,retry_after=NULL,updated_at=?,revision=revision+1 WHERE request_id=?").run(stamp(now),id);
      const changed=db.prepare("UPDATE question_request_clarifications SET generation=?,parent_revision=?,text=?,submitted_at=? WHERE request_id=?").run(sidecar.clarification_count+1,parent.revision+1,text,stamp(now),id).changes;
      if(!changed)db.prepare("INSERT INTO question_request_clarifications(request_id,generation,parent_revision,text,submitted_at)VALUES(?,?,?,?,?)").run(id,sidecar.clarification_count+1,parent.revision+1,text,stamp(now));
      db.prepare("UPDATE question_request_results SET state='triaging',request_revision=?,clarification_count=clarification_count+1,spec_json=NULL,verified_json=NULL,attempt=0,lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=?,response_deadline=min(expires_at,strftime('%Y-%m-%dT%H:%M:%SZ',?,'+1 day')),revision=revision+1 WHERE request_id=?").run(parent.revision+1,stamp(now),stamp(now),id);db.exec("COMMIT");
    }catch(error){db.exec("ROLLBACK");throw error;}
  };
  const clarify=async()=>{const initial=await claim();await ack(initial.question,verdict(true));requeue();return initial;};
  return {db,d1,deps,legacy,store,legacyStore,q,r,advance,claim,ack,ackBody,requeue,clarify,now:()=>stamp(now)};
}
describe("generation-fenced triage v2",()=>{
  it.each(["bad/identifier","a".repeat(129)])("refuses context with invalid snapshot %s",async invalidSnapshot=>{
    const x=fixture(),app=new Hono<QuestionTriageEnv>();app.route("/",createQuestionTriageBridgeRouter(()=>caller));
    const env={DB:x.d1,BRIDGE_CURSOR_KEY:"fixture"};
    const request=()=>app.request("https://site.invalid/answer-now/context",{method:"POST",body:wire("context",{},1)},env as never);
    expect((await request()).status).toBe(200);
    x.db.prepare("UPDATE snapshots SET snapshot_id=? WHERE snapshot_id=?").run(invalidSnapshot,snapshot);
    const response=await request();expect(response.status).toBe(503);expect(await response.text()).toBe("Bridge unavailable.");
  });
  it("requires exact deployed metadata before claim or ack work",async()=>{
    const x=fixture(),p={request_id:id,expected_revision:1,expected_generation:0,expected_attempt:0,operation_id:"qt:metadata"};
    const missing=JSON.stringify({version:2,kind:"claim",payload:p});
    expect(await claimQuestion(x.deps,caller,missing)).toEqual({ok:false,error:"malformed"});
    for(const change of [{catalog_digest:"f".repeat(64)},{data_snapshot_id:"other"}])expect(body(await claimQuestion(x.deps,caller,wire("claim",{...p,...change}))).payload.outcome).toBe("conflict");
    expect(x.q().status).toBe("received");expect(x.db.prepare("SELECT count(*) n FROM exploration_bridge_operations").get().n).toBe(0);
    const c=await x.claim(),ack=JSON.parse(x.ackBody(c.question));ack.payload.catalog_digest="f".repeat(64);
    expect(body(await ackQuestion(x.deps,caller,JSON.stringify(ack))).payload.outcome).toBe("conflict");expect(x.q().status).toBe("triaging");
  });
  it("fences publication at the first claim write",async()=>{
    const x=fixture();x.d1.beforeBatch=()=>x.db.prepare("INSERT INTO snapshots(snapshot_id,created_at,sources_json,row_counts) VALUES(?,?,'{}','{}')").run("new-snapshot",stamp(Date.parse(x.now())+1000));
    const p={request_id:id,expected_revision:1,expected_generation:0,expected_attempt:0,operation_id:"qt:claim-race"};
    expect(body(await claimQuestion(x.deps,caller,wire("claim",p))).payload.outcome).toBe("conflict");expect(x.q().status).toBe("received");
    expect(x.db.prepare("SELECT count(*) n FROM exploration_bridge_operations").get().n).toBe(0);
  });
  it("fences publication at every ack outcome, including clarification and failure",async()=>{
    for(const outcome of [{status:"verdict",verdict:verdict()},{status:"verdict",verdict:verdict(true)},{status:"failed",reason:"source_unavailable"}]){
      const x=fixture(),c=await x.claim();x.d1.beforeBatch=()=>x.db.prepare("INSERT INTO snapshots(snapshot_id,created_at,sources_json,row_counts) VALUES(?,?,'{}','{}')").run("new-snapshot",stamp(Date.parse(x.now())+1000));
      expect(body(await ackQuestion(x.deps,caller,x.ackBody(c.question,outcome))).payload.outcome).toBe("conflict");
      expect(x.q().status).toBe("triaging");expect(x.r()).toBeUndefined();expect(x.db.prepare("SELECT count(*) n FROM exploration_bridge_operations WHERE operation_type='ack'").get().n).toBe(0);
    }
  });
  it("replays a settled ack after deployed metadata changes without reviving its claim",async()=>{
    const x=fixture(),c=await x.claim();const ack=x.ackBody(c.question);await ackQuestion(x.deps,caller,ack);
    x.deps.currentContext=async()=>({...metadata,catalog_digest:"f".repeat(64)});
    expect(body(await claimQuestion(x.deps,caller,c.request)).payload.outcome).toBe("conflict");expect(body(await ackQuestion(x.deps,caller,ack)).payload.outcome).toBe("replayed");
    const receipt=JSON.parse(x.db.prepare("SELECT response_json FROM exploration_bridge_operations WHERE operation_type='ack'").get().response_json).payload.receipt;
    expect(receipt).toMatchObject(metadata);expect(JSON.stringify(receipt)).not.toContain("Original question");
  });
  it("does not rebind old model work to a newer claim context",async()=>{
    const x=fixture(),c=await x.claim();x.db.prepare("INSERT INTO snapshots(snapshot_id,created_at,sources_json,row_counts) VALUES(?,?,'{}','{}')").run("new-snapshot",stamp(Date.parse(x.now())+1000));
    const request=JSON.parse(x.ackBody(c.question,{status:"failed",reason:"source_unavailable"}));request.payload.data_snapshot_id="new-snapshot";
    expect(body(await ackQuestion(x.deps,caller,JSON.stringify(request))).payload.outcome).toBe("conflict");expect(x.q().status).toBe("triaging");
  });
  it("replays stored claim and ack receipts after publication during receipt reads",async()=>{
    for(const kind of ["claim","ack"] as const){
      const x=fixture(),c=await x.claim(),ack=x.ackBody(c.question);if(kind==="ack")await ackQuestion(x.deps,caller,ack);
      const get=x.store.get.bind(x.store);x.store.get=async requestId=>{const row=await get(requestId);x.db.prepare("INSERT INTO snapshots(snapshot_id,created_at,sources_json,row_counts) VALUES(?,?,'{}','{}')").run("new-snapshot",stamp(Date.parse(x.now())+1000));return row;};
      const result=kind==="claim"?await claimQuestion(x.deps,caller,c.request):await ackQuestion(x.deps,caller,ack);
      expect(body(result).payload.outcome).toBe(kind==="claim"?"claimed":"replayed");
    }
  });
  it("uses fresh lease and retention clocks after replay receipt awaits",async()=>{
    const x=fixture(),c=await x.claim(),get=x.store.get.bind(x.store);
    x.store.get=async requestId=>{const value=await get(requestId);x.advance(901);return value;};
    expect(body(await claimQuestion(x.deps,caller,c.request)).payload.outcome).toBe("conflict");
    const y=fixture(),claimed=await y.claim(),ack=y.ackBody(claimed.question);await ackQuestion(y.deps,caller,ack);const read=y.store.get.bind(y.store);
    y.store.get=async requestId=>{const value=await read(requestId);y.advance(91*86400);return value;};
    expect(body(await ackQuestion(y.deps,caller,ack)).payload.outcome).toBe("conflict");
  });
  it.each(["claim","ack"] as const)("replays committed %s after snapshot publication without mutations or mapping",async kind=>{
    const x=fixture(),c=await x.claim(),ack=x.ackBody(c.question);
    if(kind==="ack")expect(body(await ackQuestion(x.deps,caller,ack)).payload.outcome).toBe("accepted");
    x.db.prepare("INSERT INTO snapshots(snapshot_id,created_at,sources_json,row_counts) VALUES(?,?,'{}','{}')").run("new-snapshot",stamp(Date.parse(x.now())+1000));
    const state=()=>x.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map((row:{name:string})=>({table:row.name,rows:x.db.prepare(`SELECT * FROM "${row.name}"`).all()}));
    const before=state();let mappings=0;
    x.deps.answerNow=async()=>{mappings++;throw new Error("replay_must_not_map");};
    x.deps.currentContext=async()=>{throw new Error("replay_must_not_read_current_context");};
    const request=kind==="claim"?c.request:ack;
    const invoke=(raw:string)=>kind==="claim"?claimQuestion(x.deps,caller,raw):ackQuestion(x.deps,caller,raw);
    expect(body(await invoke(request)).payload.outcome).toBe(kind==="claim"?"claimed":"replayed");
    expect(state()).toEqual(before);expect(mappings).toBe(0);
    const changed=JSON.parse(request);changed.payload.data_snapshot_id="new-snapshot";
    expect(body(await invoke(JSON.stringify(changed))).payload.outcome).toBe("conflict");
    expect(state()).toEqual(before);expect(mappings).toBe(0);
  });
  it.each(["claim","ack"] as const)("refuses unapplied stale %s after snapshot publication",async kind=>{
    const x=fixture();let request:string;
    if(kind==="ack"){const c=await x.claim();request=x.ackBody(c.question);}
    else request=wire("claim",{request_id:id,expected_revision:1,expected_generation:0,expected_attempt:0,operation_id:"qt:stale-new"});
    x.db.prepare("INSERT INTO snapshots(snapshot_id,created_at,sources_json,row_counts) VALUES(?,?,'{}','{}')").run("new-snapshot",stamp(Date.parse(x.now())+1000));
    const parent=x.q(),result=x.r(),operations=x.db.prepare("SELECT * FROM exploration_bridge_operations").all();let mappings=0;
    x.deps.answerNow=async()=>{mappings++;throw new Error("stale_must_not_map");};
    expect(body(await (kind==="claim"?claimQuestion(x.deps,caller,request):ackQuestion(x.deps,caller,request))).payload.outcome).toBe("conflict");
    expect(x.q()).toEqual(parent);expect(x.r()).toEqual(result);expect(x.db.prepare("SELECT * FROM exploration_bridge_operations").all()).toEqual(operations);expect(mappings).toBe(0);
  });
  it("reads and claims initial generation with bounded text-free receipts",async()=>{
    const x=fixture(),read=body(await readQuestions(x.deps,caller,wire("read",{cursor:null,limit:10})));
    expect(read.version).toBe(2);expect(read.payload.questions).toEqual([{request_id:id,locale:"en",text:"Original question",revision:1,generation:0,attempt:0}]);expect(JSON.stringify(read)).not.toContain("owner");
    const c=await x.claim();expect(c.question).toMatchObject({revision:2,generation:0,lease_id:"q2:lease-1"});
    expect(x.db.prepare("SELECT response_json FROM exploration_bridge_operations WHERE operation_type='claim'").get().response_json).not.toContain("Original question");
    expect(body(await x.ack(c.question)).payload.outcome).toBe("accepted");expect(x.r()).toMatchObject({state:"confirmation_required",request_revision:4});
  });
  it("uses the latest replacement and remaps the existing sidecar",async()=>{
    const x=fixture(),initial=await x.clarify();const read=body(await readQuestions(x.deps,caller,wire("read",{cursor:null,limit:10})));
    expect(read.payload.questions[0]).toMatchObject({text:"Latest clarified question",revision:5,generation:1,attempt:0});expect(body(await readQuestions(x.legacy,caller,wire("read",{cursor:null,limit:10},1))).payload.questions).toEqual([]);
    const c=await x.claim();expect(body(await claimQuestion(x.deps,caller,c.request)).payload.question.text).toBe("Latest clarified question");
    const request=x.ackBody(c.question);await ackQuestion(x.deps,caller,request);expect(x.r()).toMatchObject({state:"confirmation_required",request_revision:8,clarification_count:1,revision:3});expect(x.q()).toMatchObject({text:"Original question",text_hash:snapshot});
    x.db.exec("UPDATE question_request_results SET state='building',revision=revision+1");expect(body(await ackQuestion(x.deps,caller,request)).payload.outcome).toBe("replayed");
    expect(body(await x.ack(initial.question,verdict(true))).payload.outcome).toBe("conflict");expect(body(await claimQuestion(x.deps,caller,initial.request)).payload.outcome).toBe("conflict");
    for(const row of x.db.prepare("SELECT response_json FROM exploration_bridge_operations").all())expect(row.response_json).not.toContain("Latest clarified question");
  });
  it("refuses stale revisions, wrong generations and simultaneous claim losers",async()=>{
    const x=fixture();await x.clarify();
    for(const change of [{expected_revision:1},{expected_generation:0}])expect(body(await claimQuestion(x.deps,caller,wire("claim",{request_id:id,expected_revision:5,expected_generation:1,expected_attempt:0,operation_id:"qt:wrong",...change}))).payload.outcome).toBe("conflict");
    const request=(suffix:string)=>wire("claim",{request_id:id,expected_revision:5,expected_generation:1,expected_attempt:0,operation_id:"qt:concurrent-"+suffix});
    const replies=await Promise.all([claimQuestion(x.deps,caller,request("one")),claimQuestion(x.deps,caller,request("two"))]);expect(replies.map(r=>body(r).payload.outcome).sort()).toEqual(["claimed","conflict"]);
  });
  it("refuses claim replay after expiry and recovery",async()=>{
    const x=fixture();await x.clarify();const c=await x.claim();x.advance(901);expect(body(await claimQuestion(x.deps,caller,c.request)).payload.outcome).toBe("conflict");
    await sweepQuestions(x.deps,10,"expired");expect(x.q().status).toBe("received");expect(body(await claimQuestion(x.deps,caller,c.request)).payload.outcome).toBe("conflict");
  });
  it("prevents downgrade of an initial v2 lease into legacy family admission or recovery",async()=>{
    const x=fixture(),c=await x.claim();expect(x.r()).toBeUndefined();
    const family={...verdict(),families:["arrival_manager"]};const legacyAck=wire("ack",{request_id:id,attempt:1,lease_id:c.question.lease_id,operation_id:"qt:downgrade",outcome:{status:"verdict",verdict:family}},1);
    expect(body(await ackQuestion(x.legacy,caller,legacyAck)).payload.outcome).toBe("conflict");expect(x.db.prepare("SELECT count(*) n FROM exploration_shared_jobs").get().n).toBe(0);
    const row=(await x.store.get(id))!;expect(await x.legacyStore.ack({...row,managed:0},{...row,status:"filled",verdict_json:JSON.stringify(verdict()),lease_expires_at:null,revision:row.revision+2},{service:caller.service,type:"ack",operation_id:"qt:sql-downgrade",body_hash:snapshot,response:{},lease_id:row.lease_id},null,x.now())).toBe(false);
    x.advance(901);expect(await x.legacyStore.sweepRows("expired",x.now(),10)).toEqual([]);await sweepQuestions(x.deps,10,"expired");x.advance(300);
    expect(body(await readQuestions(x.legacy,caller,wire("read",{cursor:null,limit:10},1))).payload.questions).toEqual([]);
    expect(body(await claimQuestion(x.legacy,caller,wire("claim",{request_id:id,expected_attempt:1,operation_id:"qt:legacy-retry"},1))).payload.outcome).toBe("not_found");
  });
  it("uses database time to fence sweeps even when the application clock runs fast",async()=>{
    const x=fixture();await x.claim();const row=(await x.store.get(id))!,fast=stamp(Date.parse(x.now())+901_000);
    expect(await sweepQuestions({...x.deps,now:()=>new Date(fast)},10,"expired")).toEqual({moved:0});
    expect(await x.store.settle(row,{...row,status:"received",revision:row.revision+1,lease_expires_at:null,retry_after:stamp(Date.parse(fast)+300_000)},fast)).toBe(false);expect(x.q().status).toBe("triaging");
  });
  it("never accepts an old v1 receipt or replays a managed request through v1",async()=>{
    const x=fixture();const claimRequest=wire("claim",{request_id:id,expected_attempt:0,operation_id:"qt:old-claim"},1);
    const old=body(await claimQuestion(x.legacy,caller,claimRequest)).payload.question;
    const ackRequest=wire("ack",{request_id:id,attempt:old.attempt,lease_id:old.lease_id,operation_id:"qt:old-ack",outcome:{status:"verdict",verdict:verdict()}},1);
    await ackQuestion(x.legacy,caller,ackRequest);
    x.db.prepare("INSERT INTO question_request_results(request_id,request_revision,state,created_at,updated_at,response_deadline,expires_at)SELECT request_id,revision,'clarification_required',updated_at,updated_at,min(expires_at,strftime('%Y-%m-%dT%H:%M:%SZ',updated_at,'+1 day')),expires_at FROM question_requests").run();
    expect(body(await claimQuestion(x.legacy,caller,claimRequest)).payload.outcome).toBe("not_found");expect(body(await ackQuestion(x.legacy,caller,ackRequest)).payload.outcome).toBe("conflict");
    const v2ack=JSON.parse(ackRequest);v2ack.version=2;Object.assign(v2ack.payload,{...metadata,expected_revision:2,expected_generation:0});expect(body(await ackQuestion(x.deps,caller,JSON.stringify(v2ack))).payload.outcome).toBe("conflict");
  });
  it("does not replay the initial v1 answer-now receipt after a clarification generation",async()=>{
    const x=fixture(),answerNow:TriageDeps={...x.deps,protocol:1,store:x.legacyStore};
    const c=body(await claimQuestion(answerNow,caller,wire("claim",{request_id:id,expected_attempt:0,operation_id:"qt:initial-claim"},1))).payload.question;
    const ack=wire("ack",{request_id:id,attempt:c.attempt,lease_id:c.lease_id,operation_id:"qt:initial-ack",outcome:{status:"verdict",verdict:verdict(true)}},1);
    expect(body(await ackQuestion(answerNow,caller,ack)).payload.outcome).toBe("accepted");
    x.requeue();const parent=x.q(),result=x.r();
    expect(body(await ackQuestion(answerNow,caller,ack)).payload.outcome).toBe("conflict");expect(x.q()).toEqual(parent);expect(x.r()).toEqual(result);
  });
  it("does not replay a v2 receipt through the initial v1 answer-now exception",async()=>{
    const x=fixture(),c=await x.claim();await x.ack(c.question);
    const request=JSON.parse(x.ackBody(c.question));request.version=1;delete request.payload.expected_revision;delete request.payload.expected_generation;delete request.payload.catalog_digest;delete request.payload.data_snapshot_id;
    const parent=x.q(),result=x.r(),answerNow:TriageDeps={...x.deps,protocol:1,store:x.legacyStore};
    expect(body(await ackQuestion(answerNow,caller,JSON.stringify(request))).payload.outcome).toBe("conflict");
    expect(x.q()).toEqual(parent);expect(x.r()).toEqual(result);
  });
  it("excludes managed rows at SQL write and sweep boundaries even with stale caller metadata",async()=>{
    const x=fixture();await x.clarify();const row=(await x.store.get(id))!,fake={...row,managed:0};
    const next={...fake,status:"triaging",attempt:1,lease_id:"legacy-lease",lease_owner:caller.service,claimed_at:x.now(),lease_expires_at:stamp(Date.parse(x.now())+900_000),revision:fake.revision+1};
    expect(await x.legacyStore.claim(fake,next,{service:caller.service,type:"claim",operation_id:"qt:sql-claim",body_hash:snapshot,response:{},lease_id:"legacy-lease"})).toBe(false);expect(x.q().status).toBe("received");
    expect(await x.store.claim({...fake,generation:0,result_revision:0},next,{service:caller.service,type:"claim",operation_id:"qt:wrong-gen-sql",body_hash:snapshot,response:{},lease_id:"legacy-lease"})).toBe(false);
    await x.claim();const live=(await x.store.get(id))!;
    expect(await x.legacyStore.ack({...live,managed:0},{...live,status:"filled",verdict_json:JSON.stringify(verdict()),lease_expires_at:null,revision:live.revision+2},{service:caller.service,type:"ack",operation_id:"qt:sql-ack",body_hash:snapshot,response:{outcome:"accepted",status:"filled"},lease_id:live.lease_id},null,x.now())).toBe(false);
    x.advance(901);expect(await x.legacyStore.sweepRows("expired",x.now(),10)).toEqual([]);
    expect(await x.legacyStore.settle({...live,managed:0},{...live,status:"received",revision:live.revision+1,lease_expires_at:null,retry_after:stamp(Date.parse(x.now())+300_000)},x.now())).toBe(false);expect(x.q().status).toBe("triaging");
  });
  it("rolls back malformed remap acceptance and snapshot races",async()=>{
    const x=fixture();await x.clarify();const c=await x.claim();x.deps.answerNow=async()=>({state:"confirmation_required",specJson:"{}",snapshotId:snapshot});
    await expect(x.ack(c.question)).rejects.toThrow();expect(x.q()).toMatchObject({status:"triaging",revision:6});expect(x.r()).toMatchObject({state:"triaging",revision:2});
    const y=fixture();await y.clarify();const d=await y.claim();y.d1.beforeBatch=()=>y.db.prepare("INSERT INTO snapshots(snapshot_id,created_at,sources_json,row_counts)VALUES(?,?,'{}','{}')").run("c".repeat(64),stamp(Date.parse(y.now())+1000));
    expect(body(await y.ack(d.question)).payload.outcome).toBe("conflict");expect(y.q().status).toBe("triaging");
  });
  it("does not continue parent settlement when its first CAS changed zero rows",async()=>{
    const x=fixture();await x.clarify();const c=await x.claim();
    x.d1.beforeBatch=()=>x.db.prepare("UPDATE question_requests SET status='triaged',verdict_json=?,lease_expires_at=NULL,revision=revision+1 WHERE request_id=?").run(JSON.stringify(verdict()),id);
    expect(body(await x.ack(c.question)).payload.outcome).toBe("conflict");expect(x.q()).toMatchObject({status:"triaged",revision:7});expect(x.r().state).toBe("triaging");
  });
  it("settles requeued junk and bounded retry exhaustion",async()=>{
    const x=fixture();await x.clarify();const c=await x.claim();const junk={...verdict(),relevant:false,junk_reason:"off_topic",restated_question:"",tables:[],visuals:[],field_status:[],families:[]};
    await ackQuestion(x.deps,caller,x.ackBody(c.question,{status:"verdict",verdict:junk}));expect(x.r()).toMatchObject({state:"unsupported",spec_json:null,request_revision:x.q().revision});
    const y=fixture();await y.clarify();for(let attempt=1;attempt<=3;attempt++){const d=await y.claim();await ackQuestion(y.deps,caller,y.ackBody(d.question,{status:"failed",reason:"source_unavailable"}));if(attempt<3){expect(y.r().state).toBe("triaging");y.advance(attempt===1?300:1800);}}
    expect(y.r()).toMatchObject({state:"failed",spec_json:null,request_revision:y.q().revision});
  });
  it("separates sweep throttles and closes exhausted managed leases",async()=>{
    const x=fixture();await x.clarify();for(let attempt=1;attempt<3;attempt++){const c=await x.claim();await ackQuestion(x.deps,caller,x.ackBody(c.question,{status:"failed",reason:"validation_failed"}));x.advance(attempt===1?300:1800);}await x.claim();x.advance(901);
    expect(await sweepQuestionBeforeRequest(x.legacy)).toBe(true);expect(x.q().status).toBe("triaging");expect(await sweepQuestionBeforeRequest(x.deps)).toBe(true);expect(x.q().status).toBe("triage_failed");expect(x.r()).toMatchObject({state:"failed",request_revision:x.q().revision});
  });
  it("expires abandoned null-spec generations after an outage longer than a day",async()=>{
    const x=fixture();await x.clarify();await x.claim();x.advance(86401);
    expect(await sweepQuestions(x.deps,10,"expired")).toEqual({moved:2});expect(x.r()).toMatchObject({state:"expired",spec_json:null,lease_expires_at:null});
    expect(x.q()).toMatchObject({status:"received",attempt:1,lease_expires_at:null});
    expect(body(await readQuestions(x.deps,caller,wire("read",{cursor:null,limit:10}))).payload.questions).toEqual([]);
    expect(await sweepQuestions(x.deps,10,"expired")).toEqual({moved:0});
  });
  it.each([1,2,3])("recovers newly and already expired managed attempt%s without changing the expired result",async attempt=>{
    for(const alreadyExpired of [false,true]){
      const x=fixture();await x.clarify();
      for(let previous=1;previous<attempt;previous++){
        const c=await x.claim();await ackQuestion(x.deps,caller,x.ackBody(c.question,{status:"failed",reason:"source_unavailable"}));
        x.advance(previous===1?300:1800);
      }
      const leased=await x.claim(),parent=x.q();x.advance(86401);
      if(alreadyExpired)expect(await x.store.maintainResults(10)).toBe(1);
      const sidecar=x.r();
      expect(await sweepQuestions(x.deps,10,"expired")).toEqual({moved:alreadyExpired?1:2});
      expect(x.q()).toMatchObject({status:attempt===3?"triage_failed":"received",attempt,
        revision:parent.revision+1,lease_id:parent.lease_id,lease_owner:parent.lease_owner,
        account_sub:parent.account_sub,expires_at:parent.expires_at,lease_expires_at:null});
      expect(x.q().retry_after).toBe(attempt===3?null:stamp(Date.parse(parent.claimed_at)+86400_000));
      expect(x.r()).toEqual({...sidecar,state:"expired",revision:sidecar.revision+(alreadyExpired?0:1),updated_at:x.now()});
      const settled=x.q(),expired=x.r();
      expect(body(await readQuestions(x.deps,caller,wire("read",{cursor:null,limit:10}))).payload.questions).toEqual([]);
      expect(body(await claimQuestion(x.deps,caller,wire("claim",{request_id:id,expected_revision:settled.revision,
        expected_generation:expired.clarification_count,expected_attempt:Math.min(attempt,2),operation_id:"qt:expired-no-renew"}))).payload.outcome).not.toBe("claimed");
      expect(body(await x.ack(leased.question)).payload.outcome).toBe("conflict");
      expect(await sweepQuestions(x.deps,10,"expired")).toEqual({moved:0});
      expect(x.q()).toEqual(settled);expect(x.r()).toEqual(expired);
    }
  });
  it("recovers an expired parent after retention without renewing its sidecar",async()=>{
    const x=fixture();await x.clarify();await x.claim();const expiry=x.q().expires_at;x.advance(91*86400);
    expect(await sweepQuestions(x.deps,10,"expired")).toEqual({moved:2});
    expect(x.q()).toMatchObject({status:"received",expires_at:expiry});expect(x.r()).toMatchObject({state:"expired",expires_at:expiry});
    expect(body(await readQuestions(x.deps,caller,wire("read",{cursor:null,limit:10}))).payload.questions).toEqual([]);
  });
  it("keeps live managed leases fenced by database time after the sidecar expires",async()=>{
    const x=fixture();await x.clarify();x.advance(86350);await x.claim();x.advance(60);
    expect(await sweepQuestions(x.deps,10,"expired")).toEqual({moved:1});expect(x.r().state).toBe("expired");
    const live=x.q(),row=(await x.store.get(id))!,fast=stamp(Date.parse(x.now())+901_000);
    expect(await sweepQuestions({...x.deps,now:()=>new Date(fast)},10,"expired")).toEqual({moved:0});
    expect(await x.store.settle(row,{...row,status:"received",revision:row.revision+1,lease_expires_at:null,retry_after:fast},fast)).toBe(false);
    expect(x.q()).toEqual(live);x.advance(841);
    expect(await sweepQuestions(x.deps,10,"expired")).toEqual({moved:1});expect(x.q().status).toBe("received");
  });
  it("checks every parent and sidecar snapshot fence for expired cleanup",async()=>{
    const x=fixture();await x.clarify();await x.claim();x.advance(86401);expect(await x.store.maintainResults(10)).toBe(1);
    const row=(await x.store.get(id))!,before=x.q();
    const next={...row,status:"received",lease_expires_at:null,retry_after:stamp(Date.parse(row.claimed_at!)+86400_000),revision:row.revision+1};
    for(const change of [{revision:row.revision+1},{attempt:row.attempt+1},{account_sub:"other"},
      {lease_id:"q2:other"},{lease_owner:"other"},{result_revision:row.result_revision!+1},{generation:row.generation!+1}]){
      expect(await x.store.settle({...row,...change},next,x.now())).toBe(false);expect(x.q()).toEqual(before);
    }
    expect(await x.store.settle(row,next,x.now())).toBe(true);expect(x.r().state).toBe("expired");
  });
  it("continues unrelated recovery after maintenance aborts and retries maintenance later",async()=>{
    const x=fixture();await x.clarify();await x.claim();x.advance(86401);const other="c".repeat(64);
    x.db.prepare("INSERT INTO question_requests(request_id,account_sub,text,locale,text_hash,status,created_at,updated_at,expires_at)VALUES(?,'other','Other question','en',?,'received',?,?,?)")
      .run(other,snapshot,x.now(),x.now(),stamp(Date.parse(x.now())+90*86400_000));
    expect(body(await claimQuestion(x.deps,caller,wire("claim",{request_id:other,expected_revision:1,expected_generation:0,expected_attempt:0,operation_id:"qt:other"}))).payload.outcome).toBe("claimed");
    x.advance(901);x.db.exec("CREATE TEMP TRIGGER abort_result_maintenance BEFORE UPDATE ON question_request_results BEGIN SELECT RAISE(ABORT,'fixture maintenance abort');END");
    expect(await sweepQuestions(x.deps,10,"expired")).toEqual({moved:1});
    expect(x.db.prepare("SELECT status FROM question_requests WHERE request_id=?").get(other).status).toBe("received");
    expect(x.q().status).toBe("triaging");expect(x.r().state).toBe("triaging");
    x.db.exec("DROP TRIGGER abort_result_maintenance");
    expect(await sweepQuestions(x.deps,10,"expired")).toEqual({moved:2});expect(x.q().status).toBe("received");expect(x.r().state).toBe("expired");
  });
  it("closes stale confirmed work after a publication rather than repeatedly offering execution",async()=>{
    const x=fixture(),c=await x.claim();await x.ack(c.question);x.db.exec("UPDATE question_request_results SET state='building',revision=revision+1");
    x.db.prepare("INSERT INTO snapshots(snapshot_id,created_at,sources_json,row_counts)VALUES(?,?,'{}','{}')").run("c".repeat(64),stamp(Date.parse(x.now())+1000));
    expect(await sweepQuestions(x.deps,10,"expired")).toEqual({moved:1});expect(x.r()).toMatchObject({state:"stale",verified_json:null,lease_expires_at:null});
  });
  it("caps repeated ambiguity at generation three without renewing retention",async()=>{
    const x=fixture(),expiry=x.q().expires_at;for(let generation=0;generation<=3;generation++){const c=await x.claim();await x.ack(c.question,verdict(true));if(generation<3)x.requeue("Clarified "+generation);}
    expect(x.r()).toMatchObject({state:"unsupported",clarification_count:3,expires_at:expiry});expect(x.q().expires_at).toBe(expiry);
  });
  it("refuses fallback to original text when clarification metadata is corrupt",async()=>{
    const x=fixture();await x.clarify();x.db.exec("DROP TRIGGER question_request_clarifications_update; UPDATE question_request_clarifications SET parent_revision=999");
    expect(body(await readQuestions(x.deps,caller,wire("read",{cursor:null,limit:10}))).payload.questions).toEqual([]);expect(body(await claimQuestion(x.deps,caller,wire("claim",{request_id:id,expected_revision:5,expected_generation:1,expected_attempt:0,operation_id:"qt:corrupt"}))).payload.outcome).toBe("conflict");
  });
  it("binds cursor signatures to protocol as well as service",async()=>{
    const x=fixture();x.db.prepare("INSERT INTO question_requests(request_id,account_sub,text,locale,text_hash,status,created_at,updated_at,expires_at)VALUES(?,'other','Second question','en',?,'received',?,?,?)").run("c".repeat(64),"d".repeat(64),x.now(),x.now(),stamp(Date.parse(x.now())+90*86400_000));
    const v2=body(await readQuestions(x.deps,caller,wire("read",{cursor:null,limit:1}))).payload.next_cursor;expect(v2).toMatch(/^q2:/);
    expect(body(await readQuestions(x.deps,caller,wire("read",{cursor:v2,limit:1}))).payload.questions[0].request_id).toBe("c".repeat(64));
    const v1=body(await readQuestions(x.legacy,caller,wire("read",{cursor:null,limit:1},1))).payload.next_cursor;
    expect(await readQuestions(x.deps,caller,wire("read",{cursor:v1.replace("q1:","q2:"),limit:1}))).toEqual({ok:false,error:"invalid_cursor"});
  });
  it("does not reuse a cross-protocol operation ID after lease recovery",async()=>{
    const x=fixture(),old=wire("claim",{request_id:id,expected_attempt:0,operation_id:"qt:cross"},1);await claimQuestion(x.legacy,caller,old);x.advance(901);await sweepQuestions(x.legacy,10,"expired");x.advance(300);
    const row=(await x.store.get(id))!;expect(row.status).toBe("received");
    const result=await claimQuestion(x.deps,caller,wire("claim",{request_id:id,expected_revision:row.revision,expected_generation:0,expected_attempt:row.attempt,operation_id:"qt:cross"}));
    expect(body(result).payload.outcome).toBe("conflict");expect(x.q().status).toBe("received");
  });
  it("keeps v2 families out of exploration admission",async()=>{
    const x=fixture(),c=await x.claim(),v={...verdict(),families:["arrival_manager"]};await ackQuestion(x.deps,caller,x.ackBody(c.question,{status:"verdict",verdict:v}));
    expect(x.r().state).toBe("unsupported");expect(x.db.prepare("SELECT count(*) n FROM exploration_shared_jobs").get().n).toBe(0);
  });
  it("refuses malformed receipt result metadata instead of returning stored text",async()=>{
    const x=fixture(),c=await x.claim();const response={version:1,kind:"claim_result",payload:{receipt:{...metadata,protocol:2,request_id:id,generation:0,input_revision:1,applied_revision:2,lease_id:c.question.lease_id},result:{outcome:"claimed",question:{...c.question,text:"Do not leak"}}}};
    x.db.prepare("INSERT INTO exploration_bridge_operations(service,scope_key,operation_type,operation_id,body_hash,response_json,lease_id,created_at,expires_at)VALUES(?,?,'claim','qt:malformed',?,?,?,?,?)").run(caller.service,caller.service,snapshot,JSON.stringify(response),c.question.lease_id,x.now(),stamp(Date.parse(x.now())+30*86400_000));
    await expect(x.store.operation(caller.service,"claim","qt:malformed",id)).rejects.toThrow("invalid triage receipt");
  });
  it("returns explicit readiness failure until all014 guards are active",async()=>{
    const x=fixture(),app=new Hono<QuestionTriageEnv>();app.route("/",createQuestionTriageBridgeRouter(()=>caller));const env={DB:x.d1,BRIDGE_CURSOR_KEY:"fixture",BRIDGE_NOW:()=>new Date(x.now())};
    const request=()=>app.request("https://site.invalid/answer-now/read",{method:"POST",body:wire("read",{cursor:null,limit:10})},env as never);
    const r=await request();expect(r.status).toBe(200);expect((await r.json() as {version:number}).version).toBe(2);
    x.db.exec(readFileSync("infra/migrations/0010_question_requests.sql","utf8"));expect((await request()).status).toBe(503);
    x.db.exec(readFileSync("infra/migrations/0014_question_request_clarifications.sql","utf8"));x.db.exec("DROP TABLE question_request_clarifications");expect((await request()).status).toBe(503);expect(x.q().status).toBe("received");
  });
});
