import {describe,it,expect} from "vitest";
import {Hono} from "hono";
import {createQuestionTriageBridgeRouter,type QuestionTriageEnv} from "../worker/src/routes/question-triage-bridge";
import {TRIAGE_CAPABILITY} from "../worker/src/core/question-triage-bridge";
const operations=["read","prepare","check","bind","ack"] as const;
describe("notification HTTP boundary",()=>{
  it("denies absent and human callers before any database read",async()=>{
    for(const caller of [null,{service:"human",capability:"human"}]){
      const app=new Hono<QuestionTriageEnv>();app.route("/",createQuestionTriageBridgeRouter(()=>caller));
      for(const kind of operations){const response=await app.request("https://site.invalid/answer-now/notifications/"+kind,{method:"POST",body:"{}"},{} as never);expect(response.status).toBe(403);}
    }
  });
  it("accepts POST only and bounds malformed, oversized and foreign-kind envelopes",async()=>{
    const app=new Hono<QuestionTriageEnv>();app.route("/",createQuestionTriageBridgeRouter(()=>({service:"notify",capability:TRIAGE_CAPABILITY})));
    for(const kind of operations){
      const path="https://site.invalid/answer-now/notifications/"+kind;
      expect((await app.request(path,{method:"GET"},{} as never)).status).toBe(405);
      expect((await app.request(path,{method:"POST",body:"bad"},{} as never)).status).toBe(400);
      expect((await app.request(path,{method:"POST",body:"x".repeat(8193)},{} as never)).status).toBe(413);
      expect((await app.request(path,{method:"POST",body:JSON.stringify({version:1,kind:"ack",payload:{}})},{} as never)).status).toBe(400);
    }
  });
});
