import {describe,it,expect} from "vitest";
// @ts-expect-error Node test runtime module.
import {readFileSync} from "node:fs";
// @ts-expect-error Node test runtime module.
import {DatabaseSync} from "node:sqlite";
type DB=InstanceType<typeof DatabaseSync>;
const id="a".repeat(64),hash="b".repeat(64),iso=(n:number)=>new Date(Math.floor(n/1000)*1000).toISOString().replace(".000Z","Z");
const migration=readFileSync("infra/migrations/0015_question_request_notifications.sql","utf8");
const clear="lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,inflight_revision=NULL,inflight_status=NULL,inflight_result_path=NULL";
function fixture(){
  const db:DB=new DatabaseSync(":memory:"),clockDb:DB=new DatabaseSync(":memory:");db.exec("PRAGMA foreign_keys=ON");let clock=Date.now();
  db.function("strftime",{varargs:true},(...args:(string|number|null)[])=>{const bound=args.map(a=>a==="now"?iso(clock):a);return clockDb.prepare(`SELECT strftime(${bound.map(()=>"?").join(",")}) AS value`).get(...bound).value;});
  for(const name of ["0001_schema","0003_p16_dot_plot","0004_cache_slots","0005_account_question_history","0006_season_splits","0008_exploration_request_links","0009_manager_era_records","0010_question_requests","0011_opponent_labels","0012_cl_season_stage","0013_question_request_results","0014_question_request_clarifications"])db.exec(readFileSync(`infra/migrations/${name}.sql`,"utf8"));
  db.exec(migration);
  const expires=iso(clock+90*86400_000);
  const parent=(requestId=id,managed=true)=>{
    db.prepare("INSERT INTO question_requests(request_id,account_sub,text,locale,text_hash,status,created_at,updated_at,expires_at)VALUES(?,'owner','Original question','en',?,'received',?,?,?)").run(requestId,requestId,iso(clock),iso(clock),expires);
    if(managed)db.prepare("UPDATE question_requests SET status='triaging',attempt=1,lease_id='q2:triage',lease_owner='triage',lease_expires_at=?,claimed_at=?,revision=revision+1 WHERE request_id=?").run(iso(clock+900_000),iso(clock),requestId);
  };
  const insert=(requestId=id,status="triaging",path:string|null=null,expiry=expires)=>db.prepare("INSERT INTO question_request_notifications(request_id,desired_status,desired_result_path,created_at,updated_at,expires_at)VALUES(?,?,?,?,?,?)").run(requestId,status,path,iso(clock),iso(clock),expiry);
  const update=(set:string,values:unknown[]=[],requestId=id)=>db.prepare(`UPDATE question_request_notifications SET ${set},revision=revision+1,updated_at=? WHERE request_id=?`).run(...values,iso(clock),requestId);
  const grant=(create=true,requestId=id)=>update((create?"create_state='pending',creation_revision=desired_revision,creation_status=desired_status,creation_result_path=desired_result_path,":"")+"lease_id=?,lease_owner='notify',lease_expires_at=?,inflight_revision="+(create?"desired_revision":"CASE WHEN create_state='pending' THEN creation_revision ELSE desired_revision END")+",inflight_status="+(create?"desired_status":"CASE WHEN create_state='pending' THEN creation_status ELSE desired_status END")+",inflight_result_path="+(create?"desired_result_path":"CASE WHEN create_state='pending' THEN creation_result_path ELSE desired_result_path END"),["lease-"+clock,iso(clock+900_000)],requestId);
  const row=(requestId=id)=>db.prepare("SELECT * FROM question_request_notifications WHERE request_id=?").get(requestId);
  const desired=(status:string)=>update("desired_status=?,desired_result_path=NULL,desired_revision=desired_revision+1",[status]);
  const bind=(issue=101,requestId=id)=>update("create_state='bound',issue_number=?,"+clear,[issue],requestId);
  const release=()=>{
    const intent={competition:"PL",dimensions:[],entity_id:"fpl:code:1",entity_type:"player",filters:{},limit:1,metric:"goals",season:"2024-25",viz:"bar"};
    const path="/en/q?metric=goals&entity_type=player&entity_id=fpl%3Acode%3A1&season=2024-25&competition=PL&viz=bar&limit=1";
    const spec={version:1,request_id:id,request_revision:4,locale:"en",canonical_intent:JSON.stringify(intent),result_path:path,data_snapshot_id:"snapshot-1",catalog_digest:hash,artifact_key:hash,transform_code_version:"v1",renderer_version:"v1",expected_cell_state:"computable_now_queued"};
    const verdict={version:1,request_id:id,relevant:true,junk_reason:null,restated_question:"Show goals",tables:[],visuals:[],field_status:[],families:[]};
    db.prepare("UPDATE question_requests SET status='triaged',verdict_json=?,lease_expires_at=NULL,revision=revision+1 WHERE request_id=?").run(JSON.stringify(verdict),id);
    db.prepare("UPDATE question_requests SET status='filled',revision=revision+1 WHERE request_id=?").run(id);
    db.prepare("INSERT INTO snapshots(snapshot_id,created_at,sources_json,row_counts)VALUES('snapshot-1',?,'{}','{}')").run(iso(clock));
    db.prepare("INSERT INTO question_request_results(request_id,request_revision,state,spec_json,created_at,updated_at,response_deadline,expires_at)VALUES(?,4,'confirmation_required',?,?,?,?,?)").run(id,JSON.stringify(spec),iso(clock),iso(clock),iso(clock+86400_000),expires);
    db.exec("UPDATE question_request_results SET state='building',revision=revision+1");
    db.prepare("UPDATE question_request_results SET state='in_review',attempt=1,lease_id='result',lease_owner='executor',lease_expires_at=?,revision=revision+1").run(iso(clock+900_000));
    const evidence={artifact_key:hash,snapshot_id:"snapshot-1",entity_id:"fpl:code:1",value:0,attribution:"Fixture source",verified_at:iso(clock)};
    db.prepare("UPDATE question_request_results SET state='released',verified_json=?,lease_expires_at=NULL,revision=revision+1").run(JSON.stringify(evidence));
    return path;
  };
  parent();insert();return {db,parent,insert,update,grant,row,desired,bind,release,advance:(seconds:number)=>{clock+=seconds*1000;},now:()=>iso(clock),expires};
}
describe("durable ID-only notification migration",()=>{
  it("is idempotent and preserves only explicitly typed delivery metadata",()=>{
    const x=fixture();x.db.exec(migration);expect(x.row()).toMatchObject({revision:1,desired_revision:1,create_state:"ready",delivered_revision:0});
    const fields=x.db.prepare("PRAGMA table_info(question_request_notifications)").all().map((c:{name:string})=>c.name);
    expect(fields).not.toContain("text");expect(fields).not.toContain("account_sub");expect(fields).not.toContain("verdict_json");expect(fields).not.toContain("payload_json");
  });
  it("persists one create grant and never transitions pending back to ready",()=>{
    const x=fixture();x.grant();expect(x.row()).toMatchObject({create_state:"pending",creation_revision:1,creation_status:"triaging",inflight_revision:1});
    x.update(clear);expect(()=>x.update("create_state='ready',creation_revision=NULL,creation_status=NULL,creation_result_path=NULL")).toThrow();
    x.desired("building");x.grant(false);expect(x.row()).toMatchObject({desired_revision:2,desired_status:"building",creation_status:"triaging",inflight_status:"triaging",inflight_revision:1});
  });
  it("does not bind without a live pending lease, including NULL comparisons",()=>{
    const x=fixture();x.grant();x.update(clear);expect(()=>x.bind()).toThrow();
    x.grant(false);x.advance(901);expect(()=>x.bind()).toThrow();
    x.update(clear);x.grant(false);x.bind();expect(x.row()).toMatchObject({create_state:"bound",issue_number:101,delivered_revision:0,lease_id:null});
  });
  it("keeps issue binding immutable and unique across requests",()=>{
    const x=fixture();x.grant();x.bind();expect(()=>x.update("issue_number=102")).toThrow();expect(()=>x.update("create_state='pending',issue_number=NULL")).toThrow();
    const other="c".repeat(64);x.parent(other);x.insert(other);x.grant(true,other);expect(()=>x.bind(101,other)).toThrow();expect(x.row(other).issue_number).toBeNull();
  });
  it("prevents UPDATE OR REPLACE from deleting another request's one-time grant",()=>{
    const x=fixture();x.db.exec("PRAGMA recursive_triggers=OFF");x.grant();x.bind();const original=x.row();
    const other="c".repeat(64);x.parent(other);x.insert(other);x.grant(true,other);
    expect(()=>x.db.prepare(`UPDATE OR REPLACE question_request_notifications SET create_state='bound',issue_number=101,${clear},revision=revision+1,updated_at=? WHERE request_id=?`).run(x.now(),other)).toThrow();
    expect(x.row()).toEqual(original);expect(x.row(other).create_state).toBe("pending");
    expect(()=>x.db.prepare("INSERT OR REPLACE INTO question_request_notifications(request_id,desired_status,create_state,issue_number,created_at,updated_at,expires_at)VALUES(?,'triaging','bound',101,?,?,?)").run("d".repeat(64),x.now(),x.now(),x.expires)).toThrow();
    expect(x.row()).toEqual(original);
  });
  it("advances desired revision only on fixed content changes",()=>{
    const x=fixture();x.update("desired_status=desired_status");expect(x.row()).toMatchObject({revision:2,desired_revision:1});
    expect(()=>x.update("desired_revision=desired_revision+1")).toThrow();expect(()=>x.update("desired_status='building'")).toThrow();
    x.desired("building");expect(x.row()).toMatchObject({revision:3,desired_revision:2});
  });
  it("freezes inflight content while newer desired status advances",()=>{
    const x=fixture();x.grant();x.bind();x.grant(false);x.desired("building");x.desired("in_review");
    expect(x.row()).toMatchObject({desired_revision:3,inflight_revision:1,inflight_status:"triaging"});
    expect(()=>x.update("inflight_revision=desired_revision,inflight_status=desired_status")).toThrow();
    x.update("delivered_revision=inflight_revision,"+clear);expect(x.row()).toMatchObject({delivered_revision:1,desired_revision:3});
    x.grant(false);x.update("delivered_revision=inflight_revision,"+clear);expect(x.row().delivered_revision).toBe(3);
  });
  it("rejects false delivery, expired delivery and revision rollback",()=>{
    const x=fixture();expect(()=>x.update("delivered_revision=1")).toThrow();x.grant();x.bind();x.grant(false);
    x.advance(901);expect(()=>x.update("delivered_revision=inflight_revision,"+clear)).toThrow();x.update(clear);
    expect(()=>x.update("delivered_revision=1")).toThrow();expect(()=>x.db.prepare("UPDATE question_request_notifications SET revision=revision-1 WHERE request_id=?").run(id)).toThrow();
  });
  it("refuses lease extension, rebinding, malformed clocks and oversized leases",()=>{
    for(const change of ["lease_expires_at='2100-01-01T00:00:00Z'","lease_id='different'","lease_owner='different'","lease_expires_at='bad'","inflight_status='released',inflight_result_path='https://invalid.example'"]){
      const x=fixture();x.grant();expect(()=>x.update(change)).toThrow();
    }
  });
  it("rejects arbitrary statuses/paths and released content without current verified result",()=>{
    for(const [status,path] of [["raw question",null],["building","/en/q?x=1"],["released","https://invalid.example"],["released","/en/q?metric=goals"]] as const){
      const x=fixture();expect(()=>x.update("desired_status=?,desired_result_path=?,desired_revision=desired_revision+1",[status,path])).toThrow();
    }
  });
  it("permits current canonical release and preserves old create target while requiring stale-link refresh",()=>{
    const x=fixture(),path=x.release();x.update("desired_status='released',desired_result_path=?,desired_revision=desired_revision+1",[path]);x.grant();
    expect(x.row()).toMatchObject({creation_status:"released",creation_result_path:path});
    x.update(clear);x.advance(1);x.db.prepare("INSERT INTO snapshots(snapshot_id,created_at,sources_json,row_counts)VALUES('snapshot-2',?,'{}','{}')").run(x.now());
    x.grant(false);x.bind();expect(()=>x.grant(false)).toThrow();
    x.desired("stale");x.grant(false);expect(x.row()).toMatchObject({inflight_status:"stale",inflight_result_path:null,creation_status:"released",creation_result_path:path});
    x.update("delivered_revision=inflight_revision,"+clear);expect(x.row().delivered_revision).toBe(3);
  });
  it("excludes historical unmanaged requests but includes Phase1 junk and failures",()=>{
    const x=fixture(),other="c".repeat(64);x.parent(other,false);expect(()=>x.insert(other)).toThrow();
    x.desired("junk");x.grant();x.bind();x.desired("failed");expect(x.row()).toMatchObject({desired_status:"failed",issue_number:101});
  });
  it("does not reset retained rows via REPLACE or direct deletion",()=>{
    const x=fixture();x.grant();x.update(clear);x.desired("building");const before=x.row();
    x.db.prepare("INSERT OR REPLACE INTO question_request_notifications(request_id,desired_status,created_at,updated_at,expires_at)VALUES(?,'received',?,?,?)").run(id,x.now(),x.now(),x.expires);
    expect(x.row()).toEqual(before);expect(()=>x.db.prepare("DELETE FROM question_request_notifications WHERE request_id=?").run(id)).toThrow();
  });
  it("preserves parent retention and cascades parent/account deletion",()=>{
    const x=fixture();expect(()=>x.update("expires_at='2100-01-01T00:00:00Z'")).toThrow();
    const other="c".repeat(64);x.parent(other);expect(()=>x.insert(other,"triaging",null,"2100-01-01T00:00:00Z")).toThrow();
    x.db.prepare("DELETE FROM question_requests WHERE account_sub='owner'").run();expect(x.db.prepare("SELECT count(*) n FROM question_request_notifications").get().n).toBe(0);
  });
});
