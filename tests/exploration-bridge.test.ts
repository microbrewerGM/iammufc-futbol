import { describe, expect, it } from "vitest";
// @ts-expect-error Node's built-in module is available in the configured test runtime.
import * as nodeCrypto from "node:crypto";
// @ts-expect-error Node's built-in module is available in the configured test runtime.
import * as nodeFs from "node:fs";
declare global {
  interface ImportMeta { url: string }
}
const { createHash } = nodeCrypto as unknown as { createHash(algorithm: string): {
  update(data: Uint8Array): { digest(encoding: "hex"): string };
} };
const { readFileSync } = nodeFs as unknown as { readFileSync(path: URL): Uint8Array & { toString(encoding: "utf8"): string } };
import {
  ackJob, claimJob, cursorFor, hmacCursorSigner, readJobs, sweepExpiredLeases, sweepRetryDue,
  MAX_REQUEST_BYTES, RETRY_WINDOW_SECONDS,
} from "../worker/src/core/exploration-bridge";
import type {
  BridgeDeps, BridgeResult, BridgeStore, Caller, Job, OperationRecord, Publication, StoredJob,
} from "../worker/src/core/exploration-bridge";

const T0 = Date.parse("2026-10-22T12:00:00.000Z");
const schemaBytes = readFileSync(new URL("./fixtures/contracts/arrival-manager-v1.schema.json", import.meta.url));
const schema = JSON.parse(schemaBytes.toString("utf8"));
const hex = (n: number) => n.toString(16).padStart(64, "0");
const request = { version: 1, family: "arrival_manager", as_of: "2026-10-22", population: "first_team_available",
  joining_basis: "effective_first_team_spell_entry", academy_basis: "documented_first_team_promotion", visualization: "table" };
const runner: Caller = { service: "runner-a", capability: "arrival_manager:1" };
const other: Caller = { service: "runner-b", capability: "arrival_manager:1" };
const testSigner = hmacCursorSigner(new TextEncoder().encode("test-only cursor signing key"));

class FakeStore implements BridgeStore {
  jobs = new Map<string, StoredJob>();
  ops = new Map<string, OperationRecord>();
  commits = 0;
  async get(id: string) { const s = this.jobs.get(id); return s ? structuredClone(s) : null; }
  private sorted() {
    return [...this.jobs.values()].sort((a, b) => a.admitted_at.localeCompare(b.admitted_at) || a.job.job_id.localeCompare(b.job.job_id));
  }
  async listPage(after: { admitted_at: string; job_id: string } | null, limit: number) {
    const all = this.sorted().filter(s => !after || s.admitted_at > after.admitted_at
      || (s.admitted_at === after.admitted_at && s.job.job_id > after.job_id));
    return structuredClone(all.slice(0, limit));
  }
  async listExpiredLeases(now: string, limit: number) {
    return structuredClone(this.sorted().filter(s => s.job.status === "running" && s.job.lease_expires_at! <= now).slice(0, limit));
  }
  async listRetryDue(now: string, limit: number) {
    return structuredClone(this.sorted().filter(s => s.job.status === "failed" && s.job.failure !== "attempts_exhausted"
      && s.job.retry_after! <= now).slice(0, limit));
  }
  async getOperation(service: string, type: "claim" | "ack", id: string) {
    return structuredClone(this.ops.get(`${service}|${type}|${id}`) ?? null);
  }
  async commit(expected: number, next: StoredJob, op: OperationRecord | null) {
    const cur = this.jobs.get(next.job.job_id);
    if (!cur || cur.revision !== expected) return false;
    const key = op ? `${op.service}|${op.type}|${op.operation_id}` : null;
    if (key && this.ops.has(key)) return false;
    this.jobs.set(next.job.job_id, structuredClone(next));
    if (key && op) this.ops.set(key, structuredClone(op));
    this.commits++;
    return true;
  }
}

function seed(store: FakeStore, n: number, patch: Partial<Job> = {}, admitted = "2026-10-22T10:00:00.000Z") {
  const job: Job = { job_id: hex(n), request, status: "queued", attempt: 0, lease_id: null, lease_expires_at: null,
    retry_after: null, failure: null, publication: null, ...patch };
  store.jobs.set(job.job_id, { job, admitted_at: admitted, lease_owner: null, revision: 1 });
  return job.job_id;
}
function setup(verify = true) {
  const store = new FakeStore();
  let now = T0; let lease = 0;
  const calls: Publication[] = [];
  const deps: BridgeDeps = { store, cursorSigner: testSigner, now: () => new Date(now), newLeaseId: () => `lease-${++lease}`,
    verifier: { verify: async (_j, p) => { calls.push(p); return verify; } } };
  return { store, deps, calls, advance: (s: number) => { now += s * 1000; } };
}
const env = (kind: string, payload: unknown) => JSON.stringify({ version: 1, kind, payload });
const claimBody = (n: number, expected = 0, op = "op-1") => env("claim", { job_id: hex(n), expected_attempt: expected, operation_id: op });
const pub = (over: Partial<Publication> = {}): Publication => ({ artifact_key: hex(900), request_id: hex(901),
  validation_record_id: "val-1", publication_id: "pub-1", loaded_snapshot_id: "snap-1", coverage_record_id: "cov-1",
  loaded_at: "2026-10-22T11:59:00.000Z", lineage: ["lin-1"], ...over });
