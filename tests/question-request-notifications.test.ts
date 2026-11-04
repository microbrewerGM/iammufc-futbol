import {describe,it,expect} from "vitest";
// @ts-expect-error Node test runtime module.
import {readFileSync} from "node:fs";
// @ts-expect-error Node test runtime module.
import {DatabaseSync} from "node:sqlite";
import {Hono} from "hono";
import {handleNotification,type NotificationOperation} from "../worker/src/core/question-request-notifications";
import {createQuestionTriageBridgeRouter,type QuestionTriageEnv} from "../worker/src/routes/question-triage-bridge";
import {TRIAGE_CAPABILITY} from "../worker/src/core/question-triage-bridge";
import type {Env} from "../worker/src/core/db";
import {mapQuestionVerdict} from "../worker/src/core/question-request-intent";
import {Catalog} from "../worker/src/core/feasibility";
import {decodeCompiledCatalog} from "../worker/src/core/catalog-contract";
import compiled from "../worker/src/generated/catalog.json";
type DB=InstanceType<typeof DatabaseSync>;
const id="a".repeat(64),caller={service:"notify_service",capability:TRIAGE_CAPABILITY};
const iso=(n:number)=>new Date(Math.floor(n/1000)*1000).toISOString().replace(".000Z","Z");
function fixture(count=1){
  const db:DB=new DatabaseSync(":memory:"),clockDb:DB=new DatabaseSync(":memory:");db.exec("PRAGMA foreign_keys=ON");let clock=Date.now(),queries=0,nonce=0;
  let beforeWrite:((sql:string)=>void)|null=null,afterRead:((sql:string)=>void)|null=null;
  db.function("strftime",{varargs:true},(...args:(string|number|null)[])=>{const bound=args.map(a=>a==="now"?iso(clock):a);return clockDb.prepare(`SELECT strftime(${bound.map(()=>"?").join(",")}) AS value`).get(...bound).value;});
  for(const name of ["0001_schema","0003_p16_dot_plot","0004_cache_slots","0005_account_question_history","0006_season_splits","0008_exploration_request_links","0009_manager_era_records","0010_question_requests","0011_opponent_labels","0012_cl_season_stage","0013_question_request_results","0014_question_request_clarifications","0015_question_request_notifications"])db.exec(readFileSync(`infra/migrations/${name}.sql`,"utf8"));
  const expires=iso(clock+90*86400_000);
  db.prepare("INSERT INTO snapshots(snapshot_id,created_at,sources_json,row_counts)VALUES('snapshot-1',?,'{}','{}')").run(iso(clock));
  const parent=(requestId:string)=>{
    db.prepare("INSERT INTO question_requests(request_id,account_sub,text,locale,text_hash,status,created_at,updated_at,expires_at)VALUES(?,'private-account','PRIVATE ORIGINAL QUESTION','en',?,'received',?,?,?)").run(requestId,requestId,iso(clock),iso(clock),expires);
    db.prepare("UPDATE question_requests SET status='triaging',attempt=1,lease_id='q2:triage',lease_owner='triage',lease_expires_at=?,claimed_at=?,revision=revision+1 WHERE request_id=?").run(iso(clock+900_000),iso(clock),requestId);
  };
  for(let n=0;n<count;n++)parent(n===0?id:n.toString(16).padStart(64,"0"));
  class Statement {
    values:unknown[]=[];constructor(readonly sql:string){}
    bind(...values:unknown[]){this.values=values;return this;}
    execute(first:boolean){queries++;if(!/^SELECT/i.test(this.sql)){const hook=beforeWrite;beforeWrite=null;hook?.(this.sql);}const stmt=db.prepare(this.sql),result=first?stmt.get(...this.values)??null:stmt.all(...this.values);
      if(/^SELECT/i.test(this.sql))afterRead?.(this.sql);return result;}
    async first<T>(){return this.execute(true) as T|null;}
    async all<T>(){return {results:this.execute(false) as T[]};}
  }
  const env={DB:{prepare:(sql:string)=>new Statement(sql)}} as unknown as Env;
  const wire=(kind:NotificationOperation,payload:unknown)=>JSON.stringify({version:1,kind:"notify_"+kind,payload});
  const call=async(kind:NotificationOperation,payload:unknown,identity=caller)=>{const result=await handleNotification(env,identity,kind,wire(kind,payload),()=>"lease-"+(++nonce));return {status:result.status,...JSON.parse(result.body)};};
  const read=()=>call("read",{limit:10});
  const prepare=async()=>{const result=await read();return call("prepare",{request_id:id,expected_revision:result.payload.items.find((item:{request_id:string})=>item.request_id===id).revision});};
  const fields=(grant:{payload:{revision:number;lease_id:string}})=>({request_id:id,expected_revision:grant.payload.revision,lease_id:grant.payload.lease_id});
  const bind=(grant:Parameters<typeof fields>[0],issue=101)=>call("bind",{...fields(grant),issue_number:issue});
  const ack=(grant:Parameters<typeof fields>[0],outcome="delivered")=>call("ack",{...fields(grant),outcome});
  const settle=(requestId=id)=>{const verdict={version:1,request_id:requestId,relevant:false,junk_reason:"off_topic",restated_question:"",tables:[],visuals:[],field_status:[],families:[]};db.prepare("UPDATE question_requests SET status='junk',verdict_json=?,lease_expires_at=NULL,revision=revision+1,updated_at=? WHERE request_id=?").run(JSON.stringify(verdict),iso(clock),requestId);};
  const row=()=>db.prepare("SELECT * FROM question_request_notifications WHERE request_id=?").get(id);
  const release=async(requestId=id,confirmationOnly=false,badCatalog=false)=>{
    db.exec("INSERT OR IGNORE INTO players(player_id,fpl_element,season,web_name,first_name,second_name,position,team)VALUES('fpl:1:2024-25',1,'2024-25','PRIVATE PLAYER LABEL','Private','Player','FWD','MUN')");
    db.exec("INSERT OR IGNORE INTO player_identities(player_id,person_id,source_id,source_person_code,season)VALUES('fpl:1:2024-25','fpl:code:1','fpl',1,'2024-25')");
    db.exec("INSERT OR IGNORE INTO player_season_stats(player_id,season,competition,goals,snapshot_id)VALUES('fpl:1:2024-25','2024-25','PL',0,'snapshot-1')");
    const verdict={version:1,request_id:requestId,relevant:true,junk_reason:null,restated_question:"Show goals",tables:[{fields:["goals"],filters:{season:["2024-25"],competition:["PL"],person_id:["fpl:code:1"],opponent_id:[]}}],visuals:[{kind:"bar",table_index:0}],field_status:[],families:[]};
    const mapped=await mapQuestionVerdict(verdict,{requestId,revision:4,locale:"en",snapshotId:"snapshot-1",resolvePerson:async p=>p});if(mapped.kind!=="ready")throw new Error("fixture_mapping_failed");
    const spec={...mapped.spec,...(badCatalog?{catalog_digest:"f".repeat(64)}:{})};
    db.prepare("UPDATE question_requests SET status='triaged',verdict_json=?,lease_expires_at=NULL,revision=revision+1 WHERE request_id=?").run(JSON.stringify(verdict),requestId);
    db.prepare("UPDATE question_requests SET status='filled',revision=revision+1 WHERE request_id=?").run(requestId);
    db.prepare("INSERT INTO question_request_results(request_id,request_revision,state,spec_json,created_at,updated_at,response_deadline,expires_at)VALUES(?,4,'confirmation_required',?,?,?,?,?)").run(requestId,JSON.stringify(spec),iso(clock),iso(clock),iso(clock+86400_000),expires);
    if(!confirmationOnly){
      db.prepare("UPDATE question_request_results SET state='building',revision=revision+1 WHERE request_id=?").run(requestId);
      db.prepare("UPDATE question_request_results SET state='in_review',attempt=1,lease_id='executor',lease_owner='executor',lease_expires_at=?,revision=revision+1 WHERE request_id=?").run(iso(clock+900_000),requestId);
      const evidence={artifact_key:spec.artifact_key,snapshot_id:spec.data_snapshot_id,entity_id:"fpl:code:1",value:0,attribution:new Catalog(decodeCompiledCatalog(compiled)).checkFeasibility(mapped.intent,"en").attribution_text,verified_at:iso(clock)};
      db.prepare("UPDATE question_request_results SET state='released',verified_json=?,lease_expires_at=NULL,revision=revision+1 WHERE request_id=?").run(JSON.stringify(evidence),requestId);
    }
    return spec.result_path;
  };
  return {db,env,call,wire,read,prepare,fields,bind,ack,settle,row,parent,release,advance:(seconds:number)=>{clock+=seconds*1000;},before:(hook:typeof beforeWrite)=>{beforeWrite=hook;},after:(hook:typeof afterRead)=>{afterRead=hook;},queries:()=>queries,resetQueries:()=>{queries=0;},now:()=>iso(clock),expires};
}
describe("authoritative durable notification service",()=>{
  it("emits only controlled ID/status/link and persists before the one-time grant",async()=>{
    const x=fixture(),grant=await x.prepare();expect(grant.payload).toMatchObject({action:"create",request_id:id,issue_number:null,payload:{request_id:id,revision:1,status:"triaging",result_path:null}});
    expect(x.row()).toMatchObject({create_state:"pending",creation_status:"triaging",lease_id:grant.payload.lease_id});
    expect(JSON.stringify(grant)).not.toMatch(/PRIVATE|private-account|text|account_sub/);
    expect((await x.call("prepare",{request_id:id,expected_revision:1})).payload.action).toBe("conflict");expect(x.row().create_state).toBe("pending");
  });
  it("reconciles uncertain creation with the frozen target after desired status advances",async()=>{
    const x=fixture(),grant=await x.prepare();expect((await x.ack(grant,"retry")).payload.outcome).toBe("accepted");x.settle();
    const next=await x.prepare();expect(next.payload).toMatchObject({action:"reconcile",payload:{revision:1,status:"triaging",result_path:null}});expect(x.row()).toMatchObject({desired_revision:2,desired_status:"junk"});
    expect((await x.bind(next)).payload.outcome).toBe("accepted");expect(x.row()).toMatchObject({create_state:"bound",issue_number:101,delivered_revision:0});
    const update=await x.prepare();expect(update.payload).toMatchObject({action:"update",issue_number:101,payload:{revision:2,status:"junk"}});
    expect((await x.ack(update)).payload.outcome).toBe("accepted");expect(x.row().delivered_revision).toBe(2);
  });
  it("audits already-delivered bound rows without incrementing desired revision",async()=>{
    const x=fixture(),create=await x.prepare();await x.bind(create);const update=await x.prepare();await x.ack(update);
    const audit=await x.prepare();expect(audit.payload).toMatchObject({action:"update",issue_number:101,payload:{revision:1,status:"triaging"}});
    expect((await x.call("check",x.fields(audit))).payload.outcome).toBe("accepted");await x.ack(audit);expect(x.row()).toMatchObject({desired_revision:1,delivered_revision:1,lease_id:null});
  });
  it("keeps uncertain PATCH frozen until expiry, then grants the latest desired payload",async()=>{
    const x=fixture(),create=await x.prepare();await x.bind(create);const update=await x.prepare();await x.ack(update,"retry");x.settle();
    expect((await x.read()).payload.items).toEqual([]);expect(x.row().lease_id).toBe(update.payload.lease_id);
    x.advance(901);const newer=await x.prepare();expect(newer.payload).toMatchObject({action:"update",payload:{revision:2,status:"junk"}});expect(newer.payload.lease_id).not.toBe(update.payload.lease_id);
    expect((await x.ack(update)).payload.outcome).toBe("conflict");expect((await x.bind(create,102)).payload.outcome).toBe("conflict");
  });
  it("rejects a competing prepare and all receipts from a different service",async()=>{
    const x=fixture(),read=await x.read(),payload={request_id:id,expected_revision:read.payload.items[0].revision};
    const outcomes=await Promise.all([x.call("prepare",payload),x.call("prepare",payload)]);expect(outcomes.map(r=>r.payload.action).sort()).toEqual(["conflict","create"]);
    const grant=outcomes.find(r=>r.payload.action==="create")!,other={...caller,service:"other_service"};
    for(const kind of ["check","bind","ack"] as const){const p={...x.fields(grant),...(kind==="bind"?{issue_number:101}:kind==="ack"?{outcome:"retry"}:{})};expect((await x.call(kind,p,other)).payload.outcome).toBe("conflict");}
  });
  it("fences source changes during async projection and at the first grant write",async()=>{
    const first=fixture();let changed=false;first.after(sql=>{if(!changed && sql.includes("q.revision AS q_revision")){changed=true;first.settle();}});expect((await first.read()).payload.items).toEqual([]);expect(first.row()).toBeUndefined();
    const x=fixture(),read=await x.read();x.before(sql=>{if(sql.includes("UPDATE question_request_notifications"))x.settle();});
    expect((await x.call("prepare",{request_id:id,expected_revision:read.payload.items[0].revision})).payload.action).toBe("conflict");expect(x.row().create_state).toBe("ready");
  });
  it("does not mark stale content delivered after a source change immediately before ack",async()=>{
    const x=fixture(),create=await x.prepare();await x.bind(create);const update=await x.prepare();
    x.before(sql=>{if(sql.includes("UPDATE question_request_notifications"))x.settle();});expect((await x.ack(update)).payload.outcome).toBe("conflict");expect(x.row().delivered_revision).toBe(0);
  });
  it("uses database expiry after awaited checks and preserves account/retention deletion",async()=>{
    const x=fixture(),grant=await x.prepare();let sources=0;x.after(sql=>{if(sql.includes("q.revision AS q_revision") && ++sources===2)x.advance(901);});
    expect((await x.call("check",x.fields(grant))).payload.outcome).toBe("conflict");x.after(null);
    expect((await x.bind(grant)).payload.outcome).toBe("conflict");x.db.exec("DELETE FROM question_requests WHERE account_sub='private-account'");expect((await x.read()).payload.items).toEqual([]);expect(x.row()).toBeUndefined();
  });
  it("reuses verified release projection and rejects changed snapshot before an external send",async()=>{
    const x=fixture(),path=await x.release(),grant=await x.prepare();expect(grant.payload.payload).toMatchObject({status:"released",result_path:path});
    expect(JSON.stringify(grant)).not.toContain("PRIVATE PLAYER LABEL");expect((await x.call("check",x.fields(grant))).payload.outcome).toBe("accepted");
    x.advance(1);x.db.prepare("INSERT INTO snapshots(snapshot_id,created_at,sources_json,row_counts)VALUES('snapshot-2',?,'{}','{}')").run(x.now());
    expect((await x.call("check",x.fields(grant))).payload.outcome).toBe("conflict");await x.ack(grant,"retry");
    const reconcile=await x.prepare();expect(reconcile.payload.action).toBe("reconcile");expect(x.row()).toMatchObject({desired_status:"stale",desired_result_path:null,creation_result_path:path});
  });
  it("withholds result links for stale catalog and expired confirmation",async()=>{
    const stale=fixture();await stale.release(id,false,true);expect((await stale.prepare()).payload.payload).toMatchObject({status:"stale",result_path:null});
    const expired=fixture();await expired.release(id,true);expired.advance(86401);expect((await expired.prepare()).payload.payload).toMatchObject({status:"expired",result_path:null});
  });
  it("projects null-spec clarification generations across claims and bounded expiry",async()=>{
    const x=fixture(),verdict={version:1,request_id:id,relevant:true,junk_reason:null,restated_question:"Show goals",tables:[],visuals:[],field_status:[],families:[]};
    x.db.prepare("UPDATE question_requests SET status='triaged',verdict_json=?,lease_expires_at=NULL,revision=revision+1 WHERE request_id=?").run(JSON.stringify(verdict),id);
    x.db.prepare("UPDATE question_requests SET status='no_data',revision=revision+1 WHERE request_id=?").run(id);
    const deadline=iso(Date.parse(x.now())+86400_000);
    x.db.prepare("INSERT INTO question_request_results(request_id,request_revision,state,created_at,updated_at,response_deadline,expires_at)VALUES(?,4,'clarification_required',?,?,?,?)").run(id,x.now(),x.now(),deadline,x.expires);
    x.advance(1);x.db.exec("BEGIN");
    x.db.prepare("UPDATE question_requests SET status='received',attempt=0,verdict_json=NULL,lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,claimed_at=NULL,retry_after=NULL,revision=revision+1,updated_at=? WHERE request_id=?").run(x.now(),id);
    x.db.prepare("INSERT INTO question_request_clarifications(request_id,generation,parent_revision,text,submitted_at)VALUES(?,1,5,'PRIVATE CLARIFICATION',?)").run(id,x.now());
    x.db.prepare("UPDATE question_request_results SET state='triaging',request_revision=5,clarification_count=1,attempt=0,spec_json=NULL,verified_json=NULL,lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=?,response_deadline=? WHERE request_id=?").run(x.now(),iso(Date.parse(x.now())+86400_000),id);x.db.exec("COMMIT");
    x.db.prepare("UPDATE question_requests SET status='triaging',attempt=1,lease_id='q2:generation',lease_owner='triage',claimed_at=?,lease_expires_at=?,revision=revision+1,updated_at=? WHERE request_id=?").run(x.now(),iso(Date.parse(x.now())+900_000),x.now(),id);
    const grant=await x.prepare();expect(grant.payload.payload).toMatchObject({status:"triaging",result_path:null});expect(JSON.stringify(grant)).not.toContain("PRIVATE CLARIFICATION");
    await x.ack(grant,"retry");x.advance(86401);await x.prepare();expect(x.row()).toMatchObject({desired_status:"expired",desired_result_path:null,creation_status:"triaging"});
  });
  it("keeps three complete release verifications below the D1 Free query cap through 0017 over HTTP",async()=>{
    const x=fixture(3);
    for(const name of ["0007_exploration_requests","0016_question_request_refresh","0017_exploration_null_checks"])x.db.exec(readFileSync(`infra/migrations/${name}.sql`,"utf8"));
    await x.release();await x.release("1".padStart(64,"0"));await x.release("2".padStart(64,"0"));x.resetQueries();
    const app=new Hono<QuestionTriageEnv>();app.route("/",createQuestionTriageBridgeRouter(()=>caller));
    const response=await app.request("https://site.invalid/answer-now/notifications/read",{method:"POST",body:x.wire("read",{limit:10})},x.env as never);
    expect(response.status).toBe(200);expect((await response.json() as {payload:{items:unknown[]}}).payload.items).toHaveLength(3);
    expect(x.queries()).toBe(36);expect(x.queries()).toBeLessThan(45);
  });
  it("rotates fixed-clock candidates and stays below the D1 Free query budget",async()=>{
    const x=fixture(10);x.resetQueries();const first=await x.read();expect(first.payload.items).toHaveLength(3);expect(x.queries()).toBeLessThan(45);
    const seen=new Set<string>();for(let n=0;n<4;n++){const page=await x.read();for(const item of page.payload.items)seen.add(item.request_id);}expect(seen.size).toBe(10);
  });
  it("fails unavailable on missing migration guards and rejects arbitrary client content",async()=>{
    const x=fixture();x.db.exec("DROP TRIGGER question_request_notifications_issue_update");expect((await x.read()).status).toBe(503);
    for(const [kind,p] of [["read",{limit:11}],["read",{limit:1,text:"private"}],["prepare",{request_id:id,expected_revision:true}],["bind",{request_id:id,expected_revision:1,lease_id:"test",issue_number:true}],
      ["check",{request_id:id,expected_revision:1,lease_id:"test\n"}],["ack",{request_id:id,expected_revision:1,lease_id:"test",outcome:["delivered"]}]] as const)expect((await x.call(kind,p)).status).toBe(400);
  });
  it("serves the same closed contract through the existing service-only HTTP router",async()=>{
    const x=fixture(),app=new Hono<QuestionTriageEnv>();app.route("/",createQuestionTriageBridgeRouter(()=>caller));
    const response=await app.request("https://site.invalid/answer-now/notifications/read",{method:"POST",body:x.wire("read",{limit:10})},x.env as never);
    expect(response.status).toBe(200);expect(response.headers.get("Cache-Control")).toBe("no-store");expect(JSON.stringify(await response.json())).not.toContain("PRIVATE");
  });
});
