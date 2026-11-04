import { describe,expect,it } from "vitest";
import { mapQuestionVerdict } from "../worker/src/core/question-request-intent";
import { readQuestionResultStatus } from "../worker/src/core/question-request-status";
import { Catalog } from "../worker/src/core/feasibility";
import { decodeCompiledCatalog } from "../worker/src/core/catalog-contract";
import compiled from "../worker/src/generated/catalog.json";
import type { Env } from "../worker/src/core/db";

const id="a".repeat(64),snapshot="b".repeat(64);
async function fixture() {
  const verdict={version:1,request_id:id,relevant:true,junk_reason:null,restated_question:"Untrusted restated goals question",tables:[{fields:["goals"],filters:{season:["2024-25"],competition:["PL"],person_id:["fpl:code:1"],opponent_id:[]}}],visuals:[{kind:"bar",table_index:0}],field_status:[{field:"goals",status:"available"}],families:[]};
  const mapped=await mapQuestionVerdict(verdict,{requestId:id,revision:4,locale:"en",snapshotId:snapshot,resolvePerson:async p=>p});
  if(mapped.kind!=="ready") throw new Error("fixture_not_ready");
  const row={request_id:id,request_revision:4,parent_revision:4,revision:1,state:"confirmation_required",spec_json:JSON.stringify(mapped.spec),verified_json:null as string|null,created_at:"2026-11-01T00:00:00Z",expires_at:"2027-01-01T00:00:00Z",parent_expires_at:"2027-01-01T00:00:00Z",response_deadline:"2026-11-03T00:00:00Z",db_now:"2026-11-02T00:00:00Z"};
  const data={snapshot,row,schema:true,person:{person_id:"fpl:code:1",web_name:"Server <Player>"},duringIdentity:null as (()=>void)|null,duringStatusRead:null as ((index:number)=>void)|null,removed:false};
  let statusReads=0;
  const queries:{sql:string;args:unknown[]}[]=[];
  const DB={prepare:(sql:string)=>{let args:unknown[]=[];const statement={bind:(...v:unknown[])=>{args=v;queries.push({sql,args});return statement;},first:async()=>{
    if(sql.includes("sqlite_master"))return data.schema?{name:"question_request_results"}:null;
    if(sql.includes("FROM question_request_results")){data.duringStatusRead?.(++statusReads);return args[1]==="owner"&&!data.removed?{...data.row,snapshot_id:data.snapshot}:null;}
    return sql.includes("FROM snapshots")?{snapshot_id:data.snapshot}:null;
  },all:async()=>{data.duringIdentity?.();return {results:[data.person]};}};return statement;}};
  return {row,data,mapped,queries,env:{DB} as unknown as Env};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function release(x: Fixture) {
  x.row.state="released";
  const evidence={artifact_key:x.mapped.spec.artifact_key,snapshot_id:snapshot,entity_id:"fpl:code:1",value:0,
    attribution:new Catalog(decodeCompiledCatalog(compiled)).checkFeasibility(x.mapped.intent,"en").attribution_text,
    verified_at:"2026-11-01T12:00:00Z"};
  x.row.verified_json=JSON.stringify(evidence);
  return evidence;
}
async function keyFor(spec: Fixture["mapped"]["spec"]) {
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode([
    spec.canonical_intent,spec.data_snapshot_id,spec.transform_code_version,spec.renderer_version,
  ].join("|")));
  return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,"0")).join("");
}
describe("account-owned request status projection",()=>{
  it("resolves a current selection using only server identity and catalog",async()=>{
    const x=await fixture(),view=await readQuestionResultStatus(x.env,"owner",id,"es");
    expect(view).toMatchObject({requestId:id,revision:1,state:"confirmation_required",currentBinding:true,personLabel:"Server <Player>",intent:x.mapped.intent});
    expect(JSON.stringify(view)).not.toContain("Untrusted");
    expect(x.queries[1]!.args).toEqual([id,"owner"]);
    expect(x.queries[1]!.sql).not.toMatch(/q\.text|verdict_json|account_sub AS/);
  });
  it("does not resolve identities or disclose another account's request",async()=>{
    const x=await fixture();expect(await readQuestionResultStatus(x.env,"other",id,"en")).toBeUndefined();expect(x.queries).toHaveLength(2);
  });
  it("keeps legacy status available until the additive migration is applied",async()=>{
    const x=await fixture();x.data.schema=false;expect(await readQuestionResultStatus(x.env,"owner",id,"en")).toBeUndefined();expect(x.queries).toHaveLength(1);
  });
  it.each(["generation","snapshot","catalog","renderer","path"])("suppresses actions for changed %s",async change=>{
    const x=await fixture();const spec={...x.mapped.spec};
    if(change==="generation") x.row.parent_revision++;
    if(change==="snapshot") x.data.snapshot="c".repeat(64);
    if(change==="catalog") spec.catalog_digest="d".repeat(64);
    if(change==="renderer") spec.renderer_version="old";
    if(change==="path") spec.result_path="https://attacker.invalid";
    x.row.spec_json=JSON.stringify(spec);
    expect(await readQuestionResultStatus(x.env,"owner",id,"en")).toMatchObject({state:"stale",currentBinding:false});
  });
  it("uses the database clock for both retention and response deadlines",async()=>{
    const x=await fixture();x.row.response_deadline=x.row.db_now;
    expect(await readQuestionResultStatus(x.env,"owner",id,"en")).toMatchObject({state:"expired",currentBinding:false});
    x.row.state="building";x.row.parent_expires_at=x.row.db_now;
    expect(await readQuestionResultStatus(x.env,"owner",id,"en")).toMatchObject({state:"expired"});
  });
  it.each(["snapshot","generation","deadline"])("rechecks %s after awaited identity resolution",async change=>{
    const x=await fixture();x.data.duringIdentity=()=>{if(change==="snapshot")x.data.snapshot="c".repeat(64);if(change==="generation")x.row.parent_revision++;if(change==="deadline")x.row.response_deadline=x.row.db_now;};
    const view=await readQuestionResultStatus(x.env,"owner",id,"en");expect(view?.state).toBe(change==="deadline"?"expired":"stale");expect(view?.currentBinding).toBe(false);
  });
  it("shows a localized released link only with finite, bound verified evidence",async()=>{
    const x=await fixture();x.row.state="released";
    expect(await readQuestionResultStatus(x.env,"owner",id,"es")).toMatchObject({state:"stale"});
    const evidence={artifact_key:x.mapped.spec.artifact_key,snapshot_id:snapshot,entity_id:"fpl:code:1",value:0,attribution:new Catalog(decodeCompiledCatalog(compiled)).checkFeasibility(x.mapped.intent,"en").attribution_text};
    x.row.verified_json=JSON.stringify(evidence);
    const result=await readQuestionResultStatus(x.env,"owner",id,"es");expect(result?.state).toBe("released");expect(result?.resultPath).toMatch(/^\/es\/q\?/);
    x.row.verified_json=JSON.stringify({...evidence,entity_id:"fpl:code:2"});
    expect(await readQuestionResultStatus(x.env,"owner",id,"es")).toMatchObject({state:"stale"});
  });
  it("does not advertise release evidence after publication during identity lookup",async()=>{
    const x=await fixture();x.row.state="released";x.row.verified_json=JSON.stringify({artifact_key:x.mapped.spec.artifact_key,snapshot_id:snapshot,entity_id:"fpl:code:1",value:0,attribution:new Catalog(decodeCompiledCatalog(compiled)).checkFeasibility(x.mapped.intent,"en").attribution_text});
    x.data.duringIdentity=()=>{x.data.snapshot="c".repeat(64);};
    const view=await readQuestionResultStatus(x.env,"owner",id,"es");expect(view).toMatchObject({state:"stale",currentBinding:false});expect(view?.resultPath).toBeUndefined();
  });
  it.each(["en","es"] as const)("exposes only a proved executed snapshot in %s",async locale=>{
    const x=await fixture();release(x);
    const result=await readQuestionResultStatus(x.env,"owner",id,locale);
    expect(result).toMatchObject({state:"released",currentBinding:true,executedSnapshotId:snapshot});
    expect(result?.resultPath).toMatch(new RegExp(`^/${locale}/q\\?`));
    expect(JSON.stringify(result)).not.toContain("verified_at");
    expect(JSON.stringify(result)).not.toContain("Untrusted");
  });
  it.each(["snapshot","catalog","renderer"])("retains historical provenance without a link after %s changes",async changed=>{
    const x=await fixture(),evidence=release(x),spec={...x.mapped.spec};
    if(changed==="snapshot")x.data.snapshot="c".repeat(64);
    if(changed==="catalog")spec.catalog_digest="d".repeat(64);
    if(changed==="renderer"){
      spec.renderer_version="legacy-renderer";spec.artifact_key=await keyFor(spec);
      evidence.artifact_key=spec.artifact_key;x.row.verified_json=JSON.stringify(evidence);
    }
    x.row.spec_json=JSON.stringify(spec);
    const result=await readQuestionResultStatus(x.env,"owner",id,"en");
    expect(result).toMatchObject({state:"stale",currentBinding:false,executedSnapshotId:snapshot});
    expect(result?.resultPath).toBeUndefined();
  });
  it.each(["triaging","confirmation_required","building","in_review","stale","failed","expired"])("never infers execution history from %s",async state=>{
    const x=await fixture();release(x);x.row.state=state;
    expect((await readQuestionResultStatus(x.env,"owner",id,"en"))?.executedSnapshotId).toBeUndefined();
  });
  it.each(["missing","partial","timestamp","future","before-created","invalid-date","entity","artifact","extra","duplicate","oversized","nonfinite","empty-attribution"])("omits historical metadata for %s evidence",async fault=>{
    const x=await fixture(),evidence:Record<string,unknown>=release(x);
    if(fault==="missing")x.row.verified_json=null;
    else if(fault==="partial") {delete evidence.verified_at;x.row.verified_json=JSON.stringify(evidence);}
    else if(fault==="duplicate")x.row.verified_json=JSON.stringify(evidence).replace('"value":0','"value":1,"value":0');
    else if(fault==="nonfinite")x.row.verified_json=JSON.stringify(evidence).replace('"value":0','"value":1e999');
    else {
      if(fault==="timestamp")evidence.verified_at="untrusted";
      if(fault==="future")evidence.verified_at="2026-11-02T00:00:01Z";
      if(fault==="before-created")evidence.verified_at="2026-10-31T23:59:59Z";
      if(fault==="invalid-date")evidence.verified_at="2026-02-30T12:00:00Z";
      if(fault==="entity")evidence.entity_id="fpl:code:2";
      if(fault==="artifact")evidence.artifact_key="c".repeat(64);
      if(fault==="extra")evidence.extra="untrusted";
      if(fault==="oversized")evidence.attribution="x".repeat(8193);
      if(fault==="empty-attribution")evidence.attribution=" \n";
      x.row.verified_json=JSON.stringify(evidence);
    }
    expect((await readQuestionResultStatus(x.env,"owner",id,"en"))?.executedSnapshotId).toBeUndefined();
  });
  it.each(["version","boolean-version","generation","request","locale","path","renderer","catalog","catalog-newline","intent","extra","duplicate","coverage"])("rejects malformed historical %s specs",async fault=>{
    const x=await fixture(),evidence=release(x),spec:Record<string,unknown>={...x.mapped.spec};
    if(fault==="version")spec.version=2;
    if(fault==="boolean-version")spec.version=true;
    if(fault==="generation")spec.request_revision=5;
    if(fault==="request")spec.request_id="c".repeat(64);
    if(fault==="locale")spec.locale=["en"];
    if(fault==="path")spec.result_path="//evil.invalid/path";
    if(fault==="renderer"){
      spec.renderer_version="bad|version";
      spec.artifact_key=await keyFor(spec as unknown as Fixture["mapped"]["spec"]);
      evidence.artifact_key=spec.artifact_key as string;x.row.verified_json=JSON.stringify(evidence);
    }
    if(fault==="catalog")spec.catalog_digest="not-a-hash";
    if(fault==="catalog-newline")spec.catalog_digest="a".repeat(63)+"\n";
    if(fault==="intent")spec.canonical_intent="not-json";
    if(fault==="extra")spec.extra="untrusted";
    if(fault==="coverage")spec.expected_cell_state="available\n";
    x.row.spec_json=JSON.stringify(spec);
    if(fault==="duplicate")x.row.spec_json=x.row.spec_json.replace('"version":1','"version":0,"version":1');
    expect((await readQuestionResultStatus(x.env,"owner",id,"en"))?.executedSnapshotId).toBeUndefined();
  });
  it.each(["snap\n","snap\u0000","<script>","../private","https://evil.test", "", "x".repeat(129)])("rejects unsafe snapshot %j even with a matching historical hash",async unsafe=>{
    const x=await fixture(),evidence=release(x),spec={...x.mapped.spec,data_snapshot_id:unsafe};
    spec.artifact_key=await keyFor(spec);evidence.snapshot_id=unsafe;evidence.artifact_key=spec.artifact_key;
    x.row.spec_json=JSON.stringify(spec);x.row.verified_json=JSON.stringify(evidence);
    expect((await readQuestionResultStatus(x.env,"owner",id,"en"))?.executedSnapshotId).toBeUndefined();
  });
  it.each(["generation","revision","spec","evidence","retention","owner","request"])("fences %s races after hashing and identity awaits",async fault=>{
    const x=await fixture();release(x);
    x.data.duringStatusRead=index=>{if(index!==3)return;
      if(fault==="generation")x.row.parent_revision++;
      if(fault==="revision")x.row.revision++;
      if(fault==="spec")x.row.spec_json="{}";
      if(fault==="evidence")x.row.verified_json=null;
      if(fault==="retention")x.row.parent_expires_at=x.row.db_now;
      if(fault==="owner")x.data.removed=true;
      if(fault==="request")x.row.request_id="c".repeat(64);
    };
    const result=await readQuestionResultStatus(x.env,"owner",id,"en");
    expect(result?.executedSnapshotId).toBeUndefined();expect(result?.resultPath).toBeUndefined();
    expect(result?.currentBinding).not.toBe(true);
  });
  it("rechecks ownership/generation on the early obsolete-binding path",async()=>{
    const x=await fixture();release(x);x.data.snapshot="c".repeat(64);
    x.data.duringStatusRead=index=>{if(index===2)x.row.parent_revision++;};
    const result=await readQuestionResultStatus(x.env,"owner",id,"en");
    expect(result).toMatchObject({state:"stale",currentBinding:false});expect(result?.executedSnapshotId).toBeUndefined();
  });
  it("suppresses a link if publication changes at the final provenance fence",async()=>{
    const x=await fixture();release(x);
    x.data.duringStatusRead=index=>{if(index===3)x.data.snapshot="c".repeat(64);};
    const result=await readQuestionResultStatus(x.env,"owner",id,"en");
    expect(result).toMatchObject({state:"stale",currentBinding:false,executedSnapshotId:snapshot});
    expect(result?.resultPath).toBeUndefined();
  });
  it("never discloses retained provenance to another account",async()=>{
    const x=await fixture();release(x);
    expect(await readQuestionResultStatus(x.env,"other",id,"en")).toBeUndefined();
    expect(x.queries).toHaveLength(2);
  });
});
