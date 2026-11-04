import {describe,it,expect} from "vitest";
// @ts-expect-error Node test runtime module.
import {readFileSync,readdirSync} from "node:fs";
// @ts-expect-error Node test runtime module.
import {DatabaseSync} from "node:sqlite";
import {Hono} from "hono";
import {handleNotification,type NotificationOperation} from "../worker/src/core/question-request-notifications";
import {createQuestionTriageBridgeRouter,type QuestionTriageEnv} from "../worker/src/routes/question-triage-bridge";
import {TRIAGE_CAPABILITY} from "../worker/src/core/question-triage-bridge";
import {accessGate,type AccessIdentity} from "../worker/src/security/auth";
import type {Env} from "../worker/src/core/db";
import {mapQuestionVerdict} from "../worker/src/core/question-request-intent";
import {Catalog} from "../worker/src/core/feasibility";
import {decodeCompiledCatalog} from "../worker/src/core/catalog-contract";
import compiled from "../worker/src/generated/catalog.json";
type DB=InstanceType<typeof DatabaseSync>;
const id="a".repeat(64),caller={service:"notify_service",capability:TRIAGE_CAPABILITY};
const iso=(n:number)=>new Date(Math.floor(n/1000)*1000).toISOString().replace(".000Z","Z");
function fixture(count=1,local=false,locale:"en"|"es"="en"){
  const db:DB=new DatabaseSync(":memory:"),clockDb:DB=new DatabaseSync(":memory:");db.exec("PRAGMA foreign_keys=ON");let clock=Date.now(),queries=0,nonce=0;
  let beforeWrite:((sql:string)=>void)|null=null,afterRead:((sql:string)=>void)|null=null;
  db.function("strftime",{varargs:true},(...args:(string|number|null)[])=>{const bound=args.map(a=>a==="now"?iso(clock):a);return clockDb.prepare(`SELECT strftime(${bound.map(()=>"?").join(",")}) AS value`).get(...bound).value;});
  for(const name of ["0001_schema","0003_p16_dot_plot","0004_cache_slots","0005_account_question_history","0006_season_splits",...(local?["0007_exploration_requests"]:[]),"0008_exploration_request_links","0009_manager_era_records","0010_question_requests","0011_opponent_labels","0012_cl_season_stage","0013_question_request_results","0014_question_request_clarifications","0015_question_request_notifications"])db.exec(readFileSync(`infra/migrations/${name}.sql`,"utf8"));
  const expires=iso(clock+90*86400_000);
  if(local)for(const name of ["0016_question_request_refresh","0017_exploration_null_checks","0018_question_request_local_notifications"])db.exec(readFileSync(`infra/migrations/${name}.sql`,"utf8"));
  db.prepare("INSERT INTO snapshots(snapshot_id,created_at,sources_json,row_counts)VALUES('snapshot-1',?,'{}','{}')").run(iso(clock));
  const parent=(requestId:string)=>{
    db.prepare("INSERT INTO question_requests(request_id,account_sub,text,locale,text_hash,status,created_at,updated_at,expires_at)VALUES(?,'private-account','PRIVATE ORIGINAL QUESTION',?,?,'received',?,?,?)").run(requestId,locale,requestId,iso(clock),iso(clock),expires);
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
  const env={DB:{prepare:(sql:string)=>new Statement(sql)},BRIDGE_NEW_LEASE_ID:()=>"local-lease-"+(++nonce)} as unknown as Env;
  const http=async(kind:NotificationOperation,payload:unknown,version=2,identity:typeof caller|null=caller)=>{
    const app=new Hono<QuestionTriageEnv>();app.route("/",createQuestionTriageBridgeRouter(()=>identity));
    const result=await app.request(`https://site.invalid/answer-now/notifications/${kind}`,{method:"POST",body:JSON.stringify({version,kind:"notify_"+kind,payload})},env as never);
    return {status:result.status,...await result.json() as {payload:any;version?:number;error?:string}};
  };
  const wire=(kind:NotificationOperation,payload:unknown)=>JSON.stringify({version:1,kind:"notify_"+kind,payload});
  const call=async(kind:NotificationOperation,payload:unknown,identity=caller)=>{const result=await handleNotification(env,identity,kind,wire(kind,payload),()=>"lease-"+(++nonce));return {status:result.status,...JSON.parse(result.body)};};
  const read=()=>call("read",{limit:10});
  const prepare=async()=>{const result=await read();return call("prepare",{request_id:id,expected_revision:result.payload.items.find((item:{request_id:string})=>item.request_id===id).revision});};
  const fields=(grant:{payload:{revision:number;lease_id:string}})=>({request_id:id,expected_revision:grant.payload.revision,lease_id:grant.payload.lease_id});
  const bind=(grant:Parameters<typeof fields>[0],issue=101)=>call("bind",{...fields(grant),issue_number:issue});
  const ack=(grant:Parameters<typeof fields>[0],outcome="delivered")=>call("ack",{...fields(grant),outcome});
  const settle=(requestId=id)=>{const verdict={version:1,request_id:requestId,relevant:false,junk_reason:"off_topic",restated_question:"",tables:[],visuals:[],field_status:[],families:[]};db.prepare("UPDATE question_requests SET status='junk',verdict_json=?,lease_expires_at=NULL,revision=revision+1,updated_at=? WHERE request_id=?").run(JSON.stringify(verdict),iso(clock),requestId);};
  const row=()=>db.prepare("SELECT * FROM question_request_notifications WHERE request_id=?").get(id);
  const release=async(requestId=id,confirmationOnly=false,badCatalog=false,initialState="confirmation_required",locale:"en"|"es"="en")=>{
    db.exec("INSERT OR IGNORE INTO players(player_id,fpl_element,season,web_name,first_name,second_name,position,team)VALUES('fpl:1:2024-25',1,'2024-25','PRIVATE PLAYER LABEL','Private','Player','FWD','MUN')");
    db.exec("INSERT OR IGNORE INTO player_identities(player_id,person_id,source_id,source_person_code,season)VALUES('fpl:1:2024-25','fpl:code:1','fpl',1,'2024-25')");
    db.exec("INSERT OR IGNORE INTO player_season_stats(player_id,season,competition,goals,snapshot_id)VALUES('fpl:1:2024-25','2024-25','PL',0,'snapshot-1')");
    const verdict={version:1,request_id:requestId,relevant:true,junk_reason:null,restated_question:"Show goals",tables:[{fields:["goals"],filters:{season:["2024-25"],competition:["PL"],person_id:["fpl:code:1"],opponent_id:[]}}],visuals:[{kind:"bar",table_index:0}],field_status:[],families:[]};
    const mapped=await mapQuestionVerdict(verdict,{requestId,revision:4,locale,snapshotId:"snapshot-1",resolvePerson:async p=>p});if(mapped.kind!=="ready")throw new Error("fixture_mapping_failed");
    const spec={...mapped.spec,...(badCatalog?{catalog_digest:"f".repeat(64)}:{})};
    db.prepare("UPDATE question_requests SET status='triaged',verdict_json=?,lease_expires_at=NULL,revision=revision+1 WHERE request_id=?").run(JSON.stringify(verdict),requestId);
    db.prepare("UPDATE question_requests SET status='filled',revision=revision+1 WHERE request_id=?").run(requestId);
    db.prepare("INSERT INTO question_request_results(request_id,request_revision,state,spec_json,created_at,updated_at,response_deadline,expires_at)VALUES(?,4,?,?,?,?,?,?)").run(requestId,initialState,JSON.stringify(spec),iso(clock),iso(clock),iso(clock+86400_000),expires);
    if(!confirmationOnly){
      db.prepare("UPDATE question_request_results SET state='building',revision=revision+1 WHERE request_id=?").run(requestId);
      db.prepare("UPDATE question_request_results SET state='in_review',attempt=1,lease_id='executor',lease_owner='executor',lease_expires_at=?,revision=revision+1 WHERE request_id=?").run(iso(clock+900_000),requestId);
      const evidence={artifact_key:spec.artifact_key,snapshot_id:spec.data_snapshot_id,entity_id:"fpl:code:1",value:0,attribution:new Catalog(decodeCompiledCatalog(compiled)).checkFeasibility(mapped.intent,"en").attribution_text,verified_at:iso(clock)};
      db.prepare("UPDATE question_request_results SET state='released',verified_json=?,lease_expires_at=NULL,revision=revision+1 WHERE request_id=?").run(JSON.stringify(evidence),requestId);
    }
    return spec.result_path;
  };
  return {db,env,http,call,wire,read,prepare,fields,bind,ack,settle,row,parent,release,advance:(seconds:number)=>{clock+=seconds*1000;},before:(hook:typeof beforeWrite)=>{beforeWrite=hook;},after:(hook:typeof afterRead)=>{afterRead=hook;},queries:()=>queries,resetQueries:()=>{queries=0;},now:()=>iso(clock),expires};
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
  it("keeps three current confirmation candidates below the D1 Free query cap through 0017 over HTTP",async()=>{
    const x=fixture(3);
    for(const name of ["0007_exploration_requests","0016_question_request_refresh","0017_exploration_null_checks"])x.db.exec(readFileSync(`infra/migrations/${name}.sql`,"utf8"));
    for(const requestId of [id,"1".padStart(64,"0"),"2".padStart(64,"0")])await x.release(requestId,true);
    x.resetQueries();
    const app=new Hono<QuestionTriageEnv>();app.route("/",createQuestionTriageBridgeRouter(()=>caller));
    const response=await app.request("https://site.invalid/answer-now/notifications/read",{method:"POST",body:x.wire("read",{limit:10})},x.env as never);
    expect(response.status).toBe(200);expect((await response.json() as {payload:{items:unknown[]}}).payload.items).toHaveLength(3);
    expect(x.db.prepare("SELECT count(*) AS n FROM question_request_notifications WHERE desired_status='confirmation_required'").get().n).toBe(3);
    expect(x.queries()).toBe(33);
    expect(x.queries()).toBeLessThan(45);
  });
  it.each(["received","triaging","junk","triage_failed","failed","clarification_required","unsupported","unavailable","building","in_review","expired","stale","result_triaging","bound_clarification_required","bound_unsupported","bound_unavailable"])("budgets three %s candidates through 0017 over HTTP",async state=>{
    const x=fixture(3,true),ids=[id,"1".padStart(64,"0"),"2".padStart(64,"0")];
    for(const name of ["0007_exploration_requests","0016_question_request_refresh","0017_exploration_null_checks"])x.db.exec(readFileSync(`infra/migrations/${name}.sql`,"utf8"));
    for(const requestId of ids){
      if(state==="triaging")continue;
      if(state==="received"){
        // The owned q2 lease remains after a retry returns the parent to received.
        x.db.prepare("UPDATE question_requests SET status='received',lease_expires_at=NULL,retry_after=?,revision=revision+1 WHERE request_id=?").run(iso(Date.parse(x.now())+901_000),requestId);continue;
      }
      if(state==="junk"){x.settle(requestId);continue;}
      if(state==="triage_failed"){
        for(let attempt=1;attempt<=3;attempt++){
          x.db.prepare("UPDATE question_requests SET status=?,lease_expires_at=NULL,retry_after=?,revision=revision+1 WHERE request_id=?").run(attempt===3?"triage_failed":"received",attempt===3?null:iso(Date.parse(x.now())+901_000),requestId);
          if(attempt<3){
            x.advance(902);
            x.db.prepare("UPDATE question_requests SET status='triaging',attempt=attempt+1,lease_id=?,claimed_at=?,lease_expires_at=?,retry_after=NULL,revision=revision+1,updated_at=? WHERE request_id=?").run(`q2:retry-${attempt}`,x.now(),iso(Date.parse(x.now())+900_000),x.now(),requestId);
          }
        }
        continue;
      }
      if(state.startsWith("bound_")){await x.release(requestId,true,false,state.slice(6));continue;}
      if(["clarification_required","unsupported","unavailable","result_triaging"].includes(state)){
        const verdict={version:1,request_id:requestId,relevant:true,junk_reason:null,restated_question:"Show goals",tables:[],visuals:[],field_status:[],families:[]};
        x.db.prepare("UPDATE question_requests SET status='triaged',verdict_json=?,lease_expires_at=NULL,revision=revision+1 WHERE request_id=?").run(JSON.stringify(verdict),requestId);
        x.db.prepare("UPDATE question_requests SET status='no_data',revision=revision+1 WHERE request_id=?").run(requestId);
        x.db.prepare("INSERT INTO question_request_results(request_id,request_revision,state,created_at,updated_at,response_deadline,expires_at)VALUES(?,4,?,?,?,?,?)").run(requestId,state==="result_triaging"?"clarification_required":state,x.now(),x.now(),iso(Date.parse(x.now())+86400_000),x.expires);
        if(state==="result_triaging"){
          x.db.exec("BEGIN");
          x.db.prepare("UPDATE question_requests SET status='received',attempt=0,verdict_json=NULL,lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,claimed_at=NULL,retry_after=NULL,revision=revision+1,updated_at=? WHERE request_id=?").run(x.now(),requestId);
          x.db.prepare("INSERT INTO question_request_clarifications(request_id,generation,parent_revision,text,submitted_at)VALUES(?,1,5,'PRIVATE CLARIFICATION',?)").run(requestId,x.now());
          x.db.prepare("UPDATE question_request_results SET state='triaging',request_revision=5,clarification_count=1,attempt=0,spec_json=NULL,verified_json=NULL,lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=?,response_deadline=? WHERE request_id=?").run(x.now(),iso(Date.parse(x.now())+86400_000),requestId);x.db.exec("COMMIT");
        }
        continue;
      }
      await x.release(requestId,state!=="stale");
      if(state==="stale"){x.db.prepare("UPDATE question_request_results SET state='stale',verified_json=NULL,revision=revision+1 WHERE request_id=?").run(requestId);continue;}
      if(state==="expired")continue;
      x.db.prepare("UPDATE question_request_results SET state='building',revision=revision+1 WHERE request_id=?").run(requestId);
      if(state==="building")continue;
      for(let attempt=1;attempt<=(state==="failed"?3:1);attempt++){
        x.db.prepare("UPDATE question_request_results SET state='in_review',attempt=?,lease_id=?,lease_owner='executor',lease_expires_at=?,updated_at=?,revision=revision+1 WHERE request_id=?").run(attempt,`executor-${attempt}`,iso(Date.parse(x.now())+900_000),x.now(),requestId);
        if(state==="failed"){
          x.advance(901);
          x.db.prepare("UPDATE question_request_results SET state=?,lease_expires_at=NULL,updated_at=?,revision=revision+1 WHERE request_id=?").run(attempt===3?"failed":"building",x.now(),requestId);
        }
      }
    }
    if(state==="expired"){
      x.advance(86401);
      for(const requestId of ids)x.db.prepare("UPDATE question_request_results SET state='expired',updated_at=?,revision=revision+1 WHERE request_id=?").run(x.now(),requestId);
    }
    x.resetQueries();
    const app=new Hono<QuestionTriageEnv>();app.route("/",createQuestionTriageBridgeRouter(()=>caller));
    const response=await app.request("https://site.invalid/answer-now/notifications/read",{method:"POST",body:x.wire("read",{limit:10})},x.env as never);
    expect(response.status).toBe(200);expect((await response.json() as {payload:{items:unknown[]}}).payload.items).toHaveLength(3);
    const projected=state==="result_triaging"?"triaging":state==="triage_failed"?"failed":state.replace(/^bound_/,"");
    expect(x.db.prepare("SELECT count(*) AS n FROM question_request_notifications WHERE desired_status=?").get(projected).n).toBe(3);
    expect(x.queries()).toBe(({building:33,in_review:33,stale:24,bound_clarification_required:27,bound_unsupported:24,bound_unavailable:24} as Record<string,number>)[state]??18);
    expect(x.queries()).toBeLessThan(45);
    const previous=x.queries();x.resetQueries();
    expect((await x.http("read",{limit:10})).payload.items).toHaveLength(3);
    expect(x.queries()).toBe(previous+3);expect(x.queries()).toBeLessThan(45);
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

const localFields=(grant:any)=>({request_id:id,expected_revision:grant.revision,lease_id:grant.lease_id,payload_revision:grant.payload_revision});
const notificationState=(x:ReturnType<typeof fixture>)=>Object.fromEntries(
  ["question_requests","question_request_local_notifications","question_request_notifications","question_request_results"].map(table=>[
    table,x.db.prepare(`SELECT * FROM ${table} ORDER BY request_id`).all(),
  ]));
const receiptFor=async(p:any)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(["question-request-local-v2",p.request_id,p.status,p.revision,p.result_path])))),b=>b.toString(16).padStart(2,"0")).join("");
async function localGrant(x:ReturnType<typeof fixture>){
  const read=await x.http("read",{limit:10});expect(read.status).toBe(200);
  const item=read.payload.items.find((r:any)=>r.request_id===id);
  return (await x.http("prepare",{request_id:id,expected_revision:item.revision})).payload;
}
describe("local notification v2 through the HTTP boundary and migrations through 0018",()=>{
  it.each(["prepare","bind","ack"] as const)("refuses anonymous and human-only %s without changing any persisted state",async kind=>{
    const x=fixture(1,true);await x.release();const grant=await localGrant(x),receipt=await receiptFor(grant.payload);
    let fields=localFields(grant);
    if(kind==="ack"){
      const bound=await x.http("bind",{...fields,receipt});expect(bound.payload.outcome).toBe("accepted");
      fields={...fields,expected_revision:bound.payload.revision};
    }
    const payload=kind==="prepare"?{request_id:id,expected_revision:grant.payload_revision}:
      {...fields,receipt,...(kind==="ack"?{outcome:"delivered"}:{})};
    for(const identity of [null,{service:"human",capability:"human" as typeof TRIAGE_CAPABILITY}]){
      const before=notificationState(x);
      expect(await x.http(kind,payload,2,identity)).toMatchObject({status:403,error:"invalid_caller"});
      expect(notificationState(x)).toEqual(before);
    }
  });
  it("uses the production caller resolver after Access verification to refuse humans and unlisted services",async()=>{
    const x=fixture(1,true);await x.release();const grant=await localGrant(x),receipt=await receiptFor(grant.payload);
    const bound=await x.http("bind",{...localFields(grant),receipt});expect(bound.payload.outcome).toBe("accepted");
    let identity:AccessIdentity={sub:"test-owner",email:"owner@example.invalid"},verified=0;
    const app=new Hono<QuestionTriageEnv>();
    app.use("*",accessGate(async()=>{verified++;return identity;}));
    app.route("/",createQuestionTriageBridgeRouter());
    const env={...x.env,ACCESS_ISSUER:"https://example.cloudflareaccess.com",ACCESS_AUD:"a".repeat(64),
      ACCESS_OWNER_EMAILS:"owner@example.invalid",ACCESS_SERVICE_CLIENT_IDS:"notify.service"};
    const request=(kind:NotificationOperation,payload:unknown)=>app.request(`https://site.invalid/answer-now/notifications/${kind}`,{
      method:"POST",headers:{Origin:"https://site.invalid"},body:JSON.stringify({version:2,kind:"notify_"+kind,payload}),
    },env as never);
    for(const candidate of [{sub:"test-owner",email:"owner@example.invalid"},{sub:"",serviceClientId:"unlisted.service"}] as AccessIdentity[]){
      identity=candidate;
      for(const kind of ["prepare","bind","ack"] as const){
        const payload=kind==="prepare"?{request_id:id,expected_revision:grant.payload_revision}:
          {...localFields(grant),expected_revision:kind==="ack"?bound.payload.revision:grant.revision,receipt,...(kind==="ack"?{outcome:"delivered"}:{})};
        const before=notificationState(x),response=await request(kind,payload);
        expect(response.status).toBe(403);expect(await response.json()).toEqual({error:"invalid_caller"});
        expect(notificationState(x)).toEqual(before);
      }
    }
    expect(verified).toBe(6);
    identity={sub:"",serviceClientId:"notify.service"};
    const accepted=await request("check",{...localFields(grant),expected_revision:bound.payload.revision});
    expect(accepted.status).toBe(200);expect(await accepted.json()).toMatchObject({payload:{outcome:"accepted"}});
    expect(verified).toBe(7);
  });
  it.each(["SELECT request_id FROM question_request_notifications LIMIT 0","SELECT name FROM sqlite_master"])("fails closed over HTTP when readiness query throws: %s",async query=>{
    const x=fixture(1,true);await x.release();const grant=await localGrant(x),receipt=await receiptFor(grant.payload);
    const bound=await x.http("bind",{...localFields(grant),receipt});expect(bound.payload.outcome).toBe("accepted");
    let failures=0;x.after(sql=>{if(sql.startsWith(query)){failures++;throw new Error("injected_readiness_failure");}});
    const operations=[
      ["read",{limit:10}],["prepare",{request_id:id,expected_revision:grant.payload_revision}],
      ["check",{...localFields(grant),expected_revision:bound.payload.revision}],
      ["bind",{...localFields(grant),receipt}],
      ["ack",{...localFields(grant),expected_revision:bound.payload.revision,receipt,outcome:"delivered"}],
    ] as const;
    for(const [kind,payload] of operations){
      const before=notificationState(x);
      expect(await x.http(kind,payload)).toMatchObject({status:503,error:"notification_unavailable"});
      expect(notificationState(x)).toEqual(before);
    }
    const before=notificationState(x);
    expect(await x.http("read",{limit:10},1)).toMatchObject({status:503,error:"notification_unavailable"});
    expect(notificationState(x)).toEqual(before);expect(failures).toBe(6);
    x.after(null);expect((await x.http("read",{limit:10},1)).status).toBe(200);
  });
  it("replays the sorted full chain on populated released, clarification and legacy bound data",async()=>{
    const x=fixture(3),legacy=await x.prepare();await x.bind(legacy,101);
    await x.release();await x.release("1".padStart(64,"0"),true,false,"clarification_required");
    const clarificationId="1".padStart(64,"0");x.db.exec("BEGIN");
    x.db.prepare("UPDATE question_requests SET status='received',attempt=0,verdict_json=NULL,lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,claimed_at=NULL,retry_after=NULL,revision=revision+1 WHERE request_id=?").run(clarificationId);
    x.db.prepare("INSERT INTO question_request_clarifications(request_id,generation,parent_revision,text,submitted_at)VALUES(?,1,5,'PRIVATE CLARIFICATION',?)").run(clarificationId,x.now());
    x.db.prepare("UPDATE question_request_results SET state='triaging',request_revision=5,clarification_count=1,attempt=0,spec_json=NULL,verified_json=NULL,lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,revision=revision+1 WHERE request_id=?").run(clarificationId);x.db.exec("COMMIT");
    const tables=["question_requests","question_request_results","question_request_clarifications","question_request_notifications"];
    const rows=()=>tables.map(table=>x.db.prepare(`SELECT * FROM ${table} ORDER BY request_id`).all());
    const before=rows(),files=readdirSync("infra/migrations").filter((n:string)=>n.endsWith(".sql")).sort();
    for(let n=0;n<2;n++)for(const file of files)x.db.exec(readFileSync(`infra/migrations/${file}`,"utf8"));
    expect(rows()).toEqual(before);const grant=await localGrant(x);expect(grant.payload.status).toBe("released");
    expect(x.row().issue_number).toBe(101);
    const local=x.db.prepare("SELECT * FROM question_request_local_notifications").all();
    for(const file of files)x.db.exec(readFileSync(`infra/migrations/${file}`,"utf8"));
    expect(x.db.prepare("SELECT * FROM question_request_local_notifications").all()).toEqual(local);
    x.db.exec("DELETE FROM question_requests WHERE account_sub='private-account'");
    expect((await x.http("read",{limit:10})).payload.items).toEqual([]);
    expect(x.db.prepare("SELECT count(*) AS n FROM question_request_local_notifications").get().n).toBe(0);
  });
  it("grants only one concurrent lease and fences a source mutation at receipt write",async()=>{
    const x=fixture(1,true),read=await x.http("read",{limit:10}),p={request_id:id,expected_revision:read.payload.items[0].revision};
    const outcomes=await Promise.all([x.http("prepare",p),x.http("prepare",p)]);
    expect(outcomes.map(r=>r.payload.action).sort()).toEqual(["append","conflict"]);
    const grant=outcomes.find(r=>r.payload.action==="append")!.payload,receipt=await receiptFor(grant.payload);
    x.before(sql=>{if(sql.includes("UPDATE question_request_local_notifications"))x.settle();});
    expect((await x.http("bind",{...localFields(grant),receipt})).payload.outcome).toBe("conflict");
    expect(x.db.prepare("SELECT receipt,delivered FROM question_request_local_notifications").get()).toMatchObject({receipt:null,delivered:0});
  });
  it.each(["insert","update","delete","no_issue"])("refuses partially installed 0018 missing %s guard",async guard=>{
    const x=fixture(1,true);x.db.exec(`DROP TRIGGER question_request_local_notifications_${guard}`);
    expect((await x.http("read",{limit:10})).status).toBe(503);expect((await x.http("read",{limit:10},1)).status).toBe(200);
    expect((await x.http("prepare",{request_id:id,expected_revision:1},1)).status).toBe(403);
    expect((await x.http("bind",{request_id:id,expected_revision:1,lease_id:"lease",issue_number:123},1)).status).toBe(403);
  });
  it("refuses local operations and legacy mutations when only the additive ledger table was installed",async()=>{
    const x=fixture(1,true);for(const name of ["insert","update","delete","no_issue"])x.db.exec(`DROP TRIGGER question_request_local_notifications_${name}`);
    expect((await x.http("read",{limit:10})).status).toBe(503);expect((await x.http("read",{limit:10},1)).status).toBe(200);
    expect((await x.http("prepare",{request_id:id,expected_revision:1},1)).status).toBe(403);
    expect((await x.http("bind",{request_id:id,expected_revision:1,lease_id:"lease",issue_number:123},1)).status).toBe(403);
  });
  it("refuses local operations before 0018 while the current read stays available through 0017",async()=>{
    const x=fixture();for(const name of ["0007_exploration_requests","0016_question_request_refresh","0017_exploration_null_checks"])x.db.exec(readFileSync(`infra/migrations/${name}.sql`,"utf8"));
    expect((await x.http("read",{limit:10},1)).status).toBe(200);
    for(const [kind,p] of [["read",{limit:10}],["prepare",{request_id:id,expected_revision:1}],
      ["check",{request_id:id,expected_revision:1,lease_id:"lease",payload_revision:1}],
      ["bind",{request_id:id,expected_revision:1,lease_id:"lease",payload_revision:1,receipt:"a".repeat(64)}],
      ["ack",{request_id:id,expected_revision:1,lease_id:"lease",payload_revision:1,receipt:"a".repeat(64),outcome:"delivered"}]] as const)
      expect((await x.http(kind,p)).status).toBe(503);
  });
  it("binds the exact fsync receipt to a lease, replays a lost bind reply, and acknowledges without an issue",async()=>{
    const x=fixture(1,true),grant=await localGrant(x),p=grant.payload,receipt=await receiptFor(p),fields=localFields(grant);
    expect(Object.keys(p).sort()).toEqual(["request_id","result_path","revision","status"]);expect(grant).not.toHaveProperty("issue_number");
    expect((await x.http("ack",{...fields,outcome:"delivered",receipt})).payload.outcome).toBe("conflict");
    expect((await x.http("bind",{...fields,receipt:"b".repeat(64)})).payload.outcome).toBe("conflict");
    const bound=await x.http("bind",{...fields,receipt});expect(bound.payload).toEqual({outcome:"accepted",revision:grant.revision+1});
    expect((await x.http("bind",{...fields,receipt})).payload).toEqual(bound.payload);
    expect((await x.http("ack",{...fields,expected_revision:bound.payload.revision,outcome:"delivered",receipt})).payload.outcome).toBe("accepted");
    expect((await x.http("read",{limit:10})).payload.items).toEqual([]);
    expect(x.row().issue_number).toBeNull();expect(x.db.prepare("SELECT status FROM question_requests WHERE request_id=?").get(id).status).toBe("triaging");
    for(const kind of ["prepare","bind","ack"] as const){
      const payload=kind==="prepare"?{request_id:id,expected_revision:1}:kind==="bind"?{request_id:id,expected_revision:1,lease_id:"lease",issue_number:123}:{request_id:id,expected_revision:1,lease_id:"lease",outcome:"delivered"};
      expect((await x.http(kind,payload,1)).status).toBe(403);
    }
  });
  it("keeps one immutable key on append/crash replay and refuses stale leases, services and source revisions",async()=>{
    const x=fixture(1,true),grant=await localGrant(x),fields=localFields(grant),receipt=await receiptFor(grant.payload);
    expect((await x.http("check",fields,2,null)).status).toBe(403);
    expect((await x.http("check",fields,2,{service:"human",capability:"human" as typeof TRIAGE_CAPABILITY})).status).toBe(403);
    for(const kind of ["check","bind","ack"] as const){
      const extra=kind==="bind"?{receipt}:kind==="ack"?{receipt,outcome:"delivered"}:{};
      expect((await x.http(kind,{...fields,...extra},2,{...caller,service:"other"})).payload.outcome).toBe("conflict");
      expect((await x.http(kind,{...fields,...extra,expected_revision:fields.expected_revision+100})).payload.outcome).toBe("conflict");
    }
    x.advance(901);const replay=await localGrant(x);expect(replay.payload).toEqual(grant.payload);expect(replay.lease_id).not.toBe(grant.lease_id);
    expect((await x.http("bind",{...fields,receipt})).payload.outcome).toBe("conflict");
    expect(x.db.prepare("SELECT count(*) AS n FROM question_request_local_notifications").get().n).toBe(1);
    x.settle();expect((await x.http("check",localFields(replay))).payload.outcome).toBe("conflict");
    const newer=await localGrant(x);expect(newer.payload).toMatchObject({revision:2,status:"junk",result_path:null});
    expect((await x.http("ack",{...localFields(replay),receipt,outcome:"delivered"})).payload.outcome).toBe("conflict");
  });
  it("retains a durable receipt after interrupted ack and rebinds it to a new live lease",async()=>{
    const x=fixture(1,true),grant=await localGrant(x),receipt=await receiptFor(grant.payload);
    await x.http("bind",{...localFields(grant),receipt});x.advance(901);
    const replay=await localGrant(x);expect(replay.action).toBe("reconcile");expect(replay.payload).toEqual(grant.payload);
    expect((await x.http("ack",{...localFields(replay),receipt,outcome:"delivered"})).payload.outcome).toBe("conflict");
    expect((await x.http("ack",{...localFields(grant),expected_revision:grant.revision+1,receipt,outcome:"delivered"})).payload.outcome).toBe("conflict");
    const bound=await x.http("bind",{...localFields(replay),receipt});expect(bound.payload.outcome).toBe("accepted");
    expect((await x.http("ack",{...localFields(replay),expected_revision:bound.payload.revision,receipt,outcome:"delivered"})).payload.outcome).toBe("accepted");
  });
  it("never rolls back a release or retriages on receipt failure; stale release binding refuses all sends",async()=>{
    const x=fixture(1,true),path=await x.release(),grant=await localGrant(x),receipt=await receiptFor(grant.payload);
    expect(grant.payload).toMatchObject({status:"released",result_path:path});
    expect(path).toMatch(/^\/en\/q\?/);expect((await x.http("ack",{...localFields(grant),receipt,outcome:"delivered"})).payload.outcome).toBe("conflict");
    expect(x.db.prepare("SELECT state FROM question_request_results WHERE request_id=?").get(id).state).toBe("released");
    x.advance(1);x.db.prepare("INSERT INTO snapshots(snapshot_id,created_at,sources_json,row_counts)VALUES('snapshot-2',?,'{}','{}')").run(x.now());
    expect((await x.http("check",localFields(grant))).payload.outcome).toBe("conflict");
    expect((await x.http("bind",{...localFields(grant),receipt})).payload.outcome).toBe("conflict");
    x.advance(901);const stale=await localGrant(x);expect(stale.payload).toMatchObject({status:"stale",result_path:null,revision:2});
  });
  it("rejects extra payloads, fabricated issues and nonclosed receipt envelopes",async()=>{
    const x=fixture(1,true),grant=await localGrant(x);
    for(const p of [{...localFields(grant),issue_number:1},{...localFields(grant),receipt:"a".repeat(64),text:"private"},{...localFields(grant),receipt:"x"},
      {...localFields(grant),receipt:"a".repeat(64),status:"released"}])expect((await x.http("bind",p)).status).toBe(400);
    expect(JSON.stringify(grant)).not.toMatch(/PRIVATE|private-account|account_sub|question/);
  });
  it("generates the Spanish relative result link from the owned released result",async()=>{
    const x=fixture(1,true,"es");
    const path=await x.release(id,false,false,"confirmation_required","es"),grant=await localGrant(x);
    expect(path).toMatch(/^\/es\/q\?/);expect(grant.payload).toMatchObject({status:"released",result_path:path});
  });
  it.each([false,true])("budgets v2 three confirmation/released candidates (released=%s) through 0018",async released=>{
    const x=fixture(3,true);for(const requestId of [id,"1".padStart(64,"0"),"2".padStart(64,"0")])await x.release(requestId,!released);
    x.resetQueries();expect((await x.http("read",{limit:10})).payload.items).toHaveLength(3);
    expect(x.queries()).toBe(released?39:36);expect(x.queries()).toBeLessThan(45);
  });
});