const ackBody = (n: number, lease: string, attempt: number, outcome: unknown, op = "ack-1") =>
  env("ack", { job_id: hex(n), attempt, lease_id: lease, operation_id: op, outcome });
const failOutcome = { status: "failed", reason: "source_unavailable" };
function ok(r: BridgeResult) { if (!r.ok) throw new Error(`expected ok, got ${r.error}`); return JSON.parse(r.body); }
const payload = (r: BridgeResult) => ok(r).payload;
const schemaRecord = schema as Record<string, any>;
function schemaValid(def: string, value: unknown): boolean { return matches(schemaRecord.$defs[def], value); }
function matches(spec: any, value: any): boolean {
  if (spec.$ref) return matches(schemaRecord.$defs[spec.$ref.split("/").at(-1)!], value);
  if (spec.oneOf && spec.oneOf.filter((s: any) => matches(s, value)).length !== 1) return false;
  if (spec.allOf && !spec.allOf.every((s: any) => matches(s, value))) return false;
  if (spec.if && matches(spec.if, value) && spec.then && !matches(spec.then, value)) return false;
  if (spec.const !== undefined && value !== spec.const) return false;
  if (spec.enum && !spec.enum.includes(value)) return false;
  if (spec.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    if ((spec.required ?? []).some((k: string) => !(k in value))) return false;
    if (spec.additionalProperties === false && Object.keys(value).some(k => !(k in (spec.properties ?? {})))) return false;
    if (Object.entries(spec.properties ?? {}).some(([k, s]) => k in value && !matches(s, value[k]))) return false;
  }
  if (spec.type === "array") {
    if (!Array.isArray(value) || value.length < (spec.minItems ?? 0) || value.length > (spec.maxItems ?? Infinity)) return false;
    if (spec.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) return false;
    if (spec.items && value.some(v => !matches(spec.items, v))) return false;
  }
  if (spec.type === "integer" && !Number.isInteger(value)) return false;
  if (spec.type === "string" && typeof value !== "string") return false;
  if (spec.type === "null" && value !== null) return false;
  if (typeof value === "number" && (value < (spec.minimum ?? -Infinity) || value > (spec.maximum ?? Infinity))) return false;
  if (typeof value === "string" && ((spec.pattern && !new RegExp(spec.pattern).test(value)) || value.length > (spec.maxLength ?? Infinity))) return false;
  return true;
}
const envelopeValid = (kind: string, def: string, value: unknown) => {
  const envelope = { version: 1, kind, payload: value };
  const branch = (schemaRecord.oneOf as any[]).find(s => s.properties.kind.const === kind);
  return Boolean(branch && matches(branch, envelope) && schemaValid(def, value));
};

