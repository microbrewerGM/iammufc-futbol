import { describe, expect, it } from "vitest";
import type { BridgeDeps, BridgeResult, Caller, Job, StoredJob } from "../worker/src/core/exploration-bridge";
import { claimJobAfterSweep, readJobsAfterSweep } from "../worker/src/routes/exploration-bridge-sweep";

const NOW = "2026-10-23T12:00:00Z";
const id = (n: number) => n.toString(16).padStart(64, "0");
const request = { version: 1, family: "arrival_manager", as_of: "2026-10-22",
  population: "first_team_available", joining_basis: "effective_first_team_spell_entry",
  academy_basis: "documented_first_team_promotion", visualization: "table" };
const runner: Caller = { service: "runner-a", capability: "arrival_manager:1" };
const queued = (n: number): StoredJob => ({ admitted_at: NOW, revision: 1, lease_owner: null,
  job: { job_id: id(n), request, status: "queued", attempt: 0, lease_id: null, lease_expires_at: null,
    retry_after: null, failure: null, publication: null } });
const envelope = (kind: string, payload: unknown) => JSON.stringify({ version: 1, kind, payload });
function payload(result: BridgeResult) {
  if (!result.ok) throw new Error(`unexpected bridge error: ${result.error}`);
  return JSON.parse(result.body).payload;
}

class MemoryStore {
  rows = new Map<string, StoredJob>();
  expiredLimit = 0;
  dueLimit = 0;
  listCalls: string[] = [];
  failList = false;

  async get(jobId: string) { return structuredClone(this.rows.get(jobId) ?? null); }
  async listPage(_after: unknown, limit: number) {
    this.listCalls.push("read");
    return [...this.rows.values()].slice(0, limit).map(row => structuredClone(row));
  }
  async listExpiredLeases(now: string, limit: number) {
    this.listCalls.push("expired"); this.expiredLimit = limit;
    if (this.failList) throw new Error("sensitive storage failure");
    return [...this.rows.values()].filter(row => row.job.status === "running" && row.job.lease_expires_at! <= now)
      .slice(0, limit).map(row => structuredClone(row));
  }
  async listRetryDue(now: string, limit: number) {
    this.listCalls.push("due"); this.dueLimit = limit;
    if (this.failList) throw new Error("sensitive storage failure");
    return [...this.rows.values()].filter(row => row.job.status === "failed" && row.job.failure !== "attempts_exhausted"
      && row.job.retry_after! <= now).slice(0, limit).map(row => structuredClone(row));
  }
  async getOperation() { return null; }
  async commit(expected: number, next: StoredJob) {
    const current = this.rows.get(next.job.job_id);
    if (!current || current.revision !== expected) return false;
    this.rows.set(next.job.job_id, structuredClone(next));
    return true;
  }
}

function fixture() {
  const store = new MemoryStore();
  let now = Date.parse(NOW);
  let leaseNumber = 0;
  const deps: BridgeDeps = { store: store as unknown as BridgeDeps["store"],
    verifier: { verify: async () => false }, cursorSigner: {
      sign: async () => "0".repeat(32), verify: async () => true,
    }, now: () => new Date(now), newLeaseId: () => `lease-${++leaseNumber}` };
  return { store, deps, advance(seconds: number) { now += seconds * 1000; } };
}

describe("bridge request sweeps", () => {
  it("sweeps expiry and due retries before a claim, respecting the retry delay", async () => {
    const { store, deps, advance } = fixture();
    const source = queued(1);
    const running: Job = { ...source.job, status: "running", attempt: 1, lease_id: "lease-old",
      lease_expires_at: "2026-10-23T11:45:00Z" };
    store.rows.set(running.job_id, { ...source, job: running, revision: 2, lease_owner: "runner-a" });

    const raw = envelope("claim", { job_id: running.job_id, expected_attempt: 1, operation_id: "op-1" });
    const first = await claimJobAfterSweep(deps, runner, raw);
    expect(first.status).toBe(200);
    expect(payload(first.result!).outcome).toBe("conflict");
    const failed = store.rows.get(running.job_id)!;
    expect(failed.job.status).toBe("failed");
    expect(failed.job.retry_after).toBe("2026-10-23T12:05:00Z");

    advance(300);
    const second = await claimJobAfterSweep(deps, runner,
      envelope("claim", { job_id: running.job_id, expected_attempt: 1, operation_id: "op-2" }));
    expect(payload(second.result!).outcome).toBe("claimed");
    expect(store.listCalls.slice(0, 3)).toEqual(["expired", "due", "expired"]);
    expect(store.expiredLimit).toBe(100);
    expect(store.dueLimit).toBe(100);
  });

  it("runs both sweeps before a read", async () => {
    const { store, deps } = fixture();
    const result = await readJobsAfterSweep(deps, runner,
      envelope("read", { cursor: null, limit: 10 }));
    expect(result.status).toBe(200);
    expect(store.listCalls).toEqual(["expired", "due", "read"]);
  });

  it("returns a generic failure without leaking sweep storage details", async () => {
    const { store, deps } = fixture();
    store.failList = true;
    const result = await claimJobAfterSweep(deps, runner,
      envelope("claim", { job_id: id(1), expected_attempt: 0, operation_id: "op-1" }));
    expect(result).toEqual({ status: 503, result: null });
  });
});
