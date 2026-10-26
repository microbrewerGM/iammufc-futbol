import { describe, expect, it } from "vitest";
import { checkAdmissionEligibility, type AdmissionEvidence, type AdmissionPolicy } from "../worker/src/core/exploration-bridge-admit";

// Synthetic policy/proofs, unrelated to any live Access audience or credential.
const policy: AdmissionPolicy = {
  expectedAudience: "fixture-audience", requiredBatchCapability: "fixture:batch",
  allowedSources: ["fixture-source"], allowedIntents: ["arrival_manager:1"],
};
const proof = (): AdmissionEvidence => ({
  human: { subject: "fixture-human" },
  batch: { audience: "fixture-audience", capabilities: ["fixture:batch"] },
  source: "fixture-source", intent: "arrival_manager:1",
});

describe("human request admission policy eligibility", () => {
  it("passes only with separate human and scoped batch proofs", () => {
    expect(checkAdmissionEligibility(proof(), policy)).toEqual({ eligible: true });
  });
  it("owner identity alone never passes", () => {
    expect(checkAdmissionEligibility({ ...proof(), batch: null }, policy))
      .toEqual({ eligible: false, reason: "audience_denied" });
  });
  it.each([null, { subject: "" }])("requires a human request origin: %j", human => {
    expect(checkAdmissionEligibility({ ...proof(), human }, policy))
      .toEqual({ eligible: false, reason: "human_required" });
  });
  it.each(["", "other-audience", "fixture-audience ", "fixture-audience.evil"])("denies audience %j", audience => {
    const p = proof(); p.batch!.audience = audience;
    expect(checkAdmissionEligibility(p, policy)).toEqual({ eligible: false, reason: "audience_denied" });
  });
  it.each([[], ["other:batch"], ["fixture:batch:extra"], ["FIXTURE:batch"]].map(capabilities => ({ capabilities })))("denies capabilities $capabilities", ({ capabilities }) => {
    const p = proof(); p.batch!.capabilities = capabilities;
    expect(checkAdmissionEligibility(p, policy)).toEqual({ eligible: false, reason: "batch_capability_denied" });
  });
  it.each(["", "other-source", "fixture-source.evil", "FIXTURE-SOURCE"])("denies source %j", source => {
    expect(checkAdmissionEligibility({ ...proof(), source }, policy)).toEqual({ eligible: false, reason: "source_denied" });
  });
  it.each(["", "goals", "arrival_manager:10", "ARRIVAL_MANAGER:1"])("denies intent %j", intent => {
    expect(checkAdmissionEligibility({ ...proof(), intent }, policy)).toEqual({ eligible: false, reason: "intent_denied" });
  });
  it.each([
    { expectedAudience: "" }, { requiredBatchCapability: "" },
    { allowedSources: [] }, { allowedIntents: [] }, { allowedSources: [""] },
  ])("denies incomplete server policy %j", patch => {
    expect(checkAdmissionEligibility(proof(), { ...policy, ...patch }))
      .toEqual({ eligible: false, reason: "invalid_policy" });
  });
  it("returns a decision without mutating evidence or policy", () => {
    const p = proof(); Object.freeze(p.human); Object.freeze(p.batch!.capabilities);
    Object.freeze(p.batch); Object.freeze(p); Object.freeze(policy.allowedSources);
    Object.freeze(policy.allowedIntents); Object.freeze(policy);
    expect(checkAdmissionEligibility(p, policy)).toEqual({ eligible: true });
    expect(Object.keys(checkAdmissionEligibility(p, policy))).toEqual(["eligible"]);
  });
});