describe("read", () => {
  it("orders by admission time then job id, pages with scoped cursors and has no side effects", async () => {
    const { store, deps } = setup();
    seed(store, 3, {}, "2026-10-22T09:00:00.000Z");
    seed(store, 2, {}, "2026-10-22T10:00:00.000Z");
    const firstId = hex(1);
    store.jobs.set(firstId, { job: { job_id: firstId, request, status: "queued", attempt: 0, lease_id: null,
      lease_expires_at: null, retry_after: null, failure: null, publication: null }, admitted_at: "2026-10-22T10:00:00.000Z",
      lease_owner: null, revision: 1 });
    const before = JSON.stringify([...store.jobs]);
    const p1 = payload(await readJobs(deps, runner, env("read", { cursor: null, limit: 2 })));
    expect(p1.jobs.map((j: Job) => j.job_id)).toEqual([hex(3), hex(1)]);
    expect(p1.next_cursor).toMatch(/^c3:[0-9a-f]{32}:[0-9a-z]+:[0-9a-z]+$/);
    const p2 = payload(await readJobs(deps, runner, env("read", { cursor: p1.next_cursor, limit: 2 })));
    expect(p2.jobs.map((j: Job) => j.job_id)).toEqual([hex(2)]);
    expect(p2.next_cursor).toBeNull();
    expect(JSON.stringify([...store.jobs])).toBe(before);
    expect(store.commits).toBe(0);
  });
  it("rejects foreign-scope, unknown and malformed cursors, and bad limits", async () => {
    const { store, deps } = setup();
    seed(store, 1);
    const foreign = await cursorFor(testSigner, other, hex(1));
    const otherCap = await cursorFor(testSigner, { ...runner, capability: "other:1" }, hex(1));
    for (const cursor of [foreign, otherCap]) {
      expect(await readJobs(deps, runner, env("read", { cursor, limit: 5 }))).toEqual({ ok: false, error: "invalid_cursor" });
    }
    for (const cursor of ["SELECT 1", "c1:zz:zz"]) {
      expect(await readJobs(deps, runner, env("read", { cursor, limit: 5 }))).toEqual({ ok: false, error: "invalid_cursor" });
    }
    expect(await readJobs(deps, runner, env("read", { cursor: 5, limit: 5 }))).toEqual({ ok: false, error: "malformed" });
    expect(await readJobs(deps, runner, env("read", { cursor: await cursorFor(testSigner, runner, hex(9)), limit: 5 }))).toMatchObject({ ok: true });
    for (const limit of [0, 21, 1.5, "5"]) {
      expect(await readJobs(deps, runner, env("read", { cursor: null, limit }))).toEqual({ ok: false, error: "malformed" });
    }
    expect((await readJobs(deps, runner, env("read", { cursor: null, limit: 5, order: "x" }))).ok).toBe(false);
  });
  it("rejects forged, altered, and missing cursor tags", async () => {
    const { deps } = setup();
    const valid = await cursorFor(testSigner, runner, hex(1));
    const [, tag, timestamp, job] = valid.split(":");
    const forged = `c3:${"A".repeat(43)}:${timestamp}:${job}`;
    const altered = `c3:${tag}:${timestamp}:${hex(2)}`;
    const missing = `c3::${timestamp}:${job}`;
    const invalidTimestamp = `c3:${tag}:${timestamp}x:${job}`;
    const leadingZeroTimestamp = `c3:${tag}:0${timestamp}:${job}`;
    const leadingZeroJob = `c3:${tag}:${timestamp}:0${job}`;
    const overlongTimestamp = `c3:${tag}:${"z".repeat(12)}:${job}`;
    const overlongJob = `c3:${tag}:${timestamp}:${"z".repeat(51)}`;
    const overlongCursor = `${valid}${"x".repeat(97)}`;
    for (const cursor of [forged, altered, missing, invalidTimestamp, leadingZeroTimestamp,
      leadingZeroJob, overlongTimestamp, overlongJob, overlongCursor])
      expect(await readJobs(deps, runner, env("read", { cursor, limit: 5 }))).toEqual({ ok: false, error: "invalid_cursor" });
    expect(await readJobs(deps, runner, env("read", { cursor: valid, limit: 5 }))).toMatchObject({ ok: true });
  });
  it("projects only closed job fields, never server-only state", async () => {
    const { store, deps } = setup();
    seed(store, 1);
    store.jobs.get(hex(1))!.lease_owner = "secret-owner";
    const r = ok(await readJobs(deps, runner, env("read", { cursor: null, limit: 20 })));
    expect(r).toMatchObject({ version: 1, kind: "read_result" });
    expect(Object.keys(r.payload.jobs[0]).sort()).toEqual(["attempt", "failure", "job_id", "lease_expires_at", "lease_id",
      "publication", "request", "retry_after", "status"]);
    expect(JSON.stringify(r)).not.toContain("secret-owner");
  });
  it("rejects oversized, non-JSON and wrong envelopes before touching the store", async () => {
    const { deps } = setup();
    const big = env("read", { cursor: null, limit: 1, pad: "x".repeat(MAX_REQUEST_BYTES) });
    expect(await readJobs(deps, runner, big)).toEqual({ ok: false, error: "too_large" });
    expect(await readJobs(deps, runner, "{nope")).toEqual({ ok: false, error: "malformed" });
    expect(await readJobs(deps, runner, env("claim", { cursor: null, limit: 1 }))).toEqual({ ok: false, error: "malformed" });
    expect(await readJobs(deps, runner, JSON.stringify({ version: 2, kind: "read", payload: { cursor: null, limit: 1 } }))).toEqual({ ok: false, error: "malformed" });
    expect(await readJobs(deps, { service: "", capability: "x" }, env("read", { cursor: null, limit: 1 }))).toEqual({ ok: false, error: "invalid_caller" });
  });
  it("rejects an oversized stored request row without truncating it", async () => {
    const { store, deps } = setup();
    const id = seed(store, 1);
    store.jobs.get(id)!.job.request = { blob: "x".repeat(300 * 1024) };
    expect(payload(await readJobs(deps, runner, env("read", { cursor: null, limit: 1 }))).jobs).toEqual([]);
  });
  it("keeps a signed page position valid after its cursor row is deleted or changed", async () => {
    const { store, deps } = setup();
    const a = seed(store, 1, {}, "2026-10-22T09:00:00.000Z");
    seed(store, 2, {}, "2026-10-22T10:00:00.000Z");
    const first = payload(await readJobs(deps, runner, env("read", { cursor: null, limit: 1 })));
    store.jobs.delete(a);
    const second = payload(await readJobs(deps, runner, env("read", { cursor: first.next_cursor, limit: 1 })));
    expect(second.jobs.map((j: Job) => j.job_id)).toEqual([hex(2)]);
  });
  it("emits a schema-valid next cursor and accepts it as the next read cursor at current time and max job id", async () => {
    const { store, deps } = setup();
    const longId = "f".repeat(64);
    const firstId = hex(1);
    store.jobs.set(firstId, { job: { job_id: firstId, request, status: "queued", attempt: 0, lease_id: null,
      lease_expires_at: null, retry_after: null, failure: null, publication: null }, admitted_at: "2026-10-22T10:00:00.000Z",
      lease_owner: null, revision: 1 });
    const second: Job = { ...store.jobs.get(firstId)!.job, job_id: longId };
    store.jobs.set(longId, { job: second, admitted_at: "2026-10-22T12:00:00.000Z", lease_owner: null, revision: 1 });
    const first = payload(await readJobs(deps, runner, env("read", { cursor: null, limit: 1 })));
    expect(first.next_cursor).not.toBeNull();
    expect(first.next_cursor.length).toBeLessThanOrEqual(96);
    expect(schemaValid("read_result", { ...first, next_cursor: null })).toBe(true);
    expect(first.next_cursor).toMatch(/^[a-z0-9][a-z0-9:_-]{0,95}$/);
    expect(schemaValid("read", { cursor: null, limit: 1 })).toBe(true);
    const next = payload(await readJobs(deps, runner, env("read", { cursor: first.next_cursor, limit: 1 })));
    expect(next.jobs[0].job_id).toBe(longId);
  });
  it("skips malformed and oversized stored requests while returning valid rows", async () => {
    const { store, deps } = setup();
    seed(store, 1);
    seed(store, 2);
    store.jobs.get(hex(1))!.job.request = { bad: true };
    store.jobs.get(hex(2))!.job.request = { ...request, extra: "x".repeat(MAX_REQUEST_BYTES) };
    const result = payload(await readJobs(deps, runner, env("read", { cursor: null, limit: 2 })));
    expect(result.jobs).toEqual([]);
    expect(result.next_cursor).toBeNull();
  });
});

