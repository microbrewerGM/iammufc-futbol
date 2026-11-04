import { describe, expect, it } from "vitest";
// @ts-expect-error Node test runtime module.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test runtime module.
import { DatabaseSync } from "node:sqlite";
import { D1QuestionResultStore } from "../worker/src/core/question-request-result-store";
import { mapQuestionVerdict } from "../worker/src/core/question-request-intent";
import { claimQuestionResult, completeQuestionResult, confirmQuestionResult, proposeQuestionResult, recoverQuestionResult, type ResultDeps } from "../worker/src/core/question-request-results";
import { Catalog } from "../worker/src/core/feasibility";
import { decodeCompiledCatalog } from "../worker/src/core/catalog-contract";
import compiled from "../worker/src/generated/catalog.json";

type Db = InstanceType<typeof DatabaseSync>;
class SqliteD1 {
  beforeWrite: (() => void) | null = null;
  constructor(readonly db: Db) {}
  prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind(...args: unknown[]) { values = args; return statement; },
      first: async <T>() => this.db.prepare(sql).get(...values) as T | null,
      all: async <T>() => {
        if (sql.startsWith("UPDATE question_request_results")) { const hook = this.beforeWrite; this.beforeWrite = null; hook?.(); }
        return { results: this.db.prepare(sql).all(...values) as T[] };
      },
    };
    return statement;
  }
}
const iso = (ms: number) => new Date(Math.floor(ms/1000)*1000).toISOString().replace(".000Z","Z");
async function fixture() {
  const db: Db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
  for (const name of ["0001_schema", "0003_p16_dot_plot", "0004_cache_slots", "0005_account_question_history", "0006_season_splits", "0007_exploration_requests", "0008_exploration_request_links", "0009_manager_era_records", "0010_question_requests", "0011_opponent_labels", "0012_cl_season_stage", "0013_question_request_results", "0014_question_request_clarifications", "0015_question_request_notifications", "0016_question_request_refresh", "0017_exploration_null_checks"]) db.exec(readFileSync(`infra/migrations/${name}.sql`,"utf8"));
  const id = "a".repeat(64), snapshot = "b".repeat(64), now = iso(Date.now()), expires = iso(Date.parse(now)+90*86400_000);
  let time = Date.parse(now); const clockDb = new DatabaseSync(":memory:");
  db.function("strftime",{varargs:true},(...args:(string|number|null)[])=>{
    const bound=args.map(arg=>arg==="now"?iso(time):arg);
    return clockDb.prepare(`SELECT strftime(${bound.map(()=>"?").join(",")}) AS value`).get(...bound).value;
  });
  const verdict = { version:1,request_id:id,relevant:true,junk_reason:null,restated_question:"Show goals",tables:[{fields:["goals"],filters:{season:["2024-25"],competition:["PL"],person_id:["fpl:code:1"],opponent_id:[]}}],visuals:[{kind:"bar",table_index:0}],field_status:[{field:"goals",status:"available"}],families:[] };
  db.prepare("INSERT INTO snapshots(snapshot_id,created_at,sources_json,row_counts) VALUES(?,?,'{}','{}')").run(snapshot,now);
  db.prepare("INSERT INTO question_requests(request_id,account_sub,text,locale,text_hash,status,created_at,updated_at,expires_at) VALUES(?,'owner','Show goals','en',?,'received',?,?,?)").run(id,snapshot,now,now,expires);
  db.prepare("UPDATE question_requests SET status='triaging',attempt=1,lease_id='triage-1',lease_owner='service',claimed_at=?,lease_expires_at=?,revision=2 WHERE request_id=?").run(now,iso(Date.parse(now)+900_000),id);
  db.prepare("UPDATE question_requests SET status='triaged',verdict_json=?,lease_expires_at=NULL,revision=3 WHERE request_id=?").run(JSON.stringify(verdict),id);
  db.prepare("UPDATE question_requests SET status='filled',revision=4 WHERE request_id=?").run(id);
  const mapped = await mapQuestionVerdict(verdict,{requestId:id,revision:4,locale:"en",snapshotId:snapshot,resolvePerson:async p=>p});
  if (mapped.kind!=="ready") throw new Error("fixture_not_ready");
  const d1 = new SqliteD1(db), store = new D1QuestionResultStore(d1 as unknown as D1Database);
  let lease=0;
  const deps: ResultDeps = { store,now:()=>new Date(time),newLeaseId:()=>`lease-${++lease}`,currentBinding:async request=>({revision:db.prepare("SELECT revision FROM question_requests WHERE request_id=?").get(request).revision,snapshotId:db.prepare("SELECT snapshot_id FROM snapshots ORDER BY created_at DESC LIMIT 1").get().snapshot_id}) };
  const response = { artifact_key:mapped.spec.artifact_key,intent:mapped.intent,snapshot_id:snapshot,feasibility:{state:"computable_now_queued"},rows:[{label:"Player",route_key:"fpl:code:1",value:0}],attribution:[new Catalog(decodeCompiledCatalog(compiled)).checkFeasibility(mapped.intent,"en").attribution_text] };
  return {db,d1,store,deps,id,mapped,response,expires,advance:(seconds:number)=>{time+=seconds*1000;}};
}
describe("atomic D1 request-result adapter",()=>{
  it("persists a confirmed and verified result through real SQLite constraints",async()=>{
    const x=await fixture();
    expect(await proposeQuestionResult(x.deps,"owner",x.mapped.spec,x.expires)).toBe("accepted");
    expect(await confirmQuestionResult(x.deps,x.id,1,"owner")).toBe("accepted");
    const history = x.db.prepare("SELECT * FROM question_request_confirmations WHERE request_id=?").all(x.id);
    expect(history).toHaveLength(1);
    expect(history[0].accepted_revision).toBe(1);
    expect(JSON.parse(history[0].spec_json)).toEqual(x.mapped.spec);
    expect(x.db.prepare("SELECT * FROM question_request_confirmation_context").all()).toHaveLength(0);
    expect(await claimQuestionResult(x.deps,x.id,2,"service")).toBe("accepted");
    const row=(await x.store.get(x.id))!;
    expect(await completeQuestionResult(x.deps,x.id,row.revision,"service",row.leaseId!,x.response)).toBe("accepted");
    const saved=(await x.store.get(x.id))!;
    expect(saved.state).toBe("released"); expect(saved.evidence?.value).toBe(0);
  });
  it("refuses duplicate creation and wrong-account mutation",async()=>{
    const x=await fixture(); await proposeQuestionResult(x.deps,"owner",x.mapped.spec,x.expires);
    expect(await proposeQuestionResult(x.deps,"owner",x.mapped.spec,x.expires)).toBe("conflict");
    expect(await confirmQuestionResult(x.deps,x.id,1,"other")).toBe("not_found");
    const row=(await x.store.get(x.id))!;
    expect(await x.store.compareAndSet({...row,accountSub:"other"},{...row,accountSub:"other",revision:2,state:"building"})).toBe(false);
  });
  it("fences a snapshot change at the actual SQL write boundary",async()=>{
    const x=await fixture(); await proposeQuestionResult(x.deps,"owner",x.mapped.spec,x.expires);
    x.d1.beforeWrite=()=>x.db.prepare("INSERT INTO snapshots(snapshot_id,created_at,sources_json,row_counts) VALUES(?,?,'{}','{}')").run("c".repeat(64),iso(Date.now()+1000));
    expect(await confirmQuestionResult(x.deps,x.id,1,"owner")).toBe("conflict");
    expect((await x.store.get(x.id))!.state).toBe("confirmation_required");
  });
  it("fences stale revisions with a single conditional write",async()=>{
    const x=await fixture(); await proposeQuestionResult(x.deps,"owner",x.mapped.spec,x.expires);
    const row=(await x.store.get(x.id))!;
    expect(await confirmQuestionResult(x.deps,x.id,1,"owner")).toBe("accepted");
    expect(await x.store.compareAndSet(row,{...row,revision:2,state:"building"})).toBe(false);
  });
  it("fences snapshot changes immediately before release persistence",async()=>{
    const x=await fixture(); await proposeQuestionResult(x.deps,"owner",x.mapped.spec,x.expires); await confirmQuestionResult(x.deps,x.id,1,"owner"); await claimQuestionResult(x.deps,x.id,2,"service");
    const row=(await x.store.get(x.id))!;
    x.d1.beforeWrite=()=>x.db.prepare("INSERT INTO snapshots(snapshot_id,created_at,sources_json,row_counts) VALUES(?,?,'{}','{}')").run("c".repeat(64),iso(Date.now()+1000));
    expect(await completeQuestionResult(x.deps,x.id,row.revision,"service",row.leaseId!,x.response)).toBe("conflict");
    expect((await x.store.get(x.id))!.evidence).toBeNull();
  });
  it("requires expired work to recover before obtaining a fresh lease",async()=>{
    const x=await fixture(); await proposeQuestionResult(x.deps,"owner",x.mapped.spec,x.expires); await confirmQuestionResult(x.deps,x.id,1,"owner"); await claimQuestionResult(x.deps,x.id,2,"service");
    x.advance(900); const row=(await x.store.get(x.id))!;
    expect(await claimQuestionResult(x.deps,x.id,row.revision,"service")).toBe("conflict");
    expect(await recoverQuestionResult(x.deps,x.id,row.revision)).toBe("accepted");
    const recovered=(await x.store.get(x.id))!;
    expect(await claimQuestionResult(x.deps,x.id,recovered.revision,"service")).toBe("accepted");
    expect((await x.store.get(x.id))!.attempt).toBe(2);
  });
  it("checks the authoritative confirmation deadline inside SQL",async()=>{
    const x=await fixture(); await proposeQuestionResult(x.deps,"owner",x.mapped.spec,x.expires);
    x.d1.beforeWrite=()=>x.advance(86400);
    expect(await confirmQuestionResult(x.deps,x.id,1,"owner")).toBe("conflict");
    expect((await x.store.get(x.id))!.state).toBe("confirmation_required");
  });
  it("can expire old work after its snapshot changes",async()=>{
    const x=await fixture(); await proposeQuestionResult(x.deps,"owner",x.mapped.spec,x.expires);
    x.db.prepare("INSERT INTO snapshots(snapshot_id,created_at,sources_json,row_counts) VALUES(?,?,'{}','{}')").run("c".repeat(64),iso(Date.now()+1000));
    x.advance(86400);
    expect(await recoverQuestionResult(x.deps,x.id,1)).toBe("accepted");
    expect((await x.store.get(x.id))!.state).toBe("expired");
  });
  it("fences a changed parent generation immediately before SQL mutation",async()=>{
    const x=await fixture(); await proposeQuestionResult(x.deps,"owner",x.mapped.spec,x.expires);
    x.d1.beforeWrite=()=>{
      // Future clarification requeue will authorize a new generation. This
      // fixture lifts only the legacy parent transition trigger to simulate it.
      x.db.exec("DROP TRIGGER question_requests_clarification_state_machine");
      x.db.prepare("UPDATE question_requests SET revision=revision+1 WHERE request_id=?").run(x.id);
    };
    expect(await confirmQuestionResult(x.deps,x.id,1,"owner")).toBe("conflict");
    expect((await x.store.get(x.id))!.revision).toBe(1);
  });
});
