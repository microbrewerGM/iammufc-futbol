import { beforeEach, describe, expect, it } from "vitest";
import type { BridgeStore, Job, OperationRecord, StoredJob } from "../../worker/src/core/exploration-bridge";

/** Supply a fresh, isolated store seeded with exactly these records for each test.
 * D1 fixtures must establish seeded states through legal transitions, then release
 * their database in dispose. Never disable production constraints for setup.
 * No test relies on private maps, SQL representation or a synchronous factory. */
export interface BridgeStoreFixture { store: BridgeStore; dispose?(): void | Promise<void> }
export type BridgeStoreFactory = (rows: StoredJob[]) => BridgeStoreFixture | Promise<BridgeStoreFixture>;
const NOW = "2026-10-23T12:00:00.000Z";
const BEFORE = "2026-10-23T11:59:59.000Z";
const AFTER = "2026-10-23T12:00:01.000Z";
const id = (n: number) => n.toString(16).padStart(64, "0");
function row(n: number, admitted = BEFORE, patch: Partial<Job> = {}): StoredJob {
  return { admitted_at: admitted, revision: 1, lease_owner: null, job: {
    job_id: id(n), request: { version: 1, family: "arrival_manager", as_of: "2026-10-22",
      population: "first_team_available", joining_basis: "effective_first_team_spell_entry",
      academy_basis: "documented_first_team_promotion", visualization: "table" },
    status: "queued", attempt: 0, lease_id: null, lease_expires_at: null,
    retry_after: null, failure: null, publication: null, ...patch,
  } };
}
const op = (patch: Partial<OperationRecord> = {}): OperationRecord => ({ service: "runner-a", type: "claim",
  operation_id: "op-1", body_hash: id(100), response: { outcome: "claimed" }, lease_id: "lease-1", ...patch });
const next = (r: StoredJob): StoredJob => ({ ...structuredClone(r), revision: r.revision + 1,
  lease_owner: "runner-a", job: { ...structuredClone(r.job), status: "running", attempt: 1,
    lease_id: "lease-1", lease_expires_at: AFTER } });

