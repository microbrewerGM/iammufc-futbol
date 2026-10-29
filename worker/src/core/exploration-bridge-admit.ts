/** Pure human-request eligibility check. All proofs and policy are server-owned
 * inputs established outside this module, never JSON claims from a requester.
 * The batch proof describes the separately verified execution channel; a human
 * identity cannot substitute for it or use machine read/claim/ack endpoints.
 * A pass creates no job and grants no retrieval permission. Dedup, budget,
 * source-field eligibility, coverage and atomic persistence remain separate gates.
 * No route currently calls this helper.
 */
export interface AdmissionPolicy {
  expectedAudience: string;
  requiredBatchCapability: string;
  allowedSources: readonly string[];
  allowedIntents: readonly string[];
}
export interface AdmissionEvidence {
  human: { type: "human"; subject: string } | { type: "service-token"; subject: string } | null;
  batch: { audience: string; capabilities: readonly string[] } | null;
  source: string;
  intent: string;
}
export type AdmissionDenial = "invalid_policy" | "human_required" | "audience_denied"
  | "batch_capability_denied" | "source_denied" | "intent_denied";
export type AdmissionEligibility = { eligible: true }
  | { eligible: false; reason: AdmissionDenial };

const owns = (value: object, key: PropertyKey): boolean => Object.hasOwn(value, key);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0
  && v.length <= 256 && v.trim() === v;
const list = (v: unknown): v is readonly string[] => Array.isArray(v)
  && v.length > 0 && v.length <= 64 && v.every(text);
const deny = (reason: AdmissionDenial): AdmissionEligibility => ({ eligible: false, reason });

export function checkAdmissionEligibility(
  evidence: AdmissionEvidence, policy: AdmissionPolicy,
): AdmissionEligibility {
  if (!policy || !owns(policy, "expectedAudience") || !owns(policy, "requiredBatchCapability")
    || !owns(policy, "allowedSources") || !owns(policy, "allowedIntents")
    || !text(policy.expectedAudience) || !text(policy.requiredBatchCapability)
    || !list(policy.allowedSources) || !list(policy.allowedIntents)) return deny("invalid_policy");
  if (!evidence?.human || !owns(evidence, "human") || !owns(evidence.human, "type") || evidence.human.type !== "human"
    || !owns(evidence.human, "subject") || !text(evidence.human.subject)) return deny("human_required");
  if (!evidence.batch || !owns(evidence, "batch") || !owns(evidence.batch, "audience") || !text(evidence.batch.audience)
    || evidence.batch.audience !== policy.expectedAudience) return deny("audience_denied");
  if (!owns(evidence.batch, "capabilities") || !list(evidence.batch.capabilities)
    || !evidence.batch.capabilities.includes(policy.requiredBatchCapability)) return deny("batch_capability_denied");
  if (!owns(evidence, "source") || !owns(evidence, "intent")
    || !text(evidence.source) || !policy.allowedSources.includes(evidence.source)) return deny("source_denied");
  if (!text(evidence.intent) || !policy.allowedIntents.includes(evidence.intent)) return deny("intent_denied");
  return { eligible: true };
}
