import type { BridgeStore, OperationRecord, PagePosition, StoredJob } from "../worker/src/core/exploration-bridge";
import { bridgeStoreConformance } from "./support/bridge-store-conformance";

/** Test adapter only. The exported suite sees just BridgeStore, not these maps. */
class MemoryBridgeStore implements BridgeStore {
  private jobs: Map<string, StoredJob>;
  private operations = new Map<string, OperationRecord>();
  constructor(rows: StoredJob[]) { this.jobs = new Map(rows.map(r => [r.job.job_id, structuredClone(r)])); }
  async get(id: string) { return structuredClone(this.jobs.get(id) ?? null); }
  private ordered() {
    return [...this.jobs.values()].sort((a, b) => a.admitted_at.localeCompare(b.admitted_at) || a.job.job_id.localeCompare(b.job.job_id));
  }
  async listPage(after: PagePosition | null, limit: number) {
    return structuredClone(this.ordered().filter(r => !after || r.admitted_at > after.admitted_at ||
      (r.admitted_at === after.admitted_at && r.job.job_id > after.job_id)).slice(0, limit));
  }
  async listExpiredLeases(now: string, limit: number) {
    return structuredClone(this.ordered().filter(r => r.job.status === "running" && r.job.lease_expires_at !== null &&
      r.job.lease_expires_at <= now).slice(0, limit));
  }
  async listRetryDue(now: string, limit: number) {
    return structuredClone(this.ordered().filter(r => r.job.status === "failed" && r.job.failure !== "attempts_exhausted" &&
      r.job.retry_after !== null && r.job.retry_after <= now).slice(0, limit));
  }
  private key(service: string, type: "claim" | "ack", id: string) { return JSON.stringify([service, type, id]); }
  async getOperation(service: string, type: "claim" | "ack", id: string) {
    return structuredClone(this.operations.get(this.key(service, type, id)) ?? null);
  }
  async commit(expected: number, next: StoredJob, operation: OperationRecord | null) {
    if (this.jobs.get(next.job.job_id)?.revision !== expected) return false;
    const key = operation && this.key(operation.service, operation.type, operation.operation_id);
    if (key !== null && this.operations.has(key)) return false;
    this.jobs.set(next.job.job_id, structuredClone(next));
    if (key !== null && operation !== null) this.operations.set(key, structuredClone(operation));
    return true;
  }
}
bridgeStoreConformance("in-memory", async rows => ({ store: new MemoryBridgeStore(rows) }));
