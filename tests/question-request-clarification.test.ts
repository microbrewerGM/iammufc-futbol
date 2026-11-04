import {describe,expect,it,vi} from "vitest";
// @ts-expect-error Node test runtime module.
import {readFileSync} from "node:fs";
// @ts-expect-error Node test runtime module.
import {DatabaseSync} from "node:sqlite";
import {Hono} from "hono";
import {clarifyQuestionResult} from "../worker/src/core/question-request-clarification";
import {readQuestionResultStatus} from "../worker/src/core/question-request-status";
import {storeQuestion} from "../worker/src/core/question-requests";
import {createQuestionRequestsRouter,type RouteEnv} from "../worker/src/routes/question-requests";
import {accessGate,type AccessIdentity} from "../worker/src/security/auth";
import type {Env} from "../worker/src/core/db";
import {ackQuestion,claimQuestion,sweepQuestions,TRIAGE_CAPABILITY,type TriageDeps,type TriageResult} from "../worker/src/core/question-triage-bridge";
import {D1QuestionTriageStore} from "../worker/src/routes/question-triage-sweep";
import {requestCatalogDigest} from "../worker/src/core/question-request-intent";
type DB=InstanceType<typeof DatabaseSync>;
const id="a".repeat(64),stamp=(ms:number)=>new Date(Math.floor(ms/1000)*1000).toISOString().replace(".000Z","Z");
class Statement{
  values:unknown[]=[];constructor(readonly db:DB,readonly sql:string){}
  bind(...values:unknown[]){this.values=values;return this;}
  async first<T>(){return (this.db.prepare(this.sql).get(...this.values)??null) as T|null;}
  async all<T>(){return {results:this.db.prepare(this.sql).all(...this.values) as T[]};}
  async run(){const result=this.db.prepare(this.sql).run(...this.values);return {success:true,meta:{changes:Number(result.changes)}};}
}
class SqliteD1{
  private tail:Promise<unknown>=Promise.resolve();beforeBatch:(()=>void)|null=null;
  constructor(readonly db:DB){}prepare(sql:string){return new Statement(this.db,sql);}
  batch(statements:Statement[]){const result=this.tail.then(async()=>{const hook=this.beforeBatch;this.beforeBatch=null;hook?.();this.db.exec("BEGIN");try{const results=[];for(const statement of statements)results.push(await statement.all());this.db.exec("COMMIT");return results;}catch(error){this.db.exec("ROLLBACK");throw error;}});this.tail=result.catch(()=>{});return result;}
}
function fixture(withResult=true){
  const db:DB=new DatabaseSync(":memory:"),clockDb:DB=new DatabaseSync(":memory:");db.exec("PRAGMA foreign_keys=ON");let time=Date.now();
  db.function("strftime",{varargs:true},(...args:(string|number|null)[])=>{const bound=args.map(arg=>arg==="now"?stamp(time):arg);return clockDb.prepare(`SELECT strftime(${bound.map(()=>"?").join(",")}) AS value`).get(...bound).value;});
  for(const name of ["0001_schema","0003_p16_dot_plot","0004_cache_slots","0005_account_question_history","0006_season_splits","0008_exploration_request_links","0009_manager_era_records","0010_question_requests","0011_opponent_labels","0012_cl_season_stage","0013_question_request_results","0014_question_request_clarifications"])db.exec(readFileSync(`infra/migrations/${name}.sql`,"utf8"));
  const seed=(request=id,result=true)=>{const now=stamp(time),expires=stamp(time+90*86400_000);
    db.prepare("INSERT INTO question_requests(request_id,account_sub,text,locale,text_hash,status,created_at,updated_at,expires_at)VALUES(?,'owner',?,'en',?,'received',?,?,?)").run(request,"Original question "+request.slice(-4),request,now,now,expires);
    if(!result)return;
    db.prepare("UPDATE question_requests SET status='triaging',attempt=1,lease_id='q2:seed',lease_owner='service',claimed_at=?,lease_expires_at=?,revision=2 WHERE request_id=?").run(now,stamp(time+900_000),request);
    const verdict={version:1,request_id:request,relevant:true,junk_reason:null,restated_question:"Show goals",tables:[],visuals:[],field_status:[],families:[]};
    db.prepare("UPDATE question_requests SET status='triaged',verdict_json=?,lease_expires_at=NULL,revision=3 WHERE request_id=?").run(JSON.stringify(verdict),request);db.prepare("UPDATE question_requests SET status='no_data',revision=4 WHERE request_id=?").run(request);
    db.prepare("INSERT INTO question_request_results(request_id,request_revision,state,created_at,updated_at,response_deadline,expires_at)VALUES(?,4,'clarification_required',?,?,?,?)").run(request,now,now,stamp(time+86400_000),expires);
  };seed(id,withResult);const d1=new SqliteD1(db),env={DB:d1} as unknown as Env;
  const q=()=>db.prepare("SELECT * FROM question_requests WHERE request_id=?").get(id),r=()=>db.prepare("SELECT * FROM question_request_results WHERE request_id=?").get(id);
  return {db,d1,env,q,r,seed,now:()=>new Date(time),advance:(seconds:number)=>{time+=seconds*1000;}};
}
const access={ACCESS_ISSUER:"https://example.cloudflareaccess.com",ACCESS_AUD:"a".repeat(64),ACCESS_OWNER_EMAILS:"owner@example.invalid",ACCESS_SERVICE_CLIENT_IDS:"service"};
function app(identity:AccessIdentity={sub:"owner",email:"owner@example.invalid"}){const router=new Hono<RouteEnv>();router.use("*",accessGate(async()=>identity));router.route("/",createQuestionRequestsRouter());return router;}
const headers={"cf-access-jwt-assertion":"test",origin:"https://site.invalid","content-type":"application/x-www-form-urlencoded"};
const caller={service:"triage_service",capability:TRIAGE_CAPABILITY};
const metadata={catalog_digest:await requestCatalogDigest(),data_snapshot_id:"clarification-fixture-snapshot"};
function response(result:TriageResult){if(!result.ok)throw new Error(result.error);return JSON.parse(result.body);}
function triage(x:ReturnType<typeof fixture>,protocol:1|2=2){
  let lease=0,operation=0;
  if(protocol===2)x.db.prepare("INSERT INTO snapshots(snapshot_id,created_at,sources_json,row_counts)VALUES(?,?,'{}','{}')").run(metadata.data_snapshot_id,stamp(x.now().getTime()));
  const store=new D1QuestionTriageStore(x.d1 as unknown as D1Database,protocol);
  const answerNow=vi.fn(async()=>({state:"clarification_required" as const,specJson:null,snapshotId:null}));
  const deps:TriageDeps={protocol,store,now:x.now,newLeaseId:()=>"fixture-"+(++lease),cursorKey:new TextEncoder().encode("fixture"),answerNow,
    ...(protocol===2?{currentContext:async()=>({...metadata,data_snapshot_id:x.db.prepare("SELECT snapshot_id FROM snapshots ORDER BY created_at DESC LIMIT 1").get()?.snapshot_id??null})}:{})};
  const wire=(kind:string,payload:unknown)=>JSON.stringify({version:protocol,kind,payload:protocol===2?{...metadata,...payload as object}:payload});
  const claim=async(request=id)=>{
    const row=(await store.get(request))!;
    const result=response(await claimQuestion(deps,caller,wire("claim",{request_id:request,expected_attempt:row.attempt,
      ...(protocol===2?{expected_revision:row.revision,expected_generation:row.generation}:{}),operation_id:"qt:c-"+(++operation)})));
    expect(result.payload.outcome).toBe("claimed");return result.payload.question;
  };
  const ackBody=(question:Record<string,unknown>,outcome:unknown={status:"failed",reason:"source_unavailable"})=>wire("ack",{
    request_id:question.request_id,attempt:question.attempt,lease_id:question.lease_id,
    ...(protocol===2?{expected_revision:question.revision,expected_generation:question.generation}:{}),operation_id:"qt:a-"+(++operation),outcome});
  return {store,deps,answerNow,claim,ackBody};
}
describe("requester-owned clarification",()=>{
  it("requeues atomically without changing original identity or retention",async()=>{
    const x=fixture(),before=x.q();expect(await clarifyQuestionResult(x.env,"owner",id,1,"Cafe\u0301 goals?")).toBe("accepted");
    for(const field of ["request_id","account_sub","text","text_hash","locale","created_at","expires_at"])expect(x.q()[field]).toBe(before[field]);
    expect(x.q()).toMatchObject({status:"received",revision:5,attempt:0,lease_id:null});expect(x.r()).toMatchObject({state:"triaging",revision:2,request_revision:5,clarification_count:1,spec_json:null,verified_json:null});
    expect(x.db.prepare("SELECT text FROM question_request_clarifications").get().text).toBe("Café goals?");expect(await clarifyQuestionResult(x.env,"owner",id,1,"Changed again")).toBe("conflict");
  });
  it("does not touch another account or stale/expired/capped requests",async()=>{
    const x=fixture();expect(await clarifyQuestionResult(x.env,"other",id,1,"Question")).toBe("not_found");expect(await clarifyQuestionResult(x.env,"owner",id,9,"Question")).toBe("conflict");
    x.advance(86400);expect(await clarifyQuestionResult(x.env,"owner",id,1,"Question")).toBe("conflict");expect(x.q().revision).toBe(4);
    const y=fixture();for(let generation=1;generation<=3;generation++){
      expect(await clarifyQuestionResult(y.env,"owner",id,y.r().revision,"Question "+generation)).toBe("accepted");
      const now=stamp(y.now().getTime());y.db.prepare("UPDATE question_requests SET status='triaging',attempt=1,lease_id=?,lease_owner='service',claimed_at=?,lease_expires_at=?,revision=revision+1").run("q2:round-"+generation,now,stamp(y.now().getTime()+900_000));
      y.db.prepare("UPDATE question_requests SET status='triaged',verdict_json=?,lease_expires_at=NULL,revision=revision+1").run(JSON.stringify({version:1,request_id:id,relevant:true,junk_reason:null,restated_question:"Show goals",tables:[],visuals:[],field_status:[],families:[]}));
      y.db.exec("UPDATE question_requests SET status='no_data',revision=revision+1");
      y.db.prepare("UPDATE question_request_results SET state=?,request_revision=?,updated_at=?,revision=revision+1").run(generation===3?"unsupported":"clarification_required",y.q().revision,now);
    }
    expect(await clarifyQuestionResult(y.env,"owner",id,y.r().revision,"Fourth question")).toBe("conflict");expect(y.r().clarification_count).toBe(3);
  });
  it("gives concurrent submissions one winner",async()=>{
    const x=fixture();expect((await Promise.all([clarifyQuestionResult(x.env,"owner",id,1,"First question"),clarifyQuestionResult(x.env,"owner",id,1,"Second question")])).sort()).toEqual(["accepted","conflict"]);expect(x.r().clarification_count).toBe(1);
  });
  it("rolls back a successful parent reset when the sidecar continuation is silently ignored",async()=>{
    const x=fixture();x.db.exec("CREATE TRIGGER ignore_remap BEFORE UPDATE ON question_request_results WHEN NEW.state='triaging' BEGIN SELECT RAISE(IGNORE); END");
    expect(await clarifyQuestionResult(x.env,"owner",id,1,"Private replacement")).toBe("unavailable");expect(x.q()).toMatchObject({status:"no_data",revision:4});expect(x.r()).toMatchObject({state:"clarification_required",revision:1});expect(x.db.prepare("SELECT count(*) n FROM question_request_clarifications").get().n).toBe(0);
  });
  it("rechecks database deadlines at the actual write",async()=>{
    const x=fixture();x.d1.beforeBatch=()=>x.advance(86400);expect(await clarifyQuestionResult(x.env,"owner",id,1,"Question")).toBe("conflict");expect(x.q().status).toBe("no_data");
  });
  it("projects triage and terminal states without stale generation confusion",async()=>{
    const x=fixture();const initial=await readQuestionResultStatus(x.env,"owner",id,"en");expect(initial).toMatchObject({state:"clarification_required",clarificationAvailable:true});
    await clarifyQuestionResult(x.env,"owner",id,1,"Clarified question");x.db.prepare("UPDATE question_requests SET status='triaging',attempt=1,lease_id='q2:active',lease_owner='service',claimed_at=?,lease_expires_at=?,revision=revision+1").run(stamp(x.now().getTime()),stamp(x.now().getTime()+900_000));
    expect(await readQuestionResultStatus(x.env,"owner",id,"en")).toMatchObject({state:"triaging",currentBinding:false});x.advance(86401);
    x.db.prepare("UPDATE question_request_results SET state='expired',updated_at=?,revision=revision+1").run(stamp(x.now().getTime()));expect(await readQuestionResultStatus(x.env,"owner",id,"en")).toMatchObject({state:"expired",currentBinding:false});
  });
  it("counts active sidecars even when their legacy parents look terminal",async()=>{
    const x=fixture();for(let n=1;n<20;n++)x.seed(n.toString(16).padStart(64,"0"));expect(await storeQuestion(x.env,"owner","New question","en",x.now())).toEqual({kind:"pending_limit"});
  });
  it("releases pending quota for terminal managed parents after an outage",async()=>{
    const x=fixture();const ids=[id,...Array.from({length:19},(_,n)=>(n+1).toString(16).padStart(64,"0"))];for(const request of ids.slice(1))x.seed(request);
    for(const request of ids)expect(await clarifyQuestionResult(x.env,"owner",request,1,"Replacement question")).toBe("accepted");x.advance(86401);
    x.db.prepare("UPDATE question_request_results SET state='expired',updated_at=?,revision=revision+1").run(stamp(x.now().getTime()));
    expect((await storeQuestion(x.env,"owner","New question","en",x.now())).kind).toBe("stored");
  });
  it("rejects the initial v1 acknowledgement after a real clarification",async()=>{
    const x=fixture(false),t=triage(x,1),question=await t.claim();
    const verdict={version:1,request_id:id,relevant:true,junk_reason:null,restated_question:"Show goals",tables:[],visuals:[],field_status:[],families:[]};
    const ack=t.ackBody(question,{status:"verdict",verdict});
    expect(response(await ackQuestion(t.deps,caller,ack)).payload.outcome).toBe("accepted");
    expect(response(await ackQuestion(t.deps,caller,ack)).payload.outcome).toBe("replayed");
    expect(await clarifyQuestionResult(x.env,"owner",id,x.r().revision,"Replacement question")).toBe("accepted");
    const saved=()=>["question_requests","question_request_results","question_request_clarifications","exploration_bridge_operations"].map(table=>x.db.prepare(`SELECT * FROM ${table}`).all());
    const before=saved();t.answerNow.mockClear();
    expect(response(await ackQuestion(t.deps,caller,ack)).payload.outcome).toBe("conflict");
    expect(saved()).toEqual(before);expect(t.answerNow).not.toHaveBeenCalled();
    expect(x.r()).toMatchObject({state:"triaging",clarification_count:1,spec_json:null,verified_json:null});
  });
  it.each([1,2,3])("keeps expired clarification actions suppressed after attempt%s recovery",async attempt=>{
    for(const alreadyExpired of [false,true]){
      const x=fixture(),t=triage(x);
      expect(await clarifyQuestionResult(x.env,"owner",id,1,"Replacement question")).toBe("accepted");
      for(let previous=1;previous<attempt;previous++){
        const question=await t.claim();
        expect(response(await ackQuestion(t.deps,caller,t.ackBody(question))).payload.outcome).toBe("accepted");
        x.advance(previous===1?300:1800);
      }
      const question=await t.claim(),oldAck=t.ackBody(question),parent=x.q();x.advance(86401);
      if(alreadyExpired)expect(await t.store.maintainResults(10)).toBe(1);
      expect(await sweepQuestions(t.deps,10,"expired")).toEqual({moved:alreadyExpired?1:2});
      expect(x.q()).toMatchObject({status:attempt===3?"triage_failed":"received",attempt,account_sub:parent.account_sub,
        expires_at:parent.expires_at,lease_id:parent.lease_id,lease_owner:parent.lease_owner,lease_expires_at:null});
      expect(x.r()).toMatchObject({state:"expired",clarification_count:1,spec_json:null,verified_json:null});
      for(const locale of ["en","es"] as const){
        expect(await readQuestionResultStatus(x.env,"owner",id,locale)).toMatchObject({state:"expired",clarificationAvailable:false,currentBinding:false});
        const page=await app().request(`https://site.invalid/${locale}/requests?id=${id}`,{headers},{...x.env,...access} as never);
        expect(page.status).toBe(200);const html=await page.text();
        expect(html).toContain(locale==="en"?"This request has expired":"Esta solicitud ha caducado");
        expect(html).not.toContain(`/requests/${id}/clarify`);expect(html).not.toContain(`/requests/${id}/confirm`);expect(html).not.toContain("Replacement question");
        expect((await app().request(`https://site.invalid/${locale}/requests/${id}/clarify`,{method:"POST",headers,
          body:`expected_revision=${x.r().revision}&text=Another+question`},{...x.env,...access} as never)).status).toBe(409);
      }
      expect(response(await ackQuestion(t.deps,caller,oldAck)).payload.outcome).toBe("conflict");
      expect(await sweepQuestions(t.deps,10,"expired")).toEqual({moved:0});
    }
  });
  it("releases pending quota after expired managed parents recover to received",async()=>{
    const x=fixture(),t=triage(x),ids=[id,...Array.from({length:19},(_,n)=>(n+1).toString(16).padStart(64,"0"))];
    for(const request of ids.slice(1))x.seed(request);
    for(const request of ids){expect(await clarifyQuestionResult(x.env,"owner",request,1,"Replacement question")).toBe("accepted");await t.claim(request);}
    expect(await storeQuestion(x.env,"owner","New question","en",x.now())).toEqual({kind:"pending_limit"});
    x.advance(86401);expect(await sweepQuestions(t.deps,100,"expired")).toEqual({moved:40});
    expect(x.db.prepare("SELECT count(*) n FROM question_requests WHERE status='received'").get().n).toBe(20);
    expect(x.db.prepare("SELECT count(*) n FROM question_request_results WHERE state='expired'").get().n).toBe(20);
    expect((await storeQuestion(x.env,"owner","New question","en",x.now())).kind).toBe("stored");
  });
});
describe("clarification HTTP boundary",()=>{
  it.each(["question_request_clarifications_insert","question_request_clarifications_update","question_request_clarifications_no_replace",
    "question_request_clarifications_retention","question_requests_clarification_state_machine","question_requests_clarification_clock_update",
    "question_request_results_generation_transition","question_request_results_spec_update"])("suppresses the form and writes without required trigger %s",async trigger=>{
    const x=fixture();x.db.exec(`DROP TRIGGER ${trigger}`);
    for(const locale of ["en","es"] as const){
      const page=await app().request(`https://site.invalid/${locale}/requests?id=${id}`,{headers},{...x.env,...access} as never);
      expect(page.status).toBe(200);expect(await page.text()).not.toContain(`/requests/${id}/clarify`);
      expect((await app().request(`https://site.invalid/${locale}/requests/${id}/clarify`,{method:"POST",headers,
        body:"expected_revision=1&text=Replacement+question"},{...x.env,...access} as never)).status).toBe(503);
    }
    expect(x.q()).toMatchObject({status:"no_data",revision:4});
    expect(x.r()).toMatchObject({state:"clarification_required",revision:1,clarification_count:0});
    expect(x.db.prepare("SELECT count(*) n FROM question_request_clarifications").get().n).toBe(0);
  });
  it("renders localized clarification and redirects an accepted submission",async()=>{
    const x=fixture(),env={...x.env,...access};const get=await app().request("https://site.invalid/es/requests?id="+id,{headers},env as never);expect(await get.text()).toContain(`/es/requests/${id}/clarify`);
    const result=await app().request(`https://site.invalid/es/requests/${id}/clarify`,{method:"POST",headers,body:"expected_revision=1&text=Private+replacement"},env as never);expect(result.status).toBe(303);expect(result.headers.get("location")).toBe(`/es/requests?id=${id}`);
    const status=await app().request(result.headers.get("location")!,{headers},env as never);const html=await status.text();expect(html).toContain("Revisando tu aclaración");expect(html).not.toContain("Private replacement");
  });
  it.each(["expected_revision=1&text=Question&text=Other","expected_revision=1%0D&text=Question","expected_revision=1&text=Question&extra=x","expected_revision=1&text="])("refuses noncanonical or extra fields",async body=>{
    const x=fixture();expect((await app().request(`https://site.invalid/en/requests/${id}/clarify`,{method:"POST",headers,body},{...x.env,...access} as never)).status).toBe(400);expect(x.q().revision).toBe(4);
  });
  it("denies service/cross-account/cross-origin calls and oversized bodies",async()=>{
    const x=fixture(),url=`https://site.invalid/en/requests/${id}/clarify`,init={method:"POST",headers,body:"expected_revision=1&text=Question"},env={...x.env,...access};
    expect((await app({sub:"",serviceClientId:"service"}).request(url,init,env as never)).status).toBe(403);
    expect((await app({sub:"other",email:"owner@example.invalid"}).request(url,init,env as never)).status).toBe(404);
    expect((await app().request(url,{...init,headers:{...headers,origin:"https://other.invalid"}},env as never)).status).toBe(403);
    expect((await app().request(url,{...init,body:"x".repeat(8193)},env as never)).status).toBe(413);expect(x.q().revision).toBe(4);
  });
});
