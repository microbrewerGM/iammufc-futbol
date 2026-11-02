import {describe,expect,it} from "vitest";
// @ts-expect-error Node test runtime module.
import {readFileSync} from "node:fs";
// @ts-expect-error Node test runtime module.
import {DatabaseSync} from "node:sqlite";
type DB=InstanceType<typeof DatabaseSync>;
const id="a".repeat(64),hash="b".repeat(64),iso=(n:number)=>new Date(Math.floor(n/1000)*1000).toISOString().replace(".000Z","Z");
const migration=readFileSync("infra/migrations/0014_question_request_clarifications.sql","utf8");
function spec(revision:number){return {version:1,request_id:id,request_revision:revision,locale:"en",canonical_intent:JSON.stringify({competition:"PL",dimensions:[],entity_id:"fpl:code:1",entity_type:"player",filters:{},limit:1,metric:"goals",season:"2024-25",viz:"bar"}),result_path:"/en/q?metric=goals&entity_type=player&entity_id=fpl%3Acode%3A1&season=2024-25&competition=PL&viz=bar&limit=1",data_snapshot_id:"snapshot-1",catalog_digest:hash,artifact_key:hash,transform_code_version:"v1",renderer_version:"v1",expected_cell_state:"computable_now_queued"};}
function transaction<T>(db:DB,fn:()=>T):T {db.exec("BEGIN IMMEDIATE");try{const result=fn();db.exec("COMMIT");return result;}catch(error){db.exec("ROLLBACK");throw error;}}
function fixture(){
  const db:DB=new DatabaseSync(":memory:"),clockDb:DB=new DatabaseSync(":memory:");db.exec("PRAGMA foreign_keys=ON");let clock=iso(Date.now());
  db.function("strftime",{varargs:true},(...args:(string|number|null)[])=>{const bound=args.map(a=>a==="now"?clock:a);return clockDb.prepare(`SELECT strftime(${bound.map(()=>"?").join(",")}) AS value`).get(...bound).value;});
  for(const name of ["0001_schema","0003_p16_dot_plot","0004_cache_slots","0005_account_question_history","0006_season_splits","0008_exploration_request_links","0009_manager_era_records","0010_question_requests","0011_opponent_labels","0012_cl_season_stage","0013_question_request_results"])db.exec(readFileSync(`infra/migrations/${name}.sql`,"utf8"));
  db.exec(migration);
  const now=clock,expires=iso(Date.parse(now)+90*86400_000);
  const parent=()=>db.prepare("SELECT * FROM question_requests WHERE request_id=?").get(id);
  const result=()=>db.prepare("SELECT * FROM question_request_results WHERE request_id=?").get(id);
  const verdict=(relevant=true)=>JSON.stringify({version:1,request_id:id,relevant,junk_reason:relevant?null:"off_topic",restated_question:relevant?"Show goals":"",tables:[],visuals:[],field_status:[],families:[]});
  const claim=()=>{const q=parent();db.prepare("UPDATE question_requests SET status='triaging',attempt=attempt+1,lease_id=?,lease_owner='service',claimed_at=?,lease_expires_at=?,retry_after=NULL,updated_at=?,revision=revision+1 WHERE request_id=?").run(`lease-${q.revision}`,clock,iso(Date.parse(clock)+900_000),clock,id);};
  db.prepare("INSERT INTO question_requests(request_id,account_sub,text,locale,text_hash,status,created_at,updated_at,expires_at)VALUES(?,'owner','Original question','en',?,'received',?,?,?)").run(id,hash,now,now,expires);
  claim();db.prepare("UPDATE question_requests SET status='triaged',verdict_json=?,lease_expires_at=NULL,revision=revision+1 WHERE request_id=?").run(verdict(),id);db.prepare("UPDATE question_requests SET status='no_data',revision=revision+1 WHERE request_id=?").run(id);
  db.prepare("INSERT INTO question_request_results(request_id,request_revision,state,created_at,updated_at,response_deadline,expires_at)VALUES(?,4,'clarification_required',?,?,?,?)").run(id,now,now,iso(Date.parse(now)+86400_000),expires);
  const advance=(seconds:number)=>{clock=iso(Date.parse(clock)+seconds*1000);};
  const requeue=(text="Clarified question",account="owner",expected=result().revision)=>transaction(db,()=>{
    const q=parent(),r=result();
    const changed=db.prepare(`UPDATE question_requests SET status='received',attempt=0,verdict_json=NULL,exploration_request_id=NULL,lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,claimed_at=NULL,retry_after=NULL,updated_at=?,revision=revision+1
      WHERE request_id=? AND account_sub=? AND revision=? AND EXISTS(SELECT 1 FROM question_request_results r WHERE r.request_id=question_requests.request_id AND r.revision=? AND r.state='clarification_required' AND r.clarification_count<3 AND r.response_deadline>strftime('%Y-%m-%dT%H:%M:%SZ','now'))`).run(clock,id,account,q.revision,expected).changes;
    if(changed!==1)return false;
    // Latest text uses explicit UPDATE/INSERT; no_replace intentionally prevents
    // REPLACE and UPSERT from bypassing the generation predicate.
    const changedText=db.prepare("UPDATE question_request_clarifications SET generation=?,parent_revision=?,text=?,submitted_at=? WHERE request_id=?").run(r.clarification_count+1,q.revision+1,text,clock,id).changes;
    if(!changedText)db.prepare("INSERT INTO question_request_clarifications(request_id,generation,parent_revision,text,submitted_at)VALUES(?,?,?,?,?)").run(id,r.clarification_count+1,q.revision+1,text,clock);
    db.prepare("UPDATE question_request_results SET state='triaging',request_revision=?,clarification_count=clarification_count+1,spec_json=NULL,verified_json=NULL,attempt=0,lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=?,response_deadline=min(expires_at,strftime('%Y-%m-%dT%H:%M:%SZ',?,'+1 day')),revision=revision+1 WHERE request_id=? AND revision=?").run(q.revision+1,clock,clock,id,r.revision);
    return true;
  });
  const remap=(state="clarification_required",override?:object)=>transaction(db,()=>{
    claim();
    if(state==="failed"){
      for(let attempt=1;attempt<3;attempt++){
        const retry=iso(Date.parse(clock)+(attempt===1?300:1800)*1000);
        db.prepare("UPDATE question_requests SET status='received',lease_expires_at=NULL,retry_after=?,updated_at=?,revision=revision+1 WHERE request_id=?").run(retry,clock,id);advance(attempt===1?300:1800);claim();
      }
      db.prepare("UPDATE question_requests SET status='triage_failed',lease_expires_at=NULL,updated_at=?,revision=revision+1 WHERE request_id=?").run(clock,id);
    }else if(state==="junk")db.prepare("UPDATE question_requests SET status='junk',verdict_json=?,lease_expires_at=NULL,updated_at=?,revision=revision+1 WHERE request_id=?").run(verdict(false),clock,id);
    else{
      db.prepare("UPDATE question_requests SET status='triaged',verdict_json=?,lease_expires_at=NULL,updated_at=?,revision=revision+1 WHERE request_id=?").run(verdict(),clock,id);
      db.prepare("UPDATE question_requests SET status=?,updated_at=?,revision=revision+1 WHERE request_id=?").run(state==="confirmation_required"?"filled":"no_data",clock,id);
    }
    const value=state==="confirmation_required"?JSON.stringify({...spec(parent().revision),...override}):null;
    db.prepare("UPDATE question_request_results SET state=?,request_revision=?,spec_json=?,updated_at=?,response_deadline=min(expires_at,strftime('%Y-%m-%dT%H:%M:%SZ',?,'+1 day')),revision=revision+1 WHERE request_id=?").run(state==="junk"?"unsupported":state,parent().revision,value,clock,clock,id);
  });
  return {db,parent,result,requeue,remap,advance,clock:()=>clock,expires};
}
describe("bounded clarification migration",()=>{
  it("reapplies with legacy migrations without changing retained records",()=>{
    const x=fixture();expect(x.requeue()).toBe(true);
    for(const name of ["0010_question_requests","0013_question_request_results"])x.db.exec(readFileSync(`infra/migrations/${name}.sql`,"utf8"));x.db.exec(migration);x.db.exec(migration);
    expect(x.result()).toMatchObject({state:"triaging",clarification_count:1,request_revision:5});expect(x.parent().text).toBe("Original question");
    expect(x.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('question_requests_state_machine','question_request_results_transition')").all()).toHaveLength(0);
  });
  it("preserves original identity, deduplication and retention while clearing prior acceptance",()=>{
    const x=fixture(),before=x.parent();expect(x.requeue()).toBe(true);
    const q=x.parent(),r=x.result();for(const field of ["request_id","account_sub","text","text_hash","locale","created_at","expires_at"])expect(q[field]).toBe(before[field]);
    expect(r).toMatchObject({state:"triaging",spec_json:null,verified_json:null,attempt:0,lease_id:null,lease_owner:null,lease_expires_at:null});
    expect(x.db.prepare("SELECT text,generation,parent_revision FROM question_request_clarifications").get()).toMatchObject({text:"Clarified question",generation:1,parent_revision:5});
    expect(x.db.prepare("INSERT INTO question_requests(request_id,account_sub,text,locale,text_hash,status,created_at,updated_at,expires_at)VALUES(?,'owner','Original question','en',?,'received',?,?,?)").run(id,hash,before.created_at,before.created_at,x.expires).changes).toBe(0);
  });
  it("does not requeue another account or a stale sidecar revision",()=>{
    const x=fixture();expect(x.requeue("Question","other")).toBe(false);expect(x.requeue("Question","owner",99)).toBe(false);expect(x.parent().status).toBe("no_data");expect(x.result().revision).toBe(1);
  });
  it("rolls back the parent reset if the replacement text is invalid",()=>{
    const x=fixture();expect(()=>x.requeue("Question\u0000hidden")).toThrow();expect(x.parent().status).toBe("no_data");expect(x.result().state).toBe("clarification_required");expect(x.db.prepare("SELECT count(*) n FROM question_request_clarifications").get().n).toBe(0);
    for(const text of ["","x".repeat(501),"Q\u200dX","Q\u202eX"])expect(()=>x.requeue(text)).toThrow();
  });
  it("rejects expired response deadlines and duplicate submissions",()=>{
    const x=fixture();expect(x.requeue()).toBe(true);expect(x.requeue()).toBe(false);
    const y=fixture();y.advance(86400);expect(y.requeue()).toBe(false);expect(y.parent().status).toBe("no_data");
  });
  it("maps a new spec only to the freshly settled generation and validates UPDATE specs",()=>{
    const x=fixture();x.requeue();expect(()=>x.remap("confirmation_required",{request_revision:4})).toThrow();expect(x.parent().status).toBe("received");expect(x.result().state).toBe("triaging");
    expect(()=>x.remap("confirmation_required",{result_path:"https://attacker.invalid"})).toThrow();expect(()=>x.remap("confirmation_required",{extra:"text"})).toThrow();
    x.remap("confirmation_required");expect(x.result()).toMatchObject({state:"confirmation_required",request_revision:x.parent().revision,clarification_count:1});expect(JSON.parse(x.result().spec_json).request_revision).toBe(x.parent().revision);
    expect(()=>x.db.prepare("UPDATE question_request_results SET state='building',spec_json=?,revision=revision+1").run(JSON.stringify({...spec(x.parent().revision),catalog_digest:"c".repeat(64)}))).toThrow();
  });
  it("limits clarification to three generations with one latest replacement",()=>{
    const x=fixture();for(let generation=1;generation<=3;generation++){expect(x.requeue(`Question ${generation}`)).toBe(true);if(generation<3)x.remap();}
    expect(()=>x.remap()).toThrow();x.remap("unsupported");expect(x.requeue()).toBe(false);expect(x.result()).toMatchObject({clarification_count:3,state:"unsupported"});
    expect(x.db.prepare("SELECT count(*) n FROM question_request_clarifications").get().n).toBe(1);expect(x.db.prepare("SELECT text FROM question_request_clarifications").get().text).toBe("Question 3");
  });
  it.each(["junk","failed"])("settles a requeued %s outcome without leaving triaging",state=>{
    const x=fixture();x.requeue();x.remap(state);expect(x.result()).toMatchObject({state:state==="junk"?"unsupported":"failed",spec_json:null,request_revision:x.parent().revision});
  });
  it("expires abandoned triage without requiring an execution spec",()=>{
    const x=fixture();x.requeue();x.advance(86400);x.db.prepare("UPDATE question_request_results SET state='expired',updated_at=?,revision=revision+1").run(x.clock());expect(x.result().state).toBe("expired");
  });
  it("does not clear the claim clock or revive a request without a live clarification",()=>{
    const x=fixture();x.advance(86400);
    const reset=()=>x.db.prepare("UPDATE question_requests SET status='received',attempt=0,verdict_json=NULL,lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,claimed_at=NULL,retry_after=NULL,updated_at=?,revision=revision+1").run(x.clock());
    expect(reset).toThrow();expect(x.parent().status).toBe("no_data");
    const y=fixture();const future=iso(Date.parse(y.clock())+301_000);
    expect(()=>y.db.prepare("UPDATE question_requests SET status='received',attempt=0,verdict_json=NULL,lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,claimed_at=NULL,retry_after=NULL,updated_at=?,revision=revision+1").run(future)).toThrow(/timestamps/);
  });
  it.each(["confirmation_required","building","in_review"])("invalidates %s work to terminal stale with no live lease",state=>{
    const x=fixture();x.requeue();x.remap("confirmation_required");if(state!=="confirmation_required")x.db.exec("UPDATE question_request_results SET state='building',revision=revision+1");
    if(state==="in_review")x.db.prepare("UPDATE question_request_results SET state='in_review',attempt=1,lease_id='execute',lease_owner='service',lease_expires_at=?,revision=revision+1").run(iso(Date.parse(x.clock())+900_000));
    x.db.exec("UPDATE question_request_results SET state='stale',verified_json=NULL,lease_expires_at=NULL,revision=revision+1");expect(x.result().state).toBe("stale");expect(()=>x.db.exec("UPDATE question_request_results SET state='building',revision=revision+1")).toThrow();
  });
  it("prevents standalone text mutation, replacement or early deletion",()=>{
    const x=fixture();x.requeue();expect(()=>x.db.exec("UPDATE question_request_clarifications SET text='Changed'" )).toThrow();expect(()=>x.db.exec("DELETE FROM question_request_clarifications")).toThrow();
    expect(x.db.prepare("INSERT OR REPLACE INTO question_request_clarifications(request_id,generation,parent_revision,text,submitted_at)VALUES(?,1,5,'Changed',?)").run(id,x.clock()).changes).toBe(0);
    expect(()=>x.db.exec("UPDATE question_requests SET text='Changed',revision=revision+1")).toThrow();
  });
  it("cascades clarification deletion only at the original retention deadline",()=>{
    const x=fixture();x.requeue();x.advance(90*86400);
    x.db.prepare("DELETE FROM question_requests WHERE request_id=? AND expires_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')").run(id);
    expect(x.db.prepare("SELECT count(*) n FROM question_request_clarifications").get().n).toBe(0);expect(x.db.prepare("SELECT count(*) n FROM question_request_results").get().n).toBe(0);
  });
});
