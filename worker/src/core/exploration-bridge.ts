/** Deterministic arrival-manager job bridge (B15-BRIDGE-CORE, frozen contract
 * arrival-manager-v1). Pure state transitions behind an injected `BridgeStore`.
 * Authentication, routing and the D1 adapter live elsewhere. This module never
 * admits a job, fetches a source or reads account/history data: it only moves
 * jobs the store already holds. Jobs are projected to the closed contract shape.
 */
export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const MAX_ATTEMPTS = 3;
export const LEASE_SECONDS = 900;
export const RETRY_SECONDS: Readonly<Record<number, number>> = { 1: 300, 2: 1800 };

export type JobStatus = "queued" | "running" | "failed" | "published";
export type FailureReason = "source_unavailable" | "validation_failed" | "publication_failed" | "lease_expired" | "attempts_exhausted";
export type AckFailureReason = "source_unavailable" | "validation_failed" | "publication_failed";

export interface Publication {
  artifact_key: string; request_id: string; validation_record_id: string; publication_id: string;
  loaded_snapshot_id: string; coverage_record_id: string; loaded_at: string; lineage: string[];
}
/** Wire job: exactly the contract `job` definition. `request` is opaque to this module. */
export interface Job {
  job_id: string; request: unknown; status: JobStatus; attempt: number;
  lease_id: string | null; lease_expires_at: string | null; retry_after: string | null;
  failure: FailureReason | null; publication: Publication | null;
}
/** Store record: wire job plus server-only fields that never leave this module. */
export interface StoredJob {
  job: Job; admitted_at: string; lease_owner: string | null; revision: number;
}
export interface OperationRecord {
  service: string; type: "claim" | "ack"; operation_id: string;
  body_hash: string; response: unknown; lease_id: string | null;
}
export interface PagePosition { admitted_at: string; job_id: string }

/** Storage port. `commit` is a compare-and-set: it applies only if the stored
 * revision equals `expected_revision` (and the operation key is unused), writing
 * job and operation record atomically; otherwise it returns false and changes nothing. */
export interface BridgeStore {
  get(jobId: string): Promise<StoredJob | null>;
  /** Jobs ordered by (admitted_at, job_id), strictly after `after`, at most `limit`. */
  listPage(after: PagePosition | null, limit: number): Promise<StoredJob[]>;
  /** Running jobs with lease_expires_at <= nowIso. */
  listExpiredLeases(nowIso: string, limit: number): Promise<StoredJob[]>;
  /** Failed, non-terminal jobs with retry_after <= nowIso. */
  listRetryDue(nowIso: string, limit: number): Promise<StoredJob[]>;
  getOperation(service: string, type: "claim" | "ack", operationId: string): Promise<OperationRecord | null>;
  commit(expectedRevision: number, next: StoredJob, operation: OperationRecord | null): Promise<boolean>;
}
export interface PublicationVerifier {
  /** Server-side check of every publication reference against the stored job. */
  verify(job: Job, publication: Publication): Promise<boolean>;
}
export interface BridgeDeps {
  store: BridgeStore; verifier: PublicationVerifier;
  now(): Date; newLeaseId(): string;
}
/** Identity established by the protected channel before this module runs. */
export interface Caller { service: string; capability: string }

export type BridgeError = "invalid_caller" | "malformed" | "invalid_cursor" | "too_large";
export type BridgeResult = { ok: true; body: string } | { ok: false; error: BridgeError };

const ID = /^[a-z0-9][a-z0-9:_-]{0,95}$/;
const HASH = /^[0-9a-f]{64}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const CURSOR = /^c2:([0-9a-f]{32}):([0-9a-z]+):([A-Za-z0-9_-]{43})$/;
const PAGE_MAX = 20;
const SWEEP_BATCH = 100;
const FAIL_REASONS: readonly string[] = ["source_unavailable", "validation_failed", "publication_failed"];

const bad = (error: BridgeError): BridgeResult => ({ ok: false, error });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const closed = (o: Record<string, unknown>, keys: string[]) =>
  Object.keys(o).length === keys.length && keys.every(k => k in o);
