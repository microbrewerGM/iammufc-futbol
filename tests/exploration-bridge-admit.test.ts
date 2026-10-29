import { describe, expect, it } from "vitest";
import { checkAdmissionEligibility, type AdmissionEvidence, type AdmissionPolicy } from "../worker/src/core/exploration-bridge-admit";

// Synthetic policy/proofs, unrelated to any live Access audience or credential.
const policy: AdmissionPolicy = Object.freeze({
  expectedAudience: "fixture-audience", requiredBatchCapability: "fixture:batch",
  allowedSources: Object.freeze(["fixture-source"]), allowedIntents: Object.freeze(["arrival_manager:1"]),
});
const proof = (): AdmissionEvidence => ({
  human: { type: "human", subject: "fixture-human" },
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
  it("rejects inherited admission fields from a __proto__ JSON payload", () => {
    const payload = JSON.parse('{"__proto__":{"source":"fixture-source","intent":"arrival_manager:1"}}');
    const value = Object.assign({
      human: { type: "human", subject: "fixture-human" },
      batch: { audience: "fixture-audience", capabilities: ["fixture:batch"] },
    }, payload);
    Object.setPrototypeOf(value, payload.__proto__);
    expect(checkAdmissionEligibility(value as AdmissionEvidence, policy))
      .toEqual({ eligible: false, reason: "source_denied" });
  });
  it("rejects service-token identities even when they carry a subject", () => {
    expect(checkAdmissionEligibility({ ...proof(), human: { type: "service-token", subject: "fixture-human" } }, policy))
      .toEqual({ eligible: false, reason: "human_required" });
  });
  it.each<AdmissionEvidence["human"]>([null, { type: "human", subject: "" }])("requires a human request origin: %j", human => {
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
    { field: "source", value: "x".repeat(257), reason: "source_denied" },
    { field: "source", value: "   ", reason: "source_denied" },
    { field: "source", value: " fixture-source", reason: "source_denied" },
    { field: "intent", value: "x".repeat(257), reason: "intent_denied" },
    { field: "intent", value: "   ", reason: "intent_denied" },
    { field: "intent", value: " arrival_manager:1", reason: "intent_denied" },
    { field: "audience", value: "x".repeat(257), reason: "audience_denied" },
    { field: "audience", value: "   ", reason: "audience_denied" },
    { field: "audience", value: " fixture-audience", reason: "audience_denied" },
    { field: "capability", value: "x".repeat(257), reason: "batch_capability_denied" },
    { field: "capability", value: "   ", reason: "batch_capability_denied" },
    { field: "capability", value: " fixture:batch", reason: "batch_capability_denied" },
  ] as const)("rejects invalid evidence $field string $value", ({ field, value, reason }) => {
    const p = proof();
    if (field === "source") p.source = value;
    if (field === "intent") p.intent = value;
    if (field === "audience") p.batch!.audience = value;
    if (field === "capability") p.batch!.capabilities = [value];
    expect(checkAdmissionEligibility(p, policy)).toEqual({ eligible: false, reason });
  });
  it.each([
    { expectedAudience: "" }, { requiredBatchCapability: "" },
    { allowedSources: [] }, { allowedIntents: [] }, { allowedSources: [""] },
    { expectedAudience: "x".repeat(257) }, { expectedAudience: "   " }, { expectedAudience: " fixture-audience" },
    { requiredBatchCapability: "x".repeat(257) }, { requiredBatchCapability: "   " }, { requiredBatchCapability: " fixture:batch" },
    { allowedSources: ["x".repeat(257)] }, { allowedSources: ["   "] }, { allowedSources: [" fixture-source"] },
    { allowedIntents: ["x".repeat(257)] }, { allowedIntents: ["   "] }, { allowedIntents: [" arrival_manager:1"] },
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
    expect(() => { (policy as { expectedAudience: string }).expectedAudience = "other"; }).toThrow();
  });
  it("denies a throwing evidence getter using that field's reason", () => {
    const p = proof();
    Object.defineProperty(p, "source", { get() { throw new Error("boom"); } });
    expect(checkAdmissionEligibility(p, policy)).toEqual({ eligible: false, reason: "source_denied" });
  });
  it("reads a changing evidence getter once and rejects the accessor", () => {
    const p = proof();
    let reads = 0;
    Object.defineProperty(p, "source", { get() { reads++; return reads === 1 ? "fixture-source" : "other-source"; } });
    expect(checkAdmissionEligibility(p, policy)).toEqual({ eligible: false, reason: "source_denied" });
    expect(reads).toBe(0);
  });
  it("snapshots mutable policy fields and arrays before checking", () => {
    const mutable = {
      expectedAudience: "fixture-audience", requiredBatchCapability: "fixture:batch",
      allowedSources: ["fixture-source"], allowedIntents: ["arrival_manager:1"],
    };
    const evidence = proof();
    const result = checkAdmissionEligibility(evidence, mutable);
    mutable.expectedAudience = "changed";
    mutable.allowedSources[0] = "changed";
    expect(result).toEqual({ eligible: true });
  });
  it("rejects policy accessors that could change between validation and use", () => {
    let reads = 0;
    const mutable: AdmissionPolicy = {
      expectedAudience: "fixture-audience", requiredBatchCapability: "fixture:batch",
      get allowedSources() {
        reads++;
        return reads === 1 ? ["fixture-source"] : ["changed"];
      },
      allowedIntents: ["arrival_manager:1"],
    };
    expect(checkAdmissionEligibility(proof(), mutable)).toEqual({ eligible: false, reason: "invalid_policy" });
    expect(reads).toBe(0);
  });
});