/** Register identical observable port assertions for any BridgeStore adapter. */
export function bridgeStoreConformance(name: string, create: BridgeStoreFactory): void {
  describe(`${name}: BridgeStore conformance`, () => {
    let store: BridgeStore;
    let rows: StoredJob[];
    beforeEach(async () => {
      // Deliberately shuffled; ids tie-break admission time, not insertion order.
      rows = [row(3), row(1, AFTER), row(2), row(4, BEFORE, { status: "running", attempt: 1,
        lease_id: "lease-4", lease_expires_at: NOW }), row(5, BEFORE, { status: "running", attempt: 1,
        lease_id: "lease-5", lease_expires_at: BEFORE }), row(6, BEFORE, { status: "running", attempt: 1,
        lease_id: "lease-6", lease_expires_at: AFTER }), row(7, BEFORE, { status: "failed", attempt: 1,
        failure: "source_unavailable", retry_after: NOW }), row(8, BEFORE, { status: "failed", attempt: 2,
        failure: "lease_expired", retry_after: BEFORE }), row(9, BEFORE, { status: "failed", attempt: 1,
        failure: "validation_failed", retry_after: AFTER }), row(10, BEFORE, { status: "failed", attempt: 3,
        failure: "attempts_exhausted", retry_after: null }), row(12, BEFORE, { status: "queued", attempt: 1, retry_after: null }),
        row(13, BEFORE, { status: "published", attempt: 1, publication: {
          artifact_key: id(100), request_id: id(101), validation_record_id: "validation-1", publication_id: "publication-1",
          loaded_snapshot_id: "snapshot-1", coverage_record_id: "coverage-1", loaded_at: BEFORE, lineage: ["lineage-1"],
        } })];
      const fixture = await create(structuredClone(rows));
      store = fixture.store;
      return async () => { await fixture.dispose?.(); };
    });

    it("gets exact records and returns null for absent jobs and operations", async () => {
      expect(await store.get(id(3))).toEqual(rows[0]);
      expect(await store.get(id(99))).toBeNull();
      expect(await store.getOperation("runner-a", "claim", "missing")).toBeNull();
    });
    it("commits a matching revision and operation together", async () => {
      const r = rows[0]!; const change = next(r); const operation = op();
      expect(await store.commit(1, change, operation)).toBe(true);
      expect(await store.get(r.job.job_id)).toEqual(change);
      expect(await store.getOperation("runner-a", "claim", "op-1")).toEqual(operation);
    });
    it("rejects stale revisions without writing the job or operation", async () => {
      const r = rows[0]!;
      expect(await store.commit(0, next(r), op())).toBe(false);
      expect(await store.get(r.job.job_id)).toEqual(r);
      expect(await store.getOperation("runner-a", "claim", "op-1")).toBeNull();
      expect(await store.commit(1, next(r), op())).toBe(true);
      expect(await store.get(r.job.job_id)).toEqual(next(r));
      expect(await store.getOperation("runner-a", "claim", "op-1")).toEqual(op());
    });
    it("rejects a duplicate operation key without changing either job", async () => {
      const a = rows[0]!; const b = rows[2]!; const operation = op();
      expect(await store.commit(1, next(a), operation)).toBe(true);
      expect(await store.commit(1, next(b), op({ body_hash: id(101) }))).toBe(false);
      expect(await store.get(a.job.job_id)).toEqual(next(a));
      expect(await store.get(b.job.job_id)).toEqual(b);
      expect(await store.getOperation("runner-a", "claim", "op-1")).toEqual(operation);
    });
    it("rejects an identical operation record reused against a different job", async () => {
      const a = rows[0]!; const b = rows[2]!; const operation = op();
      expect(await store.commit(1, next(a), operation)).toBe(true);
      expect(await store.commit(1, next(b), structuredClone(operation))).toBe(false);
      expect(await store.get(a.job.job_id)).toEqual(next(a));
      expect(await store.get(b.job.job_id)).toEqual(b);
      expect(await store.getOperation("runner-a", "claim", "op-1")).toEqual(operation);
    });
    it("scopes operation keys by service and operation type", async () => {
      for (const [index, operation] of [op(), op({ service: "runner-b" }), op({ type: "ack" })].entries()) {
        expect(await store.commit(1, next(rows[index]!), operation)).toBe(true);
        expect(await store.getOperation(operation.service, operation.type, operation.operation_id)).toEqual(operation);
      }
      expect(await store.getOperation("runner-c", "claim", "op-1")).toBeNull();
    });
    it("supports operation-free sweep commits with the same revision guard", async () => {
      const r = rows[0]!;
      expect(await store.commit(1, next(r), null)).toBe(true);
      expect(await store.commit(1, { ...r, revision: 3 }, null)).toBe(false);
      expect(await store.get(r.job.job_id)).toEqual(next(r));
    });
    it("does not create a missing job through compare-and-set", async () => {
      expect(await store.commit(1, next(row(99)), op())).toBe(false);
      expect(await store.get(id(99))).toBeNull();
      expect(await store.getOperation("runner-a", "claim", "op-1")).toBeNull();
    });
    it("allows exactly one concurrent winner for a job revision", async () => {
      const r = rows[0]!;
      const results = await Promise.all([store.commit(1, next(r), op()),
        store.commit(1, { ...next(r), lease_owner: "runner-b" }, op({ operation_id: "op-2" }))]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const winning = results[0] ? op() : op({ operation_id: "op-2" });
      expect(await store.getOperation("runner-a", "claim", winning.operation_id)).toEqual(winning);
      expect(await store.getOperation("runner-a", "claim", results[0] ? "op-2" : "op-1")).toBeNull();
      expect(await store.get(r.job.job_id)).toEqual(results[0] ? next(r) : { ...next(r), lease_owner: "runner-b" });
    });
    it("allows exactly one concurrent winner for an operation key across jobs", async () => {
      const a = rows[0]!; const b = rows[2]!;
      const results = await Promise.all([store.commit(1, next(a), op()),
        store.commit(1, next(b), op({ body_hash: id(101) }))]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await store.get(a.job.job_id)).toEqual(results[0] ? next(a) : a);
      expect(await store.get(b.job.job_id)).toEqual(results[1] ? next(b) : b);
      expect(await store.getOperation("runner-a", "claim", "op-1")).toEqual(results[0] ? op() : op({ body_hash: id(101) }));
    });
    it("orders pages by admission then id, applies exclusive positions and bounds", async () => {
      const sorted = [...rows].sort((a, b) => a.admitted_at.localeCompare(b.admitted_at) || a.job.job_id.localeCompare(b.job.job_id));
      expect(await store.listPage(null, 2)).toEqual(sorted.slice(0, 2));
      const first = sorted[1]!;
      expect(await store.listPage({ admitted_at: first.admitted_at, job_id: first.job.job_id }, 2)).toEqual(sorted.slice(2, 4));
      expect(await store.listPage({ admitted_at: NOW, job_id: id(99) }, 2)).toEqual([rows[1]]);
      expect(await store.listPage({ admitted_at: AFTER, job_id: id(99) }, 2)).toEqual([]);
      const all: StoredJob[] = []; let after = null as { admitted_at: string; job_id: string } | null;
      for (let pageNumber = 0; pageNumber <= rows.length; pageNumber++) {
        const page = await store.listPage(after, 2);
        if (!page.length) break;
        expect(page.length).toBeLessThanOrEqual(2); all.push(...page);
        const last = page[page.length - 1]!; after = { admitted_at: last.admitted_at, job_id: last.job.job_id };
      }
      expect(all).toEqual(sorted);
    });
    it("lists only running leases expired at or before now, within limit", async () => {
      const eligible = rows.filter(r => [id(4), id(5)].includes(r.job.job_id));
      const result = await store.listExpiredLeases(NOW, 20);
      expect(result.map(r => r.job.job_id).sort()).toEqual(eligible.map(r => r.job.job_id).sort());
      expect(await store.listExpiredLeases(BEFORE, 20)).toEqual([rows[4]]);
      const limited = await store.listExpiredLeases(NOW, 1);
      expect(limited).toHaveLength(1); expect(eligible).toContainEqual(limited[0]);
    });
    it("lists only due non-terminal failed retries, excluding nulls and other states", async () => {
      const eligible = rows.filter(r => [id(7), id(8)].includes(r.job.job_id));
      const result = await store.listRetryDue(NOW, 20);
      expect(result.map(r => r.job.job_id).sort()).toEqual(eligible.map(r => r.job.job_id).sort());
      expect(await store.listRetryDue(BEFORE, 20)).toEqual([rows[7]]);
      const limited = await store.listRetryDue(NOW, 1);
      expect(limited).toHaveLength(1); expect(eligible).toContainEqual(limited[0]);
    });
  });
}