describe("arrival-manager schema conformance", () => {
  it("matches the vendored contract schema digest", async () => {
    // Private source path: platform/contracts/arrival-manager-v1.schema.json (2026-10-22).
    const sourceSha256 = "45d50c0ff22e098bfec7a0b80ad658fce54e0b77dcd4ac9e9d4dab8ab9693b40";
    const actualSha256 = createHash("sha256").update(schemaBytes).digest("hex");
    expect(actualSha256).toBe(sourceSha256);
  });
  it("validates job/read/read_result/claim/claim_result/ack/ack_result contract shapes", async () => {
    const { store, deps } = setup();
    seed(store, 1);
    const job = store.jobs.get(hex(1))!.job;
    expect(envelopeValid("job", "job", job)).toBe(true);
    expect(envelopeValid("read", "read", { cursor: null, limit: 20 })).toBe(true);
    const read = payload(await readJobs(deps, runner, env("read", { cursor: null, limit: 20 })));
    expect(envelopeValid("read_result", "read_result", read)).toBe(true);
    const claim = payload(await claimJob(deps, runner, claimBody(1)));
    expect(envelopeValid("claim_result", "claim_result", claim)).toBe(true);
    expect(envelopeValid("claim", "claim", { job_id: hex(1), expected_attempt: 0, operation_id: "op-1" })).toBe(true);
    const running = claim.job as Job;
    const ack = { job_id: hex(1), attempt: 1, lease_id: running.lease_id, operation_id: "ack-1",
      outcome: { status: "failed", reason: "source_unavailable" } };
    expect(envelopeValid("ack", "ack", ack)).toBe(true);
    const ackResult = payload(await ackJob(deps, runner, env("ack", ack)));
    expect(envelopeValid("ack_result", "ack_result", ackResult)).toBe(true);
  });
});

describe("claim", () => {
  it("claims a queued job: attempt+1, fresh lease, 900s expiry, owner bound", async () => {
    const { store, deps } = setup();
    seed(store, 1);
    const r = payload(await claimJob(deps, runner, claimBody(1)));
    expect(r.outcome).toBe("claimed");
    expect(r.job).toMatchObject({ status: "running", attempt: 1, lease_id: "lease-1",
      lease_expires_at: "2026-10-22T12:15:00Z", retry_after: null, failure: null });
    expect(store.jobs.get(hex(1))!.lease_owner).toBe("runner-a");
  });
  it("exactly one of two concurrent claimants wins", async () => {
    const { store, deps } = setup();
    seed(store, 1);
    const rs = await Promise.all([claimJob(deps, runner, claimBody(1, 0, "op-a")), claimJob(deps, other, claimBody(1, 0, "op-b"))]);
    const outcomes = rs.map(r => payload(r).outcome).sort();
    expect(outcomes).toEqual(["claimed", "conflict"]);
    expect(store.jobs.get(hex(1))!.job.attempt).toBe(1);
  });
  it("returns not_found, conflict and exhausted without job details", async () => {
    const { store, deps } = setup();
    expect(payload(await claimJob(deps, runner, claimBody(1)))).toEqual({ outcome: "not_found" });
    seed(store, 1, { attempt: 1 });
    expect(payload(await claimJob(deps, runner, claimBody(1, 0)))).toEqual({ outcome: "conflict" });
    seed(store, 2, { status: "failed", attempt: 3, failure: "attempts_exhausted" });
    expect(payload(await claimJob(deps, runner, claimBody(2, 2, "op-2")))).toEqual({ outcome: "exhausted" });
    seed(store, 3, { status: "published", attempt: 1, publication: pub() });
    expect(payload(await claimJob(deps, runner, claimBody(3, 1 - 1, "op-3")))).toEqual({ outcome: "conflict" });
  });
  it("cannot claim running, failed-before-due or expired-but-unswept jobs", async () => {
    const { store, deps, advance } = setup();
    seed(store, 1);
    await claimJob(deps, runner, claimBody(1, 0, "op-1"));
    advance(901);
    expect(payload(await claimJob(deps, other, claimBody(1, 1, "op-x")))).toEqual({ outcome: "conflict" });
    seed(store, 2, { status: "failed", attempt: 1, failure: "lease_expired", retry_after: "2026-10-22T12:05:00.000Z" });
    expect(payload(await claimJob(deps, other, claimBody(2, 1, "op-y")))).toEqual({ outcome: "conflict" });
    // queued but retry_after still in the future is also refused
    seed(store, 3, { attempt: 1, retry_after: new Date(T0 + 3_600_000 * 2).toISOString() });
    expect(payload(await claimJob(deps, other, claimBody(3, 1, "op-z")))).toEqual({ outcome: "conflict" });
  });
  it("replays the original response only while the lease is current and unexpired", async () => {
    const { store, deps, advance } = setup();
    seed(store, 1);
    const first = await claimJob(deps, runner, claimBody(1));
    const commits = store.commits;
    advance(100);
    expect(await claimJob(deps, runner, claimBody(1))).toEqual(first);
    expect(store.commits).toBe(commits);
    expect(store.jobs.get(hex(1))!.job.lease_expires_at).toBe("2026-10-22T12:15:00Z");
    advance(800);
    expect(payload(await claimJob(deps, runner, claimBody(1)))).toEqual({ outcome: "conflict" });
  });
  it("conflicts on a changed body under a reused operation id, and on a fenced-out replay", async () => {
    const { store, deps, advance } = setup();
    seed(store, 1); seed(store, 2);
    await claimJob(deps, runner, claimBody(1));
    expect(payload(await claimJob(deps, runner, claimBody(2, 0, "op-1")))).toEqual({ outcome: "conflict" });
    expect(store.jobs.get(hex(2))!.job.attempt).toBe(0);
    // lease expires, sweep, retry, new worker claims: old replay must conflict
    advance(901);
    await sweepExpiredLeases(deps);
    advance(300);
    await sweepRetryDue(deps);
    expect(payload(await claimJob(deps, other, claimBody(1, 1, "op-n")))).toMatchObject({ outcome: "claimed" });
    expect(payload(await claimJob(deps, runner, claimBody(1)))).toEqual({ outcome: "conflict" });
  });
  it("does not write idempotency records for non-claims", async () => {
    const { store, deps } = setup();
    await claimJob(deps, runner, claimBody(1));
    seed(store, 2, { attempt: 1 });
    await claimJob(deps, runner, claimBody(2, 0, "op-2"));
    expect(store.ops.size).toBe(0);
  });
  it("rejects malformed bodies: attempt 3, bad ids, extra fields", async () => {
    const { deps } = setup();
    for (const body of [claimBody(1, 3), env("claim", { job_id: "short", expected_attempt: 0, operation_id: "op-1" }),
      env("claim", { job_id: hex(1), expected_attempt: 0, operation_id: "Op 1" }),
      env("claim", { job_id: hex(1), expected_attempt: 0, operation_id: "op-1", extra: 1 })]) {
      expect(await claimJob(deps, runner, body)).toEqual({ ok: false, error: "malformed" });
    }
  });
});

