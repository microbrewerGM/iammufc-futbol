import { verifyQuestionResult, type RequestAcceptanceSpec } from "./question-request-intent";

export type ResultState = "confirmation_required" | "building" | "in_review" | "released" | "failed" | "expired";
export interface QuestionResult {
  requestId: string; accountSub: string; requestRevision: number; revision: number;
  state: ResultState; spec: RequestAcceptanceSpec; attempt: number;
  leaseId: string | null; leaseOwner: string | null; leaseExpiresAt: string | null;
  evidence: { artifact_key: string; snapshot_id: string; entity_id: string; value: number; attribution: string; verified_at: string } | null;
  createdAt: string; updatedAt: string; responseDeadline: string; expiresAt: string;
}
export interface ResultStore {
  get(requestId: string): Promise<QuestionResult | null>;
  /** Atomically match the full expected revision AND parent generation. For
   * insert, confirmation, claim and release, also match the current snapshot to
   * next.spec. Recovery to expired/failed may close a stale snapshot's work.
   * At write time enforce parent retention, and, on confirmation/release, the
   * response deadline/live lease respectively using the authoritative DB clock.
   * A store that checks only the sidecar revision does not satisfy this port.
   */
  compareAndSet(before: QuestionResult | null, next: QuestionResult): Promise<boolean>;
}
export interface ResultDeps {
  store: ResultStore; now(): Date; newLeaseId(): string;
  /** Read these from authoritative storage after execution, not from its response. */
  currentBinding(requestId: string): Promise<{ revision: number; snapshotId: string | null }>;
}
export type ResultTransition = "accepted" | "conflict" | "not_found" | "invalid_result";
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9:_-]{0,95}$/;
const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
function clock(deps: ResultDeps): number { const n = deps.now().getTime(); if (!Number.isFinite(n)) throw new Error("invalid_clock"); return Math.floor(n / 1000) * 1000; }
function live(row: QuestionResult, now: number): boolean { return Date.parse(row.expiresAt) > now; }
function next(row: QuestionResult, now: number, change: Partial<QuestionResult>): QuestionResult { if (now < Date.parse(row.updatedAt)) throw new Error("invalid_clock"); return { ...row, ...change, revision: row.revision + 1, updatedAt: stamp(now) }; }
async function save(deps: ResultDeps, row: QuestionResult, updated: QuestionResult): Promise<ResultTransition> { return await deps.store.compareAndSet(row, updated) ? "accepted" : "conflict"; }

/** Only call with the server-produced mapper spec after the parent triage ack settles. */
export async function proposeQuestionResult(deps: ResultDeps, accountSub: string, spec: RequestAcceptanceSpec, parentExpiresAt: string): Promise<ResultTransition> {
  const now = clock(deps), expires = Date.parse(parentExpiresAt);
  if (!accountSub.trim() || accountSub.length > 512 || !HASH.test(spec.request_id) || !Number.isSafeInteger(spec.request_revision) || spec.request_revision < 1 || !Number.isFinite(expires) || expires <= now || stamp(expires) !== parentExpiresAt) return "conflict";
  const binding = await deps.currentBinding(spec.request_id);
  if (binding.revision !== spec.request_revision || binding.snapshotId !== spec.data_snapshot_id) return "conflict";
  const row: QuestionResult = { requestId: spec.request_id, accountSub, requestRevision: spec.request_revision, revision: 1, state: "confirmation_required", spec, attempt: 0, leaseId: null, leaseOwner: null, leaseExpiresAt: null, evidence: null, createdAt: stamp(now), updatedAt: stamp(now), responseDeadline: stamp(Math.min(now + 86400_000, expires)), expiresAt: parentExpiresAt };
  return await deps.store.compareAndSet(null, row) ? "accepted" : "conflict";
}