const isId = (v: unknown): v is string => typeof v === "string" && ID.test(v);
const isHash = (v: unknown): v is string => typeof v === "string" && HASH.test(v);
const isTime = (v: unknown): v is string => typeof v === "string" && TIME.test(v) && !Number.isNaN(Date.parse(v));
const isInt = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const byteLength = (s: string) => new TextEncoder().encode(s).length;

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function canonical(v: unknown, seen = new Set<object>()): string {
  if (v === null || typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (seen.has(v)) throw new TypeError("cyclic value");
    seen.add(v);
    const result = `[${v.map(x => canonical(x, seen)).join(",")}]`;
    seen.delete(v);
    return result;
  }
  if (isObj(v)) {
    if (seen.has(v)) throw new TypeError("cyclic value");
    seen.add(v);
    const keys = Object.keys(v).sort();
    const result = `{${keys.map(k => `${JSON.stringify(k)}:${canonical(v[k], seen)}`).join(",")}}`;
    seen.delete(v);
    return result;
  }
  throw new TypeError("unsupported canonical value");
}
const callerOk = (c: Caller) => isObj(c) && isId(c.service) && isId(c.capability);
const iso = (ms: number) => new Date(ms).toISOString();

/** Parse a raw request body (size-capped before parsing) into an enveloped payload. */
function openEnvelope(raw: unknown, kind: string): Record<string, unknown> | BridgeError {
  if (typeof raw !== "string") return "malformed";
  if (byteLength(raw) > MAX_REQUEST_BYTES) return "too_large";
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return "malformed"; }
  if (!isObj(parsed) || !closed(parsed, ["version", "kind", "payload"])) return "malformed";
  if (parsed.version !== 1 || parsed.kind !== kind || !isObj(parsed.payload)) return "malformed";
  return parsed.payload;
}
function respond(kind: string, payload: unknown): BridgeResult {
  const body = JSON.stringify({ version: 1, kind, payload });
  return byteLength(body) > MAX_RESPONSE_BYTES ? bad("too_large") : { ok: true, body };
}
/** Closed projection: server-only fields (owner, admission time, revision) never leave. */
function project(j: Job): Job {
  return { job_id: j.job_id, request: j.request, status: j.status, attempt: j.attempt, lease_id: j.lease_id,
    lease_expires_at: j.lease_expires_at, retry_after: j.retry_after, failure: j.failure, publication: j.publication };
}
function parsePublication(v: unknown): Publication | null {
  if (!isObj(v) || !closed(v, ["artifact_key", "request_id", "validation_record_id", "publication_id",
    "loaded_snapshot_id", "coverage_record_id", "loaded_at", "lineage"])) return null;
  const l = v.lineage;
  if (!isHash(v.artifact_key) || !isHash(v.request_id) || !isId(v.validation_record_id) || !isId(v.publication_id)
    || !isId(v.loaded_snapshot_id) || !isId(v.coverage_record_id) || !isTime(v.loaded_at)) return null;
  if (!Array.isArray(l) || l.length < 1 || l.length > 32 || !l.every(isId) || new Set(l).size !== l.length) return null;
  return { artifact_key: v.artifact_key, request_id: v.request_id, validation_record_id: v.validation_record_id,
    publication_id: v.publication_id, loaded_snapshot_id: v.loaded_snapshot_id, coverage_record_id: v.coverage_record_id,
    loaded_at: v.loaded_at, lineage: [...l] as string[] };
}

/** Cursor bound to service + capability (newline-joined, hashed) and a job id. */
export async function cursorFor(caller: Caller, jobId: string): Promise<string> {
  return pageCursor(caller, { admitted_at: "1970-01-01T00:00:00Z", job_id: jobId });
}