describe("ack", () => {
  async function claimed() {
    const ctx = setup();
    seed(ctx.store, 1);
    const job = payload(await claimJob(ctx.deps, runner, claimBody(1))).job as Job;
    return { ...ctx, lease: job.lease_id! };
  }
  it("publishes only after verification and makes the job immutable", async () => {
    const { store, deps, calls, lease } = await claimed();
    const body = ackBody(1, lease, 1, { status: "published", publication: pub() });
    expect(payload(await ackJob(deps, runner, body))).toEqual({ outcome: "accepted" });
    expect(calls).toHaveLength(1);
    const j = store.jobs.get(hex(1))!.job;
    expect(j).toMatchObject({ status: "published", lease_id: null, lease_expires_at: null, failure: null, retry_after: null });
    expect(j.publication).toEqual(pub());
    expect(store.jobs.get(hex(1))!.lease_owner).toBeNull();
    expect(payload(await claimJob(deps, other, claimBody(1, 1, "op-n")))).toEqual({ outcome: "conflict" });
  });
  it("conflicts and stays running when publication verification fails or loaded_at is in the future", async () => {
    const f = setup(false);
    seed(f.store, 1);
    const lease = payload(await claimJob(f.deps, runner, claimBody(1))).job.lease_id;
    expect(payload(await ackJob(f.deps, runner, ackBody(1, lease, 1, { status: "published", publication: pub() })))).toEqual({ outcome: "conflict" });
    expect(f.store.jobs.get(hex(1))!.job.status).toBe("running");
    expect(f.store.ops.size).toBe(1); // only the claim record
    const g = await claimed();
    const future = pub({ loaded_at: "2026-10-22T13:00:00.000Z" });
    expect(payload(await ackJob(g.deps, runner, ackBody(1, g.lease, 1, { status: "published", publication: future })))).toEqual({ outcome: "conflict" });
    expect(g.calls).toHaveLength(0);
  });
  it("rejects malformed publication evidence and outcomes", async () => {
    const { deps, lease } = await claimed();
    const bads: unknown[] = [{ status: "published", publication: { ...pub(), extra: 1 } },
      { status: "published", publication: pub({ lineage: [] }) },
      { status: "published", publication: pub({ artifact_key: "nope" }) },
      { status: "published", publication: pub({ loaded_at: "2026-10-22" }) },
      { status: "published" }, { status: "failed", reason: "lease_expired" }, { status: "failed", reason: "boom: <raw upstream>" },
      { status: "published", reason: "source_unavailable" }, "ok"];
    for (const outcome of bads) {
      expect(await ackJob(deps, runner, ackBody(1, lease, 1, outcome))).toEqual({ ok: false, error: "malformed" });
    }
  });
  it("accepts a failure ack with backoff 300s at attempt 1 and clears the lease", async () => {
    const { store, deps, lease } = await claimed();
    expect(payload(await ackJob(deps, runner, ackBody(1, lease, 1, failOutcome)))).toEqual({ outcome: "accepted" });
    expect(store.jobs.get(hex(1))!.job).toMatchObject({ status: "failed", failure: "source_unavailable", lease_id: null,
      lease_expires_at: null, retry_after: "2026-10-22T12:05:00Z", attempt: 1 });
  });
  it("replays an exact accepted ack even after lease expiry; changed body conflicts", async () => {
    const { store, deps, lease, advance } = await claimed();
    const body = ackBody(1, lease, 1, failOutcome);
    await ackJob(deps, runner, body);
    advance(5000);
    const commits = store.commits;
    expect(payload(await ackJob(deps, runner, body))).toEqual({ outcome: "replayed" });
    expect(store.commits).toBe(commits);
    const changed = ackBody(1, lease, 1, { status: "failed", reason: "validation_failed" });
    expect(payload(await ackJob(deps, runner, changed))).toEqual({ outcome: "conflict" });
    expect(store.jobs.get(hex(1))!.job.failure).toBe("source_unavailable");
  });
  it("conflicts on stale generation, wrong lease, wrong service, expired lease; not_found for unknown job", async () => {
    const { store, deps, lease, advance } = await claimed();
    expect(payload(await ackJob(deps, runner, ackBody(1, lease, 2, failOutcome, "a1")))).toEqual({ outcome: "conflict" });
    expect(payload(await ackJob(deps, runner, ackBody(1, "lease-zzz", 1, failOutcome, "a2")))).toEqual({ outcome: "conflict" });
    expect(payload(await ackJob(deps, other, ackBody(1, lease, 1, failOutcome, "a3")))).toEqual({ outcome: "conflict" });
    expect(payload(await ackJob(deps, runner, ackBody(9, lease, 1, failOutcome, "a4")))).toEqual({ outcome: "not_found" });
    advance(900);
    expect(payload(await ackJob(deps, runner, ackBody(1, lease, 1, failOutcome, "a5")))).toEqual({ outcome: "conflict" });
    expect(store.jobs.get(hex(1))!.job.status).toBe("running");
    expect([...store.ops.keys()].filter(k => k.includes("|ack|"))).toEqual([]);
  });
  it("fences an expired worker out after another claim; newer generation unchanged", async () => {
    const { store, deps, lease, advance } = await claimed();
    advance(901);
    await sweepExpiredLeases(deps);
    advance(300);
    await sweepRetryDue(deps);
    const second = payload(await claimJob(deps, other, claimBody(1, 1, "op-n"))).job;
    expect(payload(await ackJob(deps, runner, ackBody(1, lease, 1, failOutcome)))).toEqual({ outcome: "conflict" });
    expect(store.jobs.get(hex(1))!.job).toMatchObject({ status: "running", attempt: 2, lease_id: second.lease_id });
  });
});

