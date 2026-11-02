import {describe,expect,it,vi,beforeEach} from "vitest";
import {executeQuestionResult,executeRequestQuery,readQuestionResults,type RequestExecutionDeps} from "../worker/src/core/question-request-execution";
import {mapQuestionVerdict} from "../worker/src/core/question-request-intent";
import {proposeQuestionResult,confirmQuestionResult,recoverQuestionResult,type QuestionResult} from "../worker/src/core/question-request-results";
import {currentSnapshot,enforceBudget,readQueryCache,runQuery,writeQueryCache,type Env} from "../worker/src/core/db";
import {Catalog} from "../worker/src/core/feasibility";
import {decodeCompiledCatalog} from "../worker/src/core/catalog-contract";
import compiled from "../worker/src/generated/catalog.json";
vi.mock("../worker/src/core/db",async original=>({...await original<typeof import("../worker/src/core/db")>(),currentSnapshot:vi.fn(),enforceBudget:vi.fn(),readQueryCache:vi.fn(),runQuery:vi.fn(),writeQueryCache:vi.fn()}));
const id="a".repeat(64),snapshot="b".repeat(64),env={} as Env;
async function fixture(confirmed=true){
  const mapped=await mapQuestionVerdict({version:1,request_id:id,relevant:true,junk_reason:null,restated_question:"Show goals",tables:[{fields:["goals"],filters:{season:["2024-25"],competition:["PL"],person_id:["fpl:code:1"],opponent_id:[]}}],visuals:[{kind:"bar",table_index:0}],field_status:[],families:[]},{requestId:id,revision:4,locale:"en",snapshotId:snapshot,resolvePerson:async p=>p});
  if(mapped.kind!=="ready")throw new Error("fixture_not_ready");
  let row:QuestionResult|null=null,time=Date.parse("2026-11-02T00:00:00Z"),lease=0;
  const binding={revision:4,snapshotId:snapshot};
  const response={artifact_key:mapped.spec.artifact_key,intent:mapped.intent,snapshot_id:snapshot,feasibility:{state:"computable_now_queued"},rows:[{route_key:"fpl:code:1",label:"Player",value:0}],attribution:[new Catalog(decodeCompiledCatalog(compiled)).checkFeasibility(mapped.intent,"en").attribution_text]};
  const deps:RequestExecutionDeps={now:()=>new Date(time),newLeaseId:()=>`lease-${++lease}`,currentBinding:async()=>({...binding}),
    store:{get:async request=>request===id&&row?structuredClone(row):null,compareAndSet:async(before,next)=>{
      if(row?.revision!==before?.revision || next.requestRevision!==binding.revision || !["failed","expired"].includes(next.state)&&next.spec.data_snapshot_id!==binding.snapshotId || next.state==="released"&&(!before?.leaseExpiresAt||Date.parse(before.leaseExpiresAt)<=time))return false;
      row=structuredClone(next);return true;
    }},selection:async r=>({revision:r.revision,intent:mapped.intent,currentBinding:true}),execute:vi.fn(async()=>response)};
  await proposeQuestionResult(deps,"owner",mapped.spec,"2026-12-01T00:00:00Z");if(confirmed)await confirmQuestionResult(deps,id,1,"owner");
  const read=()=>{if(!row)throw new Error("missing");return structuredClone(row);};
  return {deps,mapped,response,read,binding,advance:(seconds:number)=>{time+=seconds*1000;}};
}
beforeEach(()=>{vi.clearAllMocks();vi.mocked(currentSnapshot).mockResolvedValue(snapshot);vi.mocked(readQueryCache).mockResolvedValue({outcome:"miss",result:null});vi.mocked(enforceBudget).mockResolvedValue(true);vi.mocked(writeQueryCache).mockResolvedValue(true);});
describe("trusted confirmed request execution",()=>{
  it("claims once, verifies a numeric zero and refuses duplicate delivery",async()=>{
    const x=await fixture();expect(await executeQuestionResult(x.deps,id,2,"service")).toBe("accepted");expect(x.read()).toMatchObject({state:"released",evidence:{value:0}});
    expect(await executeQuestionResult(x.deps,id,2,"service")).toBe("conflict");expect(x.deps.execute).toHaveBeenCalledTimes(1);
  });
  it("requires confirmation and a current server selection before compute",async()=>{
    const x=await fixture(false);expect(await executeQuestionResult(x.deps,id,1,"service")).toBe("conflict");expect(x.deps.execute).not.toHaveBeenCalled();
    await confirmQuestionResult(x.deps,id,1,"owner");x.deps.selection=async()=>({revision:2,currentBinding:false});expect(await executeQuestionResult(x.deps,id,2,"service")).toBe("conflict");expect(x.deps.execute).not.toHaveBeenCalled();
  });
  it("only the CAS winner computes under simultaneous delivery",async()=>{
    const x=await fixture();expect((await Promise.all([executeQuestionResult(x.deps,id,2,"one"),executeQuestionResult(x.deps,id,2,"two")])).sort()).toEqual(["accepted","conflict"]);expect(x.deps.execute).toHaveBeenCalledTimes(1);
  });
  it("does not compute after a post-claim storage pause outlives the lease",async()=>{
    const x=await fixture(),get=x.deps.store.get;let reads=0;
    x.deps.store.get=async request=>{const row=await get(request);if(++reads===3)x.advance(900);return row;};
    expect(await executeQuestionResult(x.deps,id,2,"service")).toBe("conflict");expect(x.deps.execute).not.toHaveBeenCalled();
  });
  it.each(["snapshot","generation"])("does not compute after %s changes during post-claim storage",async change=>{
    const x=await fixture(),get=x.deps.store.get;let reads=0;
    x.deps.store.get=async request=>{const row=await get(request);if(++reads===3){if(change==="snapshot")x.binding.snapshotId="c".repeat(64);else x.binding.revision++;}return row;};
    expect(await executeQuestionResult(x.deps,id,2,"service")).toBe("conflict");expect(x.deps.execute).not.toHaveBeenCalled();
  });
  it.each(["empty","wrong_person","null","nonfinite"])("never releases %s result",async bad=>{
    const x=await fixture();if(bad==="empty")x.response.rows=[];if(bad==="wrong_person")x.response.rows[0]!.route_key="fpl:code:2";if(bad==="nonfinite")x.response.rows[0]!.value=Infinity;
    x.deps.execute=async()=>bad==="null"?null:x.response;
    expect(await executeQuestionResult(x.deps,id,2,"service")).toBe("invalid_result");expect(x.read().state).toBe("in_review");expect(x.read().evidence).toBeNull();
  });
  it.each(["snapshot","generation","lease"])("does not release after %s changes during execution",async change=>{
    const x=await fixture();x.deps.execute=async()=>{if(change==="snapshot")x.binding.snapshotId="c".repeat(64);if(change==="generation")x.binding.revision++;if(change==="lease")x.advance(900);return x.response;};
    expect(await executeQuestionResult(x.deps,id,2,"service")).not.toBe("accepted");expect(x.read().evidence).toBeNull();
  });
  it("contains errors and uses bounded lease recovery for at most three attempts",async()=>{
    const x=await fixture();x.deps.execute=vi.fn(async()=>{throw new Error("private database error");});
    for(let attempt=1;attempt<=3;attempt++){expect(await executeQuestionResult(x.deps,id,x.read().revision,"service")).toBe("unavailable");x.advance(900);expect(await recoverQuestionResult(x.deps,id,x.read().revision)).toBe("accepted");}
    expect(x.read().state).toBe("failed");expect(x.deps.execute).toHaveBeenCalledTimes(3);expect(await executeQuestionResult(x.deps,id,x.read().revision,"service")).toBe("conflict");
  });
  it("discovers IDs/revisions only and recovers a lease before re-execution",async()=>{
    const x=await fixture();x.deps.execute=async()=>{throw new Error("offline");};await executeQuestionResult(x.deps,id,2,"service");x.advance(900);
    const bind=vi.fn(()=>({all:async()=>({results:[{request_id:id}]})}));const db={prepare:vi.fn(()=>({bind}))};
    expect(await readQuestionResults({DB:db} as unknown as Env,10,x.deps)).toEqual([{request_id:id,revision:4}]);expect(x.read().state).toBe("building");expect(bind).toHaveBeenCalledExactlyOnceWith(10);
    x.advance(31*86400);expect(await readQuestionResults({DB:db} as unknown as Env,10,x.deps)).toEqual([]);expect(x.read().state).toBe("expired");
    await expect(readQuestionResults({DB:db} as unknown as Env,11,x.deps)).rejects.toThrow("invalid_result_limit");
  });
});
describe("budgeted request query adapter",()=>{
  it("uses cache without charging compute",async()=>{
    const x=await fixture();vi.mocked(readQueryCache).mockResolvedValue({outcome:"hit",result:{snapshot_id:snapshot,rows:x.response.rows,unit:"goals"}});
    const response=await executeRequestQuery(env,x.mapped.intent,x.mapped.spec);expect(response).toMatchObject({snapshot_id:snapshot,rows:x.response.rows});expect(enforceBudget).not.toHaveBeenCalled();expect(runQuery).not.toHaveBeenCalled();
  });
  it("charges once on cache miss with a fail-closed budget",async()=>{
    const x=await fixture();vi.mocked(runQuery).mockResolvedValue({snapshot_id:snapshot,rows:x.response.rows,unit:"goals"});await executeRequestQuery(env,x.mapped.intent,x.mapped.spec);
    expect(enforceBudget).toHaveBeenCalledExactlyOnceWith(env,expect.objectContaining({failClosed:true}));expect(runQuery).toHaveBeenCalledExactlyOnceWith(env,x.mapped.intent,snapshot);expect(writeQueryCache).toHaveBeenCalledTimes(1);
  });
  it.each(["over_limit","unavailable"] as const)("performs no query when budget is %s",async reason=>{
    const x=await fixture();vi.mocked(enforceBudget).mockImplementation(async(_env,options)=>{if(options?.denial)options.denial.reason=reason;return false;});
    await expect(executeRequestQuery(env,x.mapped.intent,x.mapped.spec)).rejects.toThrow(reason==="unavailable"?"budget_unavailable":"budget_exceeded");expect(runQuery).not.toHaveBeenCalled();expect(writeQueryCache).not.toHaveBeenCalled();
  });
  it("does not cache or release rows across a publication change",async()=>{
    const x=await fixture();vi.mocked(currentSnapshot).mockResolvedValueOnce(snapshot).mockResolvedValue("c".repeat(64));vi.mocked(runQuery).mockResolvedValue({snapshot_id:snapshot,rows:x.response.rows,unit:"goals"});
    await expect(executeRequestQuery(env,x.mapped.intent,x.mapped.spec)).rejects.toThrow("unavailable");expect(writeQueryCache).not.toHaveBeenCalled();
  });
  it("checks snapshot freshness on cache hits",async()=>{
    const x=await fixture();vi.mocked(readQueryCache).mockResolvedValue({outcome:"hit",result:{snapshot_id:snapshot,rows:x.response.rows,unit:"goals"}});vi.mocked(currentSnapshot).mockResolvedValueOnce(snapshot).mockResolvedValue("c".repeat(64));
    await expect(executeRequestQuery(env,x.mapped.intent,x.mapped.spec)).rejects.toThrow("unavailable");expect(enforceBudget).not.toHaveBeenCalled();
  });
});
