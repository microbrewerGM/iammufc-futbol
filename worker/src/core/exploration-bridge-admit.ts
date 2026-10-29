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

const text = (v: unknown): v is string => typeof v === "string" && v.length > 0
  && v.length <= 256 && v.trim() === v;
const list = (v: unknown): v is readonly string[] => Array.isArray(v)
  && v.length > 0 && v.length <= 64 && (() => {
    for (let index = 0; index < v.length; index++) if (!text(v[index])) return false;
    return true;
  })();
const deny = (reason: AdmissionDenial): AdmissionEligibility => ({ eligible: false, reason });

/** Read an own data property once. Accessors are rejected without invoking them. */
function readOwnData(object: unknown, key: string): unknown {
  if (object === null || typeof object !== "object") throw new TypeError("expected object");
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set) {
    throw new TypeError("expected own data property");
  }
  return descriptor.value;
}

function snapshotList(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const length = readOwnData(value, "length");
  if (!Number.isInteger(length) || (length as number) < 1 || (length as number) > 64) {
    throw new TypeError("invalid list length");
  }
  const copy: unknown[] = [];
  for (let index = 0; index < (length as number); index++) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set) {
      throw new TypeError("expected own data property");
    }
    if (Array.isArray(value)) {
      const actual = Reflect.getOwnPropertyDescriptor(value, key);
      if (!actual || !("value" in actual) || !Object.is(descriptor.value, actual.value)
        || descriptor.enumerable !== actual.enumerable || descriptor.configurable !== actual.configurable
        || descriptor.writable !== actual.writable) throw new TypeError("unstable list item");
    }
    copy.push(descriptor.value);
  }
  return Object.freeze(copy);
}

export function checkAdmissionEligibility(
  evidence: AdmissionEvidence, policy: AdmissionPolicy,
): AdmissionEligibility {
  let p: { expectedAudience: unknown; requiredBatchCapability: unknown; allowedSources: unknown; allowedIntents: unknown };
  try {
    p = Object.freeze({
      expectedAudience: readOwnData(policy, "expectedAudience"),
      requiredBatchCapability: readOwnData(policy, "requiredBatchCapability"),
      allowedSources: snapshotList(readOwnData(policy, "allowedSources")),
      allowedIntents: snapshotList(readOwnData(policy, "allowedIntents")),
    });
  } catch {
    return deny("invalid_policy");
  }
  if (!text(p.expectedAudience) || !text(p.requiredBatchCapability)
    || !list(p.allowedSources) || !list(p.allowedIntents)) return deny("invalid_policy");

  let e: { human: unknown; batch: unknown; source: unknown; intent: unknown };
  let human: { type: unknown; subject: unknown } | null;
  let batch: { audience: unknown; capabilities: unknown } | null;
  let evidenceFailure: AdmissionDenial = "human_required";
  try {
    const humanValue = readOwnData(evidence, "human");
    evidenceFailure = "audience_denied";
    const batchValue = readOwnData(evidence, "batch");
    evidenceFailure = "source_denied";
    const source = readOwnData(evidence, "source");
    evidenceFailure = "intent_denied";
    const intent = readOwnData(evidence, "intent");
    e = {
      human: humanValue,
      batch: batchValue,
      source,
      intent,
    };
    evidenceFailure = "human_required";
    human = humanValue === null ? null : {
      type: readOwnData(humanValue, "type"), subject: readOwnData(humanValue, "subject"),
    };
    evidenceFailure = "audience_denied";
    if (batchValue === null) batch = null;
    else {
      const audience = readOwnData(batchValue, "audience");
      evidenceFailure = "batch_capability_denied";
      batch = { audience, capabilities: snapshotList(readOwnData(batchValue, "capabilities")) };
    }
  } catch {
    return deny(evidenceFailure);
  }

  if (!human || human.type !== "human" || !text(human.subject)) return deny("human_required");
  if (!batch || !text(batch.audience) || batch.audience !== p.expectedAudience) return deny("audience_denied");
  if (!list(batch.capabilities) || !batch.capabilities.includes(p.requiredBatchCapability as string)) {
    return deny("batch_capability_denied");
  }
  if (!text(e.source) || !(p.allowedSources as readonly string[]).includes(e.source)) return deny("source_denied");
  if (!text(e.intent) || !(p.allowedIntents as readonly string[]).includes(e.intent)) return deny("intent_denied");
  return { eligible: true };
}