export async function confirmQuestionResult(deps: ResultDeps, requestId: string, revision: number, accountSub: string): Promise<ResultTransition> {
  const row = await deps.store.get(requestId), now = clock(deps);
  if (!row || row.accountSub !== accountSub) return "not_found";
  if (row.revision !== revision || row.state !== "confirmation_required" || !live(row, now) || Date.parse(row.responseDeadline) <= now) return "conflict";
  const binding = await deps.currentBinding(requestId);
  if (binding.revision !== row.requestRevision || binding.snapshotId !== row.spec.data_snapshot_id) return "conflict";
  const finished = clock(deps);
  if (!live(row, finished) || Date.parse(row.responseDeadline) <= finished) return "conflict";
  return save(deps, row, next(row, finished, { state: "building" }));
}

export async function claimQuestionResult(deps: ResultDeps, requestId: string, revision: number, service: string): Promise<ResultTransition> {
  const row = await deps.store.get(requestId), now = clock(deps);
  if (!row) return "not_found";
  // Expired work must pass through recoverQuestionResult first, matching the
  // durable schema's in_review -> building -> in_review transition sequence.
  if (!ID.test(service) || row.revision !== revision || !live(row, now) || row.attempt >= 3 || row.state !== "building") return "conflict";
  const lease = deps.newLeaseId();
  if (!ID.test(lease) || lease === row.leaseId) throw new Error("invalid_lease_id");
  return save(deps, row, next(row, now, { state: "in_review", attempt: row.attempt + 1, leaseId: lease, leaseOwner: service, leaseExpiresAt: stamp(Math.min(now + 900_000, Date.parse(row.expiresAt))) }));
}

/** Only the service that owns the still-live lease may complete trusted execution. */
export async function completeQuestionResult(deps: ResultDeps, requestId: string, revision: number, service: string, leaseId: string, response: unknown): Promise<ResultTransition> {
  // The caller's object must not change between verification and evidence copy.
  let execution: unknown;
  try { execution = structuredClone(response); } catch { return "invalid_result"; }
  const row = await deps.store.get(requestId), now = clock(deps);
  if (!row) return "not_found";
  if (row.revision !== revision || row.state !== "in_review" || row.leaseOwner !== service || row.leaseId !== leaseId || row.leaseExpiresAt === null || Date.parse(row.leaseExpiresAt) <= now || !live(row, now)) return "conflict";
  const binding = await deps.currentBinding(requestId);
  const verified = await verifyQuestionResult(row.spec, execution, { requestId, revision: binding.revision, snapshotId: binding.snapshotId });
  if (!verified) return "invalid_result";
  // Re-read the time and storage binding after asynchronous verification. A stale
  // snapshot/generation never becomes a fresh release merely by passing earlier.
  const fresh = await deps.currentBinding(requestId), finished = clock(deps);
  if (fresh.revision !== binding.revision || fresh.snapshotId !== binding.snapshotId || finished >= Date.parse(row.leaseExpiresAt) || !live(row, finished)) return "conflict";
  const executed = execution as { rows: { value: number }[]; attribution: string[] };
  return save(deps, row, next(row, finished, { state: "released", leaseExpiresAt: null, evidence: { artifact_key: row.spec.artifact_key, snapshot_id: row.spec.data_snapshot_id, entity_id: JSON.parse(row.spec.canonical_intent).entity_id, value: executed.rows[0]!.value, attribution: executed.attribution[0]!, verified_at: stamp(finished) } }));
}

/** Bounded recovery: expired execution is retried at most three times. */
export async function recoverQuestionResult(deps: ResultDeps, requestId: string, revision: number): Promise<ResultTransition> {
  const row = await deps.store.get(requestId), now = clock(deps);
  if (!row) return "not_found";
  if (row.revision !== revision || row.state === "released" || row.state === "failed" || row.state === "expired") return "conflict";
  if (!live(row, now) || row.state === "confirmation_required" && Date.parse(row.responseDeadline) <= now) return save(deps, row, next(row, now, { state: "expired", leaseExpiresAt: null }));
  if (row.state !== "in_review" || row.leaseExpiresAt === null || Date.parse(row.leaseExpiresAt) > now) return "conflict";
  return save(deps, row, next(row, now, { state: row.attempt >= 3 ? "failed" : "building", leaseExpiresAt: null }));
}
