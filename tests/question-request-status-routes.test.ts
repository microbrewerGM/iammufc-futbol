import { describe,expect,it,vi,beforeEach } from "vitest";
import { Hono } from "hono";
import { accessGate,type AccessIdentity } from "../worker/src/security/auth";
import { createQuestionRequestsRouter,type RouteEnv } from "../worker/src/routes/question-requests";
import { readQuestionResultStatus,questionResultDeps } from "../worker/src/core/question-request-status";
import { confirmQuestionResult } from "../worker/src/core/question-request-results";
vi.mock("../worker/src/core/question-request-status",()=>({readQuestionResultStatus:vi.fn(),questionResultDeps:vi.fn(()=>({marker:"serverdeps"}))}));
vi.mock("../worker/src/core/question-request-results",()=>({confirmQuestionResult:vi.fn()}));
const id="a".repeat(64), headers={"cf-access-jwt-assertion":"test","origin":"https://site.invalid","content-type":"application/x-www-form-urlencoded"};
const env={ACCESS_ISSUER:"https://example.cloudflareaccess.com",ACCESS_AUD:"a".repeat(64),ACCESS_OWNER_EMAILS:"owner@example.invalid",ACCESS_SERVICE_CLIENT_IDS:"service",DB:{prepare:vi.fn(()=>({bind:()=>({first:async()=>({status:"filled"})})}))}};
function app(identity:AccessIdentity={sub:"owner",email:"owner@example.invalid"}) {const a=new Hono<RouteEnv>();a.use("*",accessGate(async()=>identity));a.route("/",createQuestionRequestsRouter());return a;}
const post=(body="expected_revision=3",extra:Record<string,string>={})=>app().request(`https://site.invalid/es/requests/${id}/confirm`,{method:"POST",headers:{...headers,...extra},body},env as never);
beforeEach(()=>{vi.clearAllMocks();vi.mocked(readQuestionResultStatus).mockResolvedValue({requestId:id,revision:3,state:"confirmation_required",currentBinding:true});vi.mocked(confirmQuestionResult).mockResolvedValue("accepted");});
describe("request confirmation endpoint",()=>{
  it("confirms the owned current revision and redirects to localized status",async()=>{
    const r=await post();expect(r.status).toBe(303);expect(r.headers.get("location")).toBe(`/es/requests?id=${id}`);
    expect(readQuestionResultStatus).toHaveBeenCalledWith(expect.anything(),"owner",id,"es");expect(confirmQuestionResult).toHaveBeenCalledWith({marker:"serverdeps"},id,3,"owner");
  });
  it.each(["expected_revision=3&expected_revision=3","expected_revision=3&text=ignored","expected_revision=03","expected_revision=3%0A","expected_revision=0","expected_revision=-1","expected_revision=9007199254740992","unexpected=3"])("refuses malformed/extra form fields: %s",async body=>{
    expect((await post(body)).status).toBe(400);expect(readQuestionResultStatus).not.toHaveBeenCalled();expect(confirmQuestionResult).not.toHaveBeenCalled();
  });
  it("bounds streaming input and declared length",async()=>{
    expect((await post("x".repeat(129))).status).toBe(413);expect((await post("expected_revision=3",{"content-length":"129"})).status).toBe(413);expect(readQuestionResultStatus).not.toHaveBeenCalled();
  });
  it.each(["https://other.invalid",""])("requires same-origin browser submission: %s",async origin=>{expect((await post(undefined,{origin})).status).toBe(403);expect(confirmQuestionResult).not.toHaveBeenCalled();});
  it("refuses service identities even when they include a subject",async()=>{
    const r=await app({sub:"owner",serviceClientId:"service"} as unknown as AccessIdentity).request(`https://site.invalid/en/requests/${id}/confirm`,{method:"POST",headers,body:"expected_revision=3"},env as never);expect(r.status).toBe(403);expect(questionResultDeps).not.toHaveBeenCalled();
  });
  it("does not confirm cross-account or stale proposals",async()=>{
    vi.mocked(readQuestionResultStatus).mockResolvedValue(undefined);expect((await post()).status).toBe(404);
    vi.mocked(readQuestionResultStatus).mockResolvedValue({requestId:id,revision:3,state:"stale",currentBinding:false});expect((await post()).status).toBe(409);expect(confirmQuestionResult).not.toHaveBeenCalled();
  });
  it("reports a lost SQL race without claiming confirmation",async()=>{vi.mocked(confirmQuestionResult).mockResolvedValue("conflict");expect((await post()).status).toBe(409);});
  it("does not leak storage errors or raw questions",async()=>{vi.mocked(readQuestionResultStatus).mockRejectedValue(new Error("private text"));const r=await post();expect(r.status).toBe(503);expect(await r.text()).not.toContain("private text");});
  it("shows clarification status without activating a missing handler",async()=>{
    vi.mocked(readQuestionResultStatus).mockResolvedValue({requestId:id,revision:3,state:"clarification_required",clarificationAvailable:false});
    const r=await app().request(`https://site.invalid/en/requests?id=${id}`,{headers},env as never);const html=await r.text();expect(r.status).toBe(200);expect(html).toContain("Please clarify");expect(html).not.toContain(`/requests/${id}/clarify`);
  });
});
