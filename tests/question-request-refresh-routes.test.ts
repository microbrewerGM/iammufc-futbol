import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Node test runtime module.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test runtime module.
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { accessGate, type AccessIdentity } from "../worker/src/security/auth";
import { createQuestionRequestsRouter, type RouteEnv } from "../worker/src/routes/question-requests";
import { mapQuestionVerdict } from "../worker/src/core/question-request-intent";
import { readQuestionResultStatus } from "../worker/src/core/question-request-status";
import { Catalog } from "../worker/src/core/feasibility";
import { decodeCompiledCatalog } from "../worker/src/core/catalog-contract";
import compiled from "../worker/src/generated/catalog.json";

type DB=InstanceType<typeof DatabaseSync>;
const opened:DB[]=[];
afterEach(()=>{for(const db of opened.splice(0))db.close();vi.useRealTimers();});
const id="a".repeat(64),stamp=(ms:number)=>new Date(ms).toISOString().replace(/\.\d{3}Z$/,"Z");
const headers={origin:"https://site.invalid","content-type":"application/x-www-form-urlencoded"};
const access={ACCESS_ISSUER:"https://example.cloudflareaccess.com",ACCESS_AUD:"a".repeat(64),ACCESS_OWNER_EMAILS:"owner@example.invalid",ACCESS_SERVICE_CLIENT_IDS:"service"};
async function fixture(locale:"en"|"es"="en") {
  const db:DB=new DatabaseSync(":memory:"),clock:DB=new DatabaseSync(":memory:");opened.push(db,clock);
  db.exec("PRAGMA foreign_keys=ON");let time=Date.parse("2026-11-04T00:00:00Z"),publication=0;
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(time);
  db.function("strftime",{varargs:true},(...args:(string|number|null)[])=>{
    const values=args.map(a=>a==="now"?stamp(time):a);
    return clock.prepare(`SELECT strftime(${values.map(()=>"?").join(",")}) value`).get(...values).value;
  });
  for(const name of ["0001_schema","0003_p16_dot_plot","0004_cache_slots","0005_account_question_history","0006_season_splits","0007_exploration_requests","0008_exploration_request_links","0009_manager_era_records","0010_question_requests","0011_opponent_labels","0012_cl_season_stage","0013_question_request_results","0014_question_request_clarifications","0015_question_request_notifications","0016_question_request_refresh","0017_exploration_null_checks"])
    db.exec(readFileSync(`infra/migrations/${name}.sql`,"utf8"));
  const now=()=>stamp(time),expires=stamp(time+90*86400_000);
  const publish=(snapshot:string)=>db.prepare("INSERT INTO snapshots VALUES(?,?,'{}','{}')").run(snapshot,stamp(time+1000*++publication));
  publish("snapshot-1");
  db.exec("INSERT INTO players VALUES('fpl:1:2024-25',1,'2024-25','Server Player','First','Last','FWD','MUN')");
  db.exec("INSERT INTO player_identities VALUES('fpl:1:2024-25','fpl:code:1','fpl',1,'2024-25')");
  db.exec("INSERT INTO player_season_stats(player_id,season,competition,snapshot_id) VALUES('fpl:1:2024-25','2024-25','PL','snapshot-1')");
  const verdict={version:1,request_id:id,relevant:true,junk_reason:null,restated_question:"PRIVATE MODEL TEXT",tables:[{fields:["goals"],filters:{season:["2024-25"],competition:["PL"],person_id:["fpl:code:1"],opponent_id:[]}}],visuals:[{kind:"bar",table_index:0}],field_status:[{field:"goals",status:"available"}],families:[]};
  db.prepare("INSERT INTO question_requests(request_id,account_sub,text,locale,text_hash,status,created_at,updated_at,expires_at) VALUES(?,'owner','PRIVATE QUESTION',?,?,'received',?,?,?)").run(id,locale,"b".repeat(64),now(),now(),expires);
  db.prepare("UPDATE question_requests SET status='triaging',attempt=1,lease_id='seed',lease_owner='service',claimed_at=?,lease_expires_at=?,revision=2").run(now(),stamp(time+900_000));
  db.prepare("UPDATE question_requests SET status='triaged',verdict_json=?,lease_expires_at=NULL,revision=3").run(JSON.stringify(verdict));
  db.exec("UPDATE question_requests SET status='filled',revision=4");
  const mapped=await mapQuestionVerdict(verdict,{requestId:id,revision:4,locale,snapshotId:"snapshot-1",resolvePerson:async p=>p});
  if(mapped.kind!=="ready")throw new Error("fixture_not_ready");
  db.prepare("INSERT INTO question_request_results(request_id,request_revision,state,spec_json,created_at,updated_at,response_deadline,expires_at) VALUES(?,4,'confirmation_required',?,?,?,?,?)").run(id,JSON.stringify(mapped.spec),now(),now(),stamp(time+86400_000),expires);
  let beforeRead:((sql:string)=>void)|undefined,queries=0;
  const DB={prepare(sql:string){queries++;let values:unknown[]=[];const query={bind(...args:unknown[]){values=args;return query;},
    async first<T>(){beforeRead?.(sql);return (db.prepare(sql).get(...values)??null) as T|null;},
    async all<T>(){beforeRead?.(sql);return {results:db.prepare(sql).all(...values) as T[]};},
    async run(){return db.prepare(sql).run(...values);}};return query;}};
  const env={...access,DB};
  function app(identity:AccessIdentity|null={sub:"owner",email:"owner@example.invalid"}) {
    const a=new Hono<RouteEnv>();a.use("*",accessGate(async()=>{if(!identity)throw new Error("denied");return identity;}));a.route("/",createQuestionRequestsRouter());return a;
  }
  const row=()=>db.prepare("SELECT * FROM question_request_results").get();
  const post=(body=`expected_revision=${row().revision}`,identity?:AccessIdentity|null,extra:Record<string,string>={},action="refresh")=>
    app(identity).request(`https://site.invalid/${locale}/requests/${id}/${action}`,{method:"POST",headers:{...headers,...extra},body},env as never);
  const page=()=>app().request(`https://site.invalid/${locale}/requests?id=${id}`,{},env as never);
  const count=()=>db.prepare("SELECT refresh_count n FROM question_request_refresh_counts").get().n;
  const release=async()=>{
    expect((await post(undefined,undefined,{},"confirm")).status).toBe(303);
    db.prepare("UPDATE question_request_results SET state='in_review',revision=revision+1,attempt=1,lease_id='old',lease_owner='service',lease_expires_at=?").run(stamp(time+900_000));
    db.prepare("UPDATE question_request_results SET state='released',revision=revision+1,lease_expires_at=NULL,verified_json=?").run(JSON.stringify({artifact_key:mapped.spec.artifact_key,snapshot_id:"snapshot-1",entity_id:"fpl:code:1",value:0,attribution:new Catalog(decodeCompiledCatalog(compiled)).checkFeasibility(mapped.intent,locale).attribution_text,verified_at:now()}));
  };
  return {db,env,row,post,page,publish,count,mapped,app,release,queries:()=>queries,advance:(seconds:number)=>{time+=seconds*1000;vi.setSystemTime(time);},beforeRead:(hook:(sql:string)=>void)=>{beforeRead=hook;}};
}

