import {describe,expect,it,vi,beforeEach} from "vitest";
import {createQuestionTriageBridgeRouter} from "../worker/src/routes/question-triage-bridge";
import {TRIAGE_CAPABILITY} from "../worker/src/core/question-triage-bridge";
import {executeQuestionResult,readQuestionResults,requestExecutionDeps} from "../worker/src/core/question-request-execution";
vi.mock("../worker/src/core/question-request-execution",()=>({executeQuestionResult:vi.fn(),readQuestionResults:vi.fn(),requestExecutionDeps:vi.fn(()=>({server:"deps"}))}));
const id="a".repeat(64),caller={service:"service",capability:TRIAGE_CAPABILITY},env={DB:{prepare:vi.fn()}};
const router=()=>createQuestionTriageBridgeRouter(()=>caller);
const request=(kind:"execute"|"results",payload:unknown,version:unknown=1)=>new Request(`https://site.invalid/answer-now/${kind}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({version,kind,payload})});
beforeEach(()=>{vi.clearAllMocks();vi.mocked(executeQuestionResult).mockResolvedValue("accepted");vi.mocked(readQuestionResults).mockResolvedValue([{request_id:id,revision:2}]);});
describe("service-owned result execution routes",()=>{
  it("passes only ID/revision and server-derived service to the trusted executor",async()=>{
    const r=await router().fetch(request("execute",{request_id:id,revision:2}),env as never);expect(r.status).toBe(200);expect(await r.json()).toEqual({version:1,kind:"execute_result",payload:{request_id:id,outcome:"accepted"}});expect(executeQuestionResult).toHaveBeenCalledExactlyOnceWith({server:"deps"},id,2,"service");
  });
  it.each([{request_id:id,revision:2,evidence:{}},{request_id:id,revision:2,intent:{}},{request_id:id,revision:2,account_sub:"other"},{request_id:id,revision:0},{request_id:id,revision:1.5},{request_id:id+"\n",revision:2},{request_id:id,revision:"2"}])("refuses caller-provided context or malformed IDs/revisions",async payload=>{
    expect((await router().fetch(request("execute",payload),env as never)).status).toBe(400);expect(executeQuestionResult).not.toHaveBeenCalled();
  });
  it.each([null,{service:"service",capability:"other"}])("denies missing/wrong service capability before data access",async identity=>{
    const r=await createQuestionTriageBridgeRouter(()=>identity).fetch(request("execute",{request_id:id,revision:2}),env as never);expect(r.status).toBe(403);expect(requestExecutionDeps).not.toHaveBeenCalled();
  });
  it("bounds request streaming independently of content length",async()=>{
    const req=new Request("https://site.invalid/answer-now/execute",{method:"POST",body:"x".repeat(1025)});expect((await router().fetch(req,env as never)).status).toBe(413);expect(executeQuestionResult).not.toHaveBeenCalled();
  });
  it("returns only bounded result IDs/revisions",async()=>{
    const r=await router().fetch(request("results",{limit:10}),env as never);expect(await r.json()).toEqual({version:1,kind:"results_result",payload:{results:[{request_id:id,revision:2}]}});expect(readQuestionResults).toHaveBeenCalledExactlyOnceWith(env,10);
  });
  it.each([{limit:11},{limit:0},{limit:1.1},{limit:1,text:"question"}])("refuses malformed discovery limits",async payload=>{expect((await router().fetch(request("results",payload),env as never)).status).toBe(400);expect(readQuestionResults).not.toHaveBeenCalled();});
  it("does not expose execution errors and disallows GET",async()=>{
    vi.mocked(executeQuestionResult).mockRejectedValue(new Error("private content"));const r=await router().fetch(request("execute",{request_id:id,revision:2}),env as never);expect(r.status).toBe(503);expect(await r.text()).not.toContain("private content");
    expect((await router().request("https://site.invalid/answer-now/execute")).status).toBe(405);
  });
});