describe("attempts, expiry and retry sweeps", () => {
  async function cycle(ctx: ReturnType<typeof setup>, expected: number, op: string) {
    const job = payload(await claimJob(ctx.deps, runner, claimBody(1, expected, op))).job as Job;
    return job;
  }
  it("backs off 300s, 1800s then terminates with attempts_exhausted; no fourth claim", async () => {
    const ctx = setup();
    seed(ctx.store, 1);
    const stored = () => ctx.store.jobs.get(hex(1))!.job;
    let job = await cycle(ctx, 0, "o1");
    await ackJob(ctx.deps, runner, ackBody(1, job.lease_id!, 1, failOutcome, "k1"));
    expect(stored().retry_after).toBe("2026-10-22T12:05:00Z");
    expect(payload(await claimJob(ctx.deps, runner, claimBody(1, 1, "early")))).toEqual({ outcome: "conflict" });
    expect(await sweepRetryDue(ctx.deps)).toEqual({ moved: 0, failed: 0 });
    ctx.advance(300);
    expect(await sweepRetryDue(ctx.deps)).toEqual({ moved: 1, failed: 0 });
    expect(stored()).toMatchObject({ status: "queued", attempt: 1, failure: null, retry_after: null, lease_id: null, lease_expires_at: null });
    expect(ctx.store.jobs.get(hex(1))!).toMatchObject({ revision: 4, lease_owner: null });
    job = await cycle(ctx, 1, "o2");
    expect(job.attempt).toBe(2);
    const t2 = T0 + 300_000;
    await ackJob(ctx.deps, runner, ackBody(1, job.lease_id!, 2, failOutcome, "k2"));
    expect(stored().retry_after).toBe(new Date(t2 + 1_800_000).toISOString().replace(".000Z", "Z"));
    ctx.advance(1800);
    await sweepRetryDue(ctx.deps);
    job = await cycle(ctx, 2, "o3");
    expect(job.attempt).toBe(3);
    await ackJob(ctx.deps, runner, ackBody(1, job.lease_id!, 3, failOutcome, "k3"));
    expect(stored()).toMatchObject({ status: "failed", failure: "attempts_exhausted", retry_after: null, attempt: 3 });
    ctx.advance(100000);
    expect(await sweepRetryDue(ctx.deps)).toEqual({ moved: 0, failed: 0 });
    expect(payload(await claimJob(ctx.deps, runner, claimBody(1, 2, "o4")))).toEqual({ outcome: "exhausted" });
  });
  it("expiry is a failed attempt with the same backoff, and terminal at attempt 3", async () => {
    const ctx = setup();
    seed(ctx.store, 1);
    const stored = () => ctx.store.jobs.get(hex(1))!.job;
    await cycle(ctx, 0, "o1");
    ctx.advance(899);
    expect(await sweepExpiredLeases(ctx.deps)).toEqual({ moved: 0, failed: 0 });
    ctx.advance(1);
    expect(await sweepExpiredLeases(ctx.deps)).toEqual({ moved: 1, failed: 0 });
    expect(stored()).toMatchObject({ status: "failed", failure: "lease_expired", lease_id: null, lease_expires_at: null,
      retry_after: new Date(ctx.deps.now().getTime() + 300_000).toISOString().replace(".000Z", "Z") });
    expect(ctx.store.jobs.get(hex(1))!.lease_owner).toBeNull();
    seed(ctx.store, 2, { status: "running", attempt: 3, lease_id: "lease-9", lease_expires_at: "2026-10-22T12:00:00.000Z" });
    expect(await sweepExpiredLeases(ctx.deps)).toEqual({ moved: 1, failed: 0 });
    expect(ctx.store.jobs.get(hex(2))!.job).toMatchObject({ status: "failed", failure: "attempts_exhausted", retry_after: null });
  });
  it("sweeps lose cleanly to a concurrent CAS write", async () => {
    const ctx = setup();
    seed(ctx.store, 1, { status: "running", attempt: 1, lease_id: "lease-9", lease_expires_at: "2026-10-22T11:00:00.000Z" });
    const real = ctx.store.listExpiredLeases.bind(ctx.store);
    ctx.store.listExpiredLeases = async (n, l) => {
      const rows = await real(n, l);
      ctx.store.jobs.get(hex(1))!.revision++; // another writer commits between list and commit
      return rows;
    };
    expect(await sweepExpiredLeases(ctx.deps)).toEqual({ moved: 0, failed: 0 });
    expect(ctx.store.jobs.get(hex(1))!.job.status).toBe("running");
  });
  it("never resets attempt, admits jobs or creates records from a sweep", async () => {
    const ctx = setup();
    seed(ctx.store, 1, { status: "failed", attempt: 2, failure: "lease_expired", retry_after: "2026-10-22T11:00:00.000Z" });
    await sweepRetryDue(ctx.deps);
    expect(ctx.store.jobs.size).toBe(1);
    expect(ctx.store.jobs.get(hex(1))!.job.attempt).toBe(2);
    expect(ctx.store.ops.size).toBe(0);
  });

  it("clamps late expiry retries to the claimed-at 24-hour bound and recovers the job", async () => {
    expect(RETRY_WINDOW_SECONDS).toBe(86_400);
    const ctx = setup();
    const claimedAt = T0;
    seed(ctx.store, 1, { status: "running", attempt: 1, lease_id: "lease-1",
      lease_expires_at: new Date(claimedAt + 900_000).toISOString() });
    ctx.advance(2 * 86_400);
    expect(await sweepExpiredLeases(ctx.deps)).toEqual({ moved: 1, failed: 0 });
    expect(ctx.store.jobs.get(hex(1))!.job.retry_after).toBe(new Date(claimedAt + 86_400_000).toISOString().replace(".000Z", "Z"));
    expect(Date.parse(ctx.store.jobs.get(hex(1))!.job.retry_after!)).toBeGreaterThan(claimedAt);
    expect(await sweepRetryDue(ctx.deps)).toEqual({ moved: 1, failed: 0 });
    expect((payload(await claimJob(ctx.deps, other, claimBody(1, 1, "late-reclaim"))).job as Job).attempt).toBe(2);
  });

  it("clamps attempt one and two at and just after the one-day boundary", async () => {
    for (const [id, attempt, elapsed] of [[1, 1, 86_100], [2, 2, 84_300],
      [3, 1, 86_101], [4, 2, 84_301]] as const) {
      const ctx = setup();
      const claimedAt = T0;
      seed(ctx.store, id, { status: "running", attempt, lease_id: `lease-${id}`,
        lease_expires_at: new Date(claimedAt + 900_000).toISOString() });
      ctx.advance(elapsed);
      expect(await sweepExpiredLeases(ctx.deps)).toEqual({ moved: 1, failed: 0 });
      const backoffSeconds = attempt === 1 ? 300 : 1800;
      const expected = new Date(Math.min(claimedAt + (elapsed + backoffSeconds) * 1000,
        claimedAt + RETRY_WINDOW_SECONDS * 1000)).toISOString().replace(".000Z", "Z");
      expect(ctx.store.jobs.get(hex(id))!.job.retry_after).toBe(expected);
    }
  });

  it("continues after a row commit throws and reports failed count; ack backoff stays exact", async () => {
    const ctx = setup();
    seed(ctx.store, 1, { status: "running", attempt: 1, lease_id: "lease-1",
      lease_expires_at: new Date(T0 + 900_000).toISOString() });
    seed(ctx.store, 2, { status: "running", attempt: 1, lease_id: "lease-2",
      lease_expires_at: new Date(T0 + 900_000).toISOString() });
    ctx.advance(901);
    const commit = ctx.store.commit.bind(ctx.store);
    ctx.store.commit = async (...args) => {
      if (args[1].job.job_id === hex(1)) throw new Error("transient store failure");
      return commit(...args);
    };
    expect(await sweepExpiredLeases(ctx.deps)).toEqual({ moved: 1, failed: 1 });
    expect(ctx.store.jobs.get(hex(1))!.job.status).toBe("running");
    expect(ctx.store.jobs.get(hex(2))!.job.retry_after).toBe("2026-10-22T12:20:01Z");

    const ordinary = setup();
    seed(ordinary.store, 3);
    const claimed = payload(await claimJob(ordinary.deps, runner, claimBody(3))).job as Job;
    await ackJob(ordinary.deps, runner, ackBody(3, claimed.lease_id!, 1, failOutcome));
    expect(ordinary.store.jobs.get(hex(3))!.job.retry_after).toBe("2026-10-22T12:05:00Z");
  });
});


