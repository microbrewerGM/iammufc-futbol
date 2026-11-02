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
  it.each(["en","es"] as const)("puts native snapshot disclosure after result actions in %s",code=>{
    const html=questionResultPanel(code,{...view("released"),resultPath:requestResultPath(intent,code),executedSnapshotId:"snapshot_2026-11-02"});
    expect(html).toContain(code==="es"?"Procedencia de los datos":"Data provenance");
    expect(html).toContain(code==="es"?"Instantánea de datos del resultado":"Result data snapshot");
    expect(html).toContain("<details><summary>");expect(html.indexOf("</a>")).toBeLessThan(html.indexOf("<details>"));
    expect(html).not.toContain("tabindex=");expect(html).not.toContain("<script");
  });
  it("keeps stale retained provenance without a result link and wraps long IDs",()=>{
    const html=questionResultPanel("en",{...view("stale"),currentBinding:false,executedSnapshotId:"s".repeat(128)});
    expect(html).toContain("Data provenance");expect(html).not.toContain("<a href=");
    expect(html.match(/<wbr>/g)).toHaveLength(7);
  });
  it.each(["confirmation_required","building","in_review","clarification_required","failed","expired"] as const)("never labels %s proposals as executed",state=>{
    expect(questionResultPanel("en",{...view(state),executedSnapshotId:"snapshot"})).not.toContain("Data provenance");
  });
  it.each(["snapshot\n","snapshot\u0000","<img src=x>","/private","https://evil.test","x".repeat(129)])("refuses unsafe metadata %j",value=>{
    const html=questionResultPanel("en",{...view("released"),executedSnapshotId:value});
    expect(html).not.toContain("Data provenance");expect(html).not.toContain(value);
  });
});
