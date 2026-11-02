import {describe,expect,it} from "vitest";
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
function fixture(){
  const db:DB=new DatabaseSync(":memory:"),clockDb:DB=new DatabaseSync(":memory:");db.exec("PRAGMA foreign_keys=ON");let time=Date.now();
  db.function("strftime",{varargs:true},(...args:(string|number|null)[])=>{const bound=args.map(arg=>arg==="now"?stamp(time):arg);return clockDb.prepare(`SELECT strftime(${bound.map(()=>"?").join(",")}) AS value`).get(...bound).value;});
  for(const name of ["0001_schema","0003_p16_dot_plot","0004_cache_slots","0005_account_question_history","0006_season_splits","0008_exploration_request_links","0009_manager_era_records","0010_question_requests","0011_opponent_labels","0012_cl_season_stage","0013_question_request_results","0014_question_request_clarifications"])db.exec(readFileSync(`infra/migrations/${name}.sql`,"utf8"));
  const seed=(request=id)=>{const now=stamp(time),expires=stamp(time+90*86400_000);
    db.prepare("INSERT INTO question_requests(request_id,account_sub,text,locale,text_hash,status,created_at,updated_at,expires_at)VALUES(?,'owner',?,'en',?,'received',?,?,?)").run(request,"Original question "+request.slice(-4),request,now,now,expires);
    db.prepare("UPDATE question_requests SET status='triaging',attempt=1,lease_id='q2:seed',lease_owner='service',claimed_at=?,lease_expires_at=?,revision=2 WHERE request_id=?").run(now,stamp(time+900_000),request);
    const verdict={version:1,request_id:request,relevant:true,junk_reason:null,restated_question:"Show goals",tables:[],visuals:[],field_status:[],families:[]};
    db.prepare("UPDATE question_requests SET status='triaged',verdict_json=?,lease_expires_at=NULL,revision=3 WHERE request_id=?").run(JSON.stringify(verdict),request);db.prepare("UPDATE question_requests SET status='no_data',revision=4 WHERE request_id=?").run(request);
    db.prepare("INSERT INTO question_request_results(request_id,request_revision,state,created_at,updated_at,response_deadline,expires_at)VALUES(?,4,'clarification_required',?,?,?,?)").run(request,now,now,stamp(time+86400_000),expires);
  };seed();const d1=new SqliteD1(db),env={DB:d1} as unknown as Env;
  const q=()=>db.prepare("SELECT * FROM question_requests WHERE request_id=?").get(id),r=()=>db.prepare("SELECT * FROM question_request_results WHERE request_id=?").get(id);
  return {db,d1,env,q,r,seed,now:()=>new Date(time),advance:(seconds:number)=>{time+=seconds*1000;}};
}
const access={ACCESS_ISSUER:"https://example.cloudflareaccess.com",ACCESS_AUD:"a".repeat(64),ACCESS_OWNER_EMAILS:"owner@example.invalid",ACCESS_SERVICE_CLIENT_IDS:"service"};
function app(identity:AccessIdentity={sub:"owner",email:"owner@example.invalid"}){const router=new Hono<RouteEnv>();router.use("*",accessGate(async()=>identity));router.route("/",createQuestionRequestsRouter());return router;}
const headers={"cf-access-jwt-assertion":"test",origin:"https://site.invalid","content-type":"application/x-www-form-urlencoded"};
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
});
describe("clarification HTTP boundary",()=>{
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