describe("request refresh HTTP boundary against migrations through 0017",()=>{
  it.each(["en","es"] as const)("replaces the same %s intent and requires separate confirmation",async locale=>{
    const x=await fixture(locale);x.publish("snapshot-2");const before=x.row();
    expect(await (await x.page()).text()).toContain(`/${locale}/requests/${id}/refresh`);
    const response=await x.post();expect(response.status).toBe(303);expect(response.headers.get("location")).toBe(`/${locale}/requests?id=${id}`);
    const next=x.row(),spec=JSON.parse(next.spec_json);expect(next.state).toBe("confirmation_required");expect(next.revision).toBe(before.revision+1);
    expect(spec.canonical_intent).toBe(x.mapped.spec.canonical_intent);expect(spec.data_snapshot_id).toBe("snapshot-2");expect(next.verified_json).toBeNull();
    const html=await (await x.page()).text();expect(html).toContain("Server Player");expect(html).toContain("2024-25");expect(html).toContain(`/${locale}/requests/${id}/confirm`);
    expect(html).not.toContain("PRIVATE");expect(html).not.toContain("/q?");expect(html).not.toContain("Confirmation history");
    expect((await x.post(undefined,undefined,{},"confirm")).status).toBe(303);expect(x.row().state).toBe("building");
    expect((await x.post(`expected_revision=${next.revision}`,undefined,{},"confirm")).status).toBe(409);
    const history=await (await x.page()).text();expect(history).toContain(locale==="es"?"Historial de confirmaciones":"Confirmation history");
    expect(history).not.toContain(locale==="es"?"Procedencia de los datos":"Data provenance");expect(history).not.toContain("/q?");
  });
  it.each([null,{sub:"",serviceClientId:"service"},{sub:"other",email:"owner@example.invalid"}] as const)("refuses anonymous, service and wrong-account mutations: %j",async identity=>{
    const x=await fixture();x.publish("snapshot-2");const before=x.row();
    expect((await x.post(undefined,identity)).status).toBe(identity?.sub==="other"?409:403);expect(x.row()).toEqual(before);expect(x.count()).toBe(0);
  });
  it.each(["expected_revision=1&expected_revision=1","expected_revision=1&account=owner","expected_revision=1&spec=x","expected_revision=1&intent=x","expected_revision=01","expected_revision=0","expected_revision=-1","expected_revision=1%0A","expected_revision=9007199254740992","expected_revision=%ZZ","unexpected=1",""])("rejects malformed forms without mutation: %s",async body=>{
    const x=await fixture();x.publish("snapshot-2");expect((await x.post(body)).status).toBe(400);expect(x.count()).toBe(0);expect(x.row().revision).toBe(1);
  });
  it("bounds streamed and declared input and rejects invalid content types",async()=>{
    const x=await fixture();x.publish("snapshot-2");
    expect((await x.post("x".repeat(129))).status).toBe(413);
    expect((await x.post(undefined,undefined,{"content-length":"129"})).status).toBe(413);
    expect((await x.post(undefined,undefined,{"content-type":"application/json"})).status).toBe(400);expect(x.count()).toBe(0);
  });
  it.each<Record<string,string>>([{origin:"https://other.invalid"},{origin:""},{"sec-fetch-site":"cross-site"}])("rejects cross-origin input: %j",async extra=>{
    const x=await fixture();x.publish("snapshot-2");expect((await x.post(undefined,undefined,extra)).status).toBe(403);expect(x.count()).toBe(0);
  });
  it("gives concurrent and duplicate revisions one winner",async()=>{
    const x=await fixture();x.publish("snapshot-2");
    const results=await Promise.all([x.post("expected_revision=1"),x.post("expected_revision=1")]);
    expect(results.map(r=>r.status).sort()).toEqual([303,409]);expect(x.count()).toBe(1);
    expect((await x.post("expected_revision=1")).status).toBe(409);
  });
  it("suppresses both actions and refuses both writes with incomplete schema",async()=>{
    const x=await fixture();x.publish("snapshot-2");x.db.exec("DROP TRIGGER question_request_results_record_confirmation");
    const html=await (await x.page()).text();expect(html).not.toContain(`/requests/${id}/refresh`);expect(html).not.toContain(`/requests/${id}/confirm`);
    expect((await x.post()).status).toBe(503);expect((await x.post(undefined,undefined,{},"confirm")).status).toBe(503);expect(x.count()).toBe(0);
  });
  it("shows pending, expiry, exhaustion and unavailable outcomes explicitly",async()=>{
    const x=await fixture();expect((await x.post(undefined,undefined,{},"confirm")).status).toBe(303);
    expect(await (await x.page()).text()).toContain("Your request is pending.");
    for(let n=2;n<=4;n++){x.publish(`snapshot-${n}`);expect((await x.post()).status).toBe(303);expect((await x.post(undefined,undefined,{},"confirm")).status).toBe(303);}
    x.publish("snapshot-5");expect((await x.post()).status).toBe(409);expect(await (await x.page()).text()).toContain("The refresh limit has been reached.");
    x.advance(90*86400);expect((await x.post()).status).toBe(409);expect(await (await x.page()).text()).toContain("This request has expired.");
    const y=await fixture();y.publish("snapshot-2");y.db.exec("DELETE FROM player_identities");expect((await y.post()).status).toBe(503);
    expect(await (await y.post()).text()).toContain("Refresh is temporarily unavailable.");
    expect(await (await y.page()).text()).not.toContain(`/requests/${id}/refresh`);
  });
  it("never grants a replaced release link or interprets approvals as execution",async()=>{
    const x=await fixture();await x.release();expect(await (await x.page()).text()).toContain("/q?");
    x.publish("snapshot-2");expect(await (await x.page()).text()).not.toContain("/q?");
    expect((await x.post()).status).toBe(303);const html=await (await x.page()).text();
    expect(html).toContain("Confirmation history");expect(html).not.toContain("Data provenance");expect(html).not.toContain("/q?");
    const status=await readQuestionResultStatus(x.env as never,"owner",id,"en");expect(status?.confirmationHistory).toHaveLength(1);expect(status?.executedSnapshotId).toBeUndefined();
    expect(await readQuestionResultStatus(x.env as never,"other",id,"en")).toBeUndefined();
  });
  it("does not activate refresh on a safe method",async()=>{
    const x=await fixture();expect((await x.app().request(`https://site.invalid/en/requests/${id}/refresh`,{},x.env as never)).status).toBe(405);expect(x.count()).toBe(0);
  });
  it.each(["retention","revision","publication","ownership"])("fences %s changes at the final metadata read",async change=>{
    const x=await fixture();await x.release();expect(await (await x.page()).text()).toContain("/q?");
    let metadataReads=0;
    x.beforeRead(sql=>{
      if(!sql.includes("JOIN question_request_refresh_counts c") || ++metadataReads!==2)return;
      if(change==="retention")x.advance(90*86400);
      if(change==="revision")x.db.exec("UPDATE question_request_results SET state='stale',revision=revision+1,verified_json=NULL");
      if(change==="publication")x.publish("snapshot-2");
      if(change==="ownership")x.db.exec("DELETE FROM question_requests");
    });
    const view=await readQuestionResultStatus(x.env as never,"owner",id,"en");
    expect(view?.resultPath).toBeUndefined();expect(view?.confirmationAvailable).not.toBe(true);
    expect(view?.confirmationHistory).toBeUndefined();
  });
  it.each(["publication","retention"])("rechecks %s on the incomplete-schema fallback",async change=>{
    const x=await fixture();await x.release();x.db.exec("DROP TRIGGER question_request_results_record_confirmation");
    let changed=false;x.beforeRead(sql=>{if(changed || !sql.includes("SELECT type,name FROM sqlite_master"))return;changed=true;
      if(change==="publication")x.publish("snapshot-2");else x.advance(90*86400);
    });
    const view=await readQuestionResultStatus(x.env as never,"owner",id,"en");
    expect(view?.resultPath).toBeUndefined();expect(view?.currentBinding).toBe(false);expect(view?.confirmationAvailable).toBe(false);
  });
  it("keeps three complete-schema released status reads below 45 queries",async()=>{
    const x=await fixture();await x.release();const before=x.queries();
    for(let n=0;n<3;n++)expect((await readQuestionResultStatus(x.env as never,"owner",id,"en"))?.resultPath).toContain("/en/q?");
    expect(x.queries()-before).toBeLessThan(45);
  });
});
