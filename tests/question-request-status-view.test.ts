import { describe, expect, it } from "vitest";
import { questionResultPanel, questionRequestPage, type QuestionResultView } from "../worker/src/views/question-requests";
import { withDefaults } from "../worker/src/core/intent";
import { requestResultPath } from "../worker/src/core/question-request-intent";
const intent = withDefaults({ metric: "goals", entity_type: "player", entity_id: "fpl:code:1", season: "2024-25", competition: "PL", viz: "bar", limit: 1 });
const view = (state: QuestionResultView["state"]): QuestionResultView => ({ requestId: "a".repeat(64), revision: 2, state, intent, personLabel: "Player", currentBinding: true, resultPath: requestResultPath(intent,"en") });
describe("request result status views",()=>{
  it.each(["en","es"] as const)("renders labeled revision-bound clarification and confirmation in %s", code=>{
    const clarify=questionResultPanel(code,view("clarification_required"));
    expect(clarify).toContain(`/${code}/requests/${"a".repeat(64)}/clarify`);
    expect(clarify).toContain('name="expected_revision" value="2"');
    expect(clarify).toContain('label for="clarified-question"');
    const confirm=questionResultPanel(code,view("confirmation_required"));
    expect(confirm).toContain(`/${code}/requests/${"a".repeat(64)}/confirm`);
    expect(confirm).toContain(code==="es"?"Confirmar selección":"Confirm selection");
    expect(confirm).toContain("Player");
  });
  it.each(["en","es"] as const)("offers only a current localized released result in %s",code=>{
    const html=questionResultPanel(code,{...view("released"),resultPath:requestResultPath(intent,code)});
    expect(html).toContain(code==="es"?"Ver resultado":"View result");
    expect(html).toContain(`/${code}/q?metric=goals`);
  });
  it("never offers unverified, stale, external or mismatched result links",()=>{
    for(const state of ["building","in_review","failed","expired","stale","unsupported","unavailable"] as const) expect(questionResultPanel("en",view(state))).not.toContain('<a href=');
    for(const change of [{currentBinding:false},{resultPath:"https://evil.test"},{resultPath:requestResultPath({...intent,season:"2023-24"},"en")},{resultPath:requestResultPath(intent,"es")}]) expect(questionResultPanel("en",{...view("released"),...change})).not.toContain('<a href=');
  });
  it("requires an explicit current interpretation before confirmation",()=>{
    for(const change of [{currentBinding:false},{personLabel:undefined},{intent:undefined}]) expect(questionResultPanel("en",{...view("confirmation_required"),...change})).not.toContain('/confirm"');
  });
  it("escapes identity labels and refuses invalid identifiers",()=>{
    expect(questionResultPanel("en",{...view("confirmation_required"),personLabel:'<img src=x onerror="x">'})).toContain("&lt;img");
    expect(questionResultPanel("en",{...view("released"),requestId:'"><script>'})).toBe("");
    expect(questionResultPanel("en",{...view("released"),requestId:"a".repeat(64)+"\n"})).toBe("");
    expect(questionResultPanel("en",{...view("released"),revision:NaN})).toBe("");
  });
  it("keeps the existing intake page API compatible",()=>{
    expect(questionRequestPage("en","received")).toContain("Received");
    expect(questionRequestPage("es","triaging",undefined,view("building"))).toContain("Preparando tu resultado");
  });
  it("preserves the request when switching between EN and ES",()=>{
    const result=view("confirmation_required");
    expect(questionRequestPage("en","filled",undefined,result)).toContain(`/es/requests?id=${result.requestId}`);
    expect(questionRequestPage("es","filled",undefined,result)).toContain(`/en/requests?id=${result.requestId}`);
  });
});
