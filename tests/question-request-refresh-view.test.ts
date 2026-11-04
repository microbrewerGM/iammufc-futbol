import { describe, expect, it } from "vitest";
import { questionResultPanel, type QuestionResultView } from "../worker/src/views/question-requests";
import { withDefaults } from "../worker/src/core/intent";

const id="a".repeat(64);
const view:QuestionResultView={requestId:id,revision:3,state:"stale",currentBinding:false,refreshStatus:"available"};
describe("request refresh and confirmation-history views",()=>{
  it.each(["en","es"] as const)("offers a native revision-only refresh form in %s",locale=>{
    const html=questionResultPanel(locale,view);
    expect(html).toContain(`<form method="post" action="/${locale}/requests/${id}/refresh">`);
    expect(html).toContain('name="expected_revision" value="3"');expect(html).toContain('<button type="submit">');
    expect(html).toContain(locale==="es"?"confírmala por separado":"confirm it separately");
    expect(html).not.toContain("/confirm");expect(html).not.toContain("<script");expect(html).not.toContain("tabindex=");
  });
  it.each(["pending","expired","exhausted","unavailable","current"] as const)("shows %s without a refresh action",refreshStatus=>{
    for(const locale of ["en","es"] as const){const html=questionResultPanel(locale,{...view,refreshStatus});expect(html).toContain('role="status"');expect(html).not.toContain("/refresh");}
  });
  it("suppresses confirmation until complete readiness",()=>{
    const result:QuestionResultView={...view,state:"confirmation_required",currentBinding:true,confirmationAvailable:false,refreshStatus:"unavailable",personLabel:"Player",intent:withDefaults({metric:"goals",entity_type:"player",entity_id:"fpl:code:1",season:"2024-25",competition:"PL",viz:"bar",limit:1})};
    expect(questionResultPanel("en",result)).not.toContain("/confirm");
  });
  it.each(["en","es"] as const)("keeps bounded, escaped confirmation history distinct from execution in %s",locale=>{
    const confirmationHistory=Array.from({length:9},(_,i)=>({revision:i+1,snapshotId:'<img src=x onerror="x">'+"s".repeat(80),acceptedAt:"2026-11-04T00:00:00Z"}));
    const html=questionResultPanel(locale,{...view,confirmationHistory});
    expect(html).toContain(locale==="es"?"no resultados ejecutados":"not executed results");
    expect(html.match(/<li>/g)).toHaveLength(7);expect(html).toContain("&lt;img");expect(html).toContain("<wbr>");
    expect(html).not.toContain("<img");expect(html).not.toContain("<a href=");expect(html).not.toContain("Data provenance");
    expect(html).toContain("<details><summary>");
  });
  it("rejects malformed identifiers, revisions and history timestamps",()=>{
    expect(questionResultPanel("en",{...view,requestId:'"><script>'})).toBe("");
    expect(questionResultPanel("en",{...view,revision:Infinity})).toBe("");
    const html=questionResultPanel("en",{...view,confirmationHistory:[{revision:1,snapshotId:"snapshot",acceptedAt:'"><script>'}]});
    expect(html).not.toContain("Confirmation history");expect(html).not.toContain("<script");
  });
});