describe("whole-second bridge storage contract", () => {
  it("samples once for claim and ack, and computes exact second-only deadlines", async () => {
    const { store, deps } = setup();
    seed(store, 1);
    let clockCalls = 0;
    deps.now = () => { clockCalls++; return new Date(T0 + 999); };
    const claimed = payload(await claimJob(deps, runner, claimBody(1))).job as Job;
    expect(clockCalls).toBe(1);
    expect(claimed.lease_expires_at).toBe("2026-10-22T12:15:00Z");
    expect(store.jobs.get(hex(1))!).toMatchObject({ revision: 2, lease_owner: "runner-a" });
    expect(payload(await ackJob(deps, runner, ackBody(1, claimed.lease_id!, 1, failOutcome))))
      .toEqual({ outcome: "accepted" });
    expect(clockCalls).toBe(2);
    expect(store.jobs.get(hex(1))!).toMatchObject({ revision: 3, lease_owner: null,
      job: { status: "failed", lease_id: null, lease_expires_at: null, retry_after: "2026-10-22T12:05:00Z" } });
  });
  it("keeps an unexpired lease valid until its exact stored expiry second", async () => {
    const { store, deps } = setup();
    seed(store, 1);
    deps.now = () => new Date(T0 + 999);
    await claimJob(deps, runner, claimBody(1));
    deps.now = () => new Date(T0 + 899_999);
    expect(payload(await claimJob(deps, runner, claimBody(1))).outcome).toBe("claimed");
    deps.now = () => new Date(T0 + 900_000);
    expect(payload(await claimJob(deps, runner, claimBody(1)))).toEqual({ outcome: "conflict" });
  });
  it("floors the expiry sweep clock once and keeps future leases running", async () => {
    const { store, deps } = setup();
    seed(store, 1, { status: "running", attempt: 1, lease_id: "lease-1", lease_expires_at: "2026-10-22T12:00:00Z" });
    seed(store, 2, { status: "running", attempt: 1, lease_id: "lease-2", lease_expires_at: "2026-10-22T12:00:01Z" });
    let clockCalls = 0;
    deps.now = () => { clockCalls++; return new Date(T0 + 999); };
    expect(await sweepExpiredLeases(deps)).toEqual({ moved: 1, failed: 0 });
    expect(clockCalls).toBe(1);
    expect(store.jobs.get(hex(1))!).toMatchObject({ lease_owner: null,
      job: { status: "failed", retry_after: "2026-10-22T12:05:00Z", lease_expires_at: null } });
    expect(store.jobs.get(hex(2))!.job.status).toBe("running");
  });
  it("consumes a due retry once, preserving attempt and advancing revision exactly once", async () => {
    const { store, deps } = setup();
    seed(store, 1, { status: "failed", attempt: 1, failure: "source_unavailable", retry_after: "2026-10-22T12:00:00Z" });
    store.jobs.get(hex(1))!.revision = 3;
    let clockCalls = 0;
    deps.now = () => { clockCalls++; return new Date(T0 + 999); };
    expect(await sweepRetryDue(deps)).toEqual({ moved: 1, failed: 0 });
    expect(clockCalls).toBe(1);
    expect(store.jobs.get(hex(1))!).toMatchObject({ revision: 4, lease_owner: null, job: { status: "queued",
      attempt: 1, retry_after: null, failure: null, lease_id: null, lease_expires_at: null } });
    expect(await sweepRetryDue(deps)).toEqual({ moved: 0, failed: 0 });
    expect(payload(await claimJob(deps, other, claimBody(1, 1, "op-2"))).job.attempt).toBe(2);
    expect(store.jobs.get(hex(1))!.revision).toBe(5);
  });
  it("does not requeue future, null, exhausted, or non-failed retry rows", async () => {
    const { store, deps } = setup();
    seed(store, 1, { status: "failed", attempt: 1, failure: "source_unavailable", retry_after: "2026-10-22T12:00:01Z" });
    seed(store, 2, { status: "failed", attempt: 1, failure: "source_unavailable", retry_after: null });
    seed(store, 3, { status: "failed", attempt: 3, failure: "attempts_exhausted", retry_after: null });
    seed(store, 4);
    const before = structuredClone([...store.jobs]);
    // Deliberately overbroad store result tests the core guard as well as filtering.
    store.listRetryDue = async () => structuredClone([...store.jobs.values()]);
    deps.now = () => new Date(T0 + 999);
    expect(await sweepRetryDue(deps)).toEqual({ moved: 0, failed: 0 });
    expect([...store.jobs]).toEqual(before);
  });
});