function encodePosition(position: PagePosition): string {
  const timestamp = Date.parse(position.admitted_at);
  const bytes = Uint8Array.from(position.job_id.match(/.{2}/g)!, byte => parseInt(byte, 16));
  return `${timestamp.toString(36)}:${btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
}
function decodePosition(timestamp: string, encoded: string): PagePosition | null {
  try {
    const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
    const job_id = [...binary].map(c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    const ms = parseInt(timestamp, 36);
    if (binary.length !== 32 || !Number.isSafeInteger(ms) || ms < 0 || !isHash(job_id)) return null;
    return { admitted_at: new Date(ms).toISOString(), job_id };
  } catch { return null; }
}

/** Bounded, side-effect-free page read ordered by (admitted_at, job_id). */
export async function readJobs(deps: BridgeDeps, caller: Caller, raw: unknown): Promise<BridgeResult> {
  if (!callerOk(caller)) return bad("invalid_caller");
  const p = openEnvelope(raw, "read");
  if (typeof p === "string") return bad(p);
  if (!closed(p, ["cursor", "limit"]) || !isInt(p.limit, 1, PAGE_MAX) || (p.cursor !== null && typeof p.cursor !== "string")) return bad("malformed");
  let after: PagePosition | null = null;
  if (p.cursor !== null) {
    const m = CURSOR.exec(p.cursor as string);
    const position = m && decodePosition(m[2] as string, m[3] as string);
    if (!m || !position || m[1] !== (await cursorTag(caller, position)).slice(0, 32)) return bad("invalid_cursor");
    after = position;
  }
  const rows = await deps.store.listPage(after, p.limit + 1);
  const page = rows.slice(0, p.limit);
  const valid = page.filter(r => validStoredRequest(r.job.request));
  const next = rows.length > p.limit && page.length ? await pageCursor(caller, { admitted_at: page[page.length - 1]!.admitted_at,
    job_id: page[page.length - 1]!.job.job_id }) : null;
  return respond("read_result", { jobs: valid.map(r => project(r.job)), next_cursor: next });
}

function validStoredRequest(v: unknown): boolean {
  try { if (byteLength(JSON.stringify(v)) > MAX_REQUEST_BYTES) return false; } catch { return false; }
  if (!isObj(v) || !closed(v, ["version", "family", "as_of", "population", "joining_basis", "academy_basis", "visualization"])) return false;
  return v.version === 1 && v.family === "arrival_manager" && typeof v.as_of === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(v.as_of) && new Date(`${v.as_of}T00:00:00Z`).toISOString().slice(0, 10) === v.as_of
    && v.population === "first_team_available" && v.joining_basis === "effective_first_team_spell_entry"
    && v.academy_basis === "documented_first_team_promotion" && v.visualization === "table";
}
async function pageCursor(caller: Caller, position: PagePosition): Promise<string> {
  const [timestamp, jobId] = encodePosition(position).split(":");
  return `c2:${(await cursorTag(caller, position)).slice(0, 32)}:${timestamp}:${jobId}`;
}
async function cursorTag(caller: Caller, position: PagePosition): Promise<string> {
  return sha256Hex(`${caller.service}\n${caller.capability}\n${new Date(Date.parse(position.admitted_at)).toISOString()}\n${position.job_id}`);
}

/** Atomic claim: queued, due, expected attempt equals stored, attempt < 3. */
export async function claimJob(deps: BridgeDeps, caller: Caller, raw: unknown): Promise<BridgeResult> {
  if (!callerOk(caller)) return bad("invalid_caller");
  const p = openEnvelope(raw, "claim");
  if (typeof p === "string") return bad(p);
  if (!closed(p, ["job_id", "expected_attempt", "operation_id"]) || !isHash(p.job_id)
    || !isInt(p.expected_attempt, 0, 2) || !isId(p.operation_id)) return bad("malformed");
  const now = deps.now().getTime();
  const outcome = (o: "conflict" | "exhausted" | "not_found") => respond("claim_result", { outcome: o });
  let bodyHash: string;
  try { bodyHash = await sha256Hex(canonical(p)); } catch { return bad("malformed"); }

  const prior = await deps.store.getOperation(caller.service, "claim", p.operation_id);
  if (prior) {
    if (prior.body_hash !== bodyHash) return outcome("conflict");
    // Replay is served only while the original lease is still current and unexpired.
    const cur = await deps.store.get(p.job_id);
    const j = cur?.job;
    if (!cur || !j || j.status !== "running" || j.lease_id !== prior.lease_id || cur.lease_owner !== caller.service
      || j.lease_expires_at === null || Date.parse(j.lease_expires_at) <= now) return outcome("conflict");
    return respond("claim_result", prior.response);
  }

  const cur = await deps.store.get(p.job_id);
  if (!cur) return outcome("not_found");
  const j = cur.job;
  if (j.status === "failed" && j.failure === "attempts_exhausted") return outcome("exhausted");
  if (j.status !== "queued" || j.attempt !== p.expected_attempt || j.attempt >= MAX_ATTEMPTS) return outcome("conflict");
  if (j.retry_after !== null && Date.parse(j.retry_after) > now) return outcome("conflict");

  const leaseId = deps.newLeaseId();
  if (!isId(leaseId)) throw new Error("newLeaseId returned an invalid lease id");
  const running: Job = { ...j, status: "running", attempt: j.attempt + 1, lease_id: leaseId,
    lease_expires_at: iso(now + LEASE_SECONDS * 1000), retry_after: null, failure: null, publication: null };
  const response = { outcome: "claimed", job: project(running) };
  const op: OperationRecord = { service: caller.service, type: "claim", operation_id: p.operation_id,
    body_hash: bodyHash, response, lease_id: leaseId };
  const won = await deps.store.commit(cur.revision, { ...cur, job: running, lease_owner: caller.service, revision: cur.revision + 1 }, op);
  return won ? respond("claim_result", response) : outcome("conflict");
}

/** Failure transition shared by ack failure and lease expiry. */
function failed(j: Job, reason: FailureReason, nowMs: number): Job {
  const terminal = j.attempt >= MAX_ATTEMPTS;
  return { ...j, status: "failed", lease_id: null, lease_expires_at: null, publication: null,
    failure: terminal ? "attempts_exhausted" : reason,
    retry_after: terminal ? null : iso(nowMs + (RETRY_SECONDS[j.attempt] ?? 1800) * 1000) };
}

/** Acknowledge a running job with finite failure or verified publication evidence. */
export async function ackJob(deps: BridgeDeps, caller: Caller, raw: unknown): Promise<BridgeResult> {
  if (!callerOk(caller)) return bad("invalid_caller");
  const p = openEnvelope(raw, "ack");
  if (typeof p === "string") return bad(p);
  if (!closed(p, ["job_id", "attempt", "lease_id", "operation_id", "outcome"]) || !isHash(p.job_id)
    || !isInt(p.attempt, 1, MAX_ATTEMPTS) || !isId(p.lease_id) || !isId(p.operation_id) || !isObj(p.outcome)) return bad("malformed");
  const o = p.outcome;
  let publication: Publication | null = null;
  let reason: AckFailureReason | null = null;
  if (o.status === "failed" && closed(o, ["status", "reason"]) && FAIL_REASONS.includes(o.reason as string)) {
    reason = o.reason as AckFailureReason;
  } else if (o.status === "published" && closed(o, ["status", "publication"])) {
    publication = parsePublication(o.publication);
  }
  if (!reason && !publication) return bad("malformed");

  const now = deps.now().getTime();
  const outcome = (r: "accepted" | "replayed" | "conflict" | "not_found") => respond("ack_result", { outcome: r });
  let bodyHash: string;
  try { bodyHash = await sha256Hex(canonical(p)); } catch { return bad("malformed"); }
  const prior = await deps.store.getOperation(caller.service, "ack", p.operation_id);
  if (prior) return outcome(prior.body_hash === bodyHash ? "replayed" : "conflict");

  const cur = await deps.store.get(p.job_id);
  if (!cur) return outcome("not_found");
  const j = cur.job;
  if (j.status !== "running" || j.attempt !== p.attempt || j.lease_id !== p.lease_id || cur.lease_owner !== caller.service
    || j.lease_expires_at === null || Date.parse(j.lease_expires_at) <= now) return outcome("conflict");

  let next: Job;
  if (publication) {
    // A candidate supplies references, never truth: failed verification leaves the job running.
    if (Date.parse(publication.loaded_at) > now || !(await deps.verifier.verify(j, publication))) return outcome("conflict");
    next = { ...j, status: "published", lease_id: null, lease_expires_at: null, retry_after: null, failure: null, publication };
  } else {
    next = failed(j, reason as AckFailureReason, now);
  }
  const op: OperationRecord = { service: caller.service, type: "ack", operation_id: p.operation_id,
    body_hash: bodyHash, response: { outcome: "accepted" }, lease_id: p.lease_id };
  const ok = await deps.store.commit(cur.revision, { ...cur, job: next, lease_owner: publication ? cur.lease_owner : null, revision: cur.revision + 1 }, op);
  return outcome(ok ? "accepted" : "conflict");
}

/** Server-owned expiry: expired running jobs become failed attempts with backoff. Returns count moved. */
export async function sweepExpiredLeases(deps: Pick<BridgeDeps, "store" | "now">): Promise<number> {
  const now = deps.now().getTime();
  let n = 0;
  for (const r of await deps.store.listExpiredLeases(iso(now), SWEEP_BATCH)) {
    const j = r.job;
    if (j.status !== "running" || j.lease_expires_at === null || Date.parse(j.lease_expires_at) > now) continue;
    if (await deps.store.commit(r.revision, { ...r, job: failed(j, "lease_expired", now), lease_owner: null, revision: r.revision + 1 }, null)) n++;
  }
  return n;
}

/** Server-owned due transition: retryable failed jobs return to queued, attempt kept. Returns count moved. */
export async function sweepRetryDue(deps: Pick<BridgeDeps, "store" | "now">): Promise<number> {
  const now = deps.now().getTime();
  let n = 0;
  for (const r of await deps.store.listRetryDue(iso(now), SWEEP_BATCH)) {
    const j = r.job;
    if (j.status !== "failed" || j.failure === "attempts_exhausted" || j.retry_after === null || Date.parse(j.retry_after) > now) continue;
    const queued: Job = { ...j, status: "queued", failure: null };
    if (await deps.store.commit(r.revision, { ...r, job: queued, revision: r.revision + 1 }, null)) n++;
  }
  return n;
}
