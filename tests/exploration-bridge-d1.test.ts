import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error Node built-ins are provided by the test runtime, not Worker types.
import { DatabaseSync } from "node:sqlite";
// @ts-expect-error Node built-ins are provided by the test runtime, not Worker types.
import { readFileSync } from "node:fs";
import { D1BridgeStore } from "../worker/src/core/exploration-bridge-d1";
import { ackJob, claimJob, hmacCursorSigner, readJobs, sweepExpiredLeases, sweepRetryDue } from "../worker/src/core/exploration-bridge";
import type { BridgeDeps, OperationRecord, StoredJob } from "../worker/src/core/exploration-bridge";
import { bridgeStoreConformance } from "./support/bridge-store-conformance";

type Value = string | number | null;
const NOW = "2026-10-23T12:00:00Z";
const LATER = "2026-10-23T12:15:00Z";
const id = (n: number) => n.toString(16).padStart(64, "0");
const request = { version: 1, family: "arrival_manager", as_of: "2026-10-22",
  population: "first_team_available", joining_basis: "effective_first_team_spell_entry",
  academy_basis: "documented_first_team_promotion", visualization: "table" };
const row = (n: number): StoredJob => ({ admitted_at: NOW, revision: 1, lease_owner: null,
  job: { job_id: id(n), request, status: "queued", attempt: 0, lease_id: null,
    lease_expires_at: null, retry_after: null, failure: null, publication: null } });
const running = (r: StoredJob): StoredJob => ({ ...structuredClone(r), revision: r.revision + 1,
  lease_owner: "runner-a", job: { ...structuredClone(r.job), status: "running", attempt: r.job.attempt + 1,
    lease_id: "lease-a", lease_expires_at: LATER } });
const operation = (patch: Partial<OperationRecord> = {}): OperationRecord => ({ service: "runner-a", type: "claim",
  operation_id: "op-a", body_hash: id(99), response: { outcome: "claimed" }, lease_id: "lease-a", ...patch });

/** Execute real SQL with all 0008 constraints and triggers. Only the binding
 * transport is emulated; batch mirrors D1's ordered transaction and rollback. */
class SQLiteBinding implements Pick<D1Database, "prepare" | "batch"> {
  readonly sqlite = new DatabaseSync(":memory:");
  batches = 0;
  constructor() {
    this.sqlite.exec("PRAGMA foreign_keys=ON");
    for (const name of ["0001_schema.sql", "0003_p16_dot_plot.sql", "0004_cache_slots.sql",
      "0005_account_question_history.sql", "0006_season_splits.sql", "0008_exploration_request_links.sql"]) {
      this.sqlite.exec(readFileSync(`infra/migrations/${name}`, "utf8"));
    }
  }
  prepare(sql: string): D1PreparedStatement { return new SQLiteStatement(this, sql); }
  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.batches++;
    this.sqlite.exec("BEGIN");
    try {
      // Do not yield between statements: the transaction is the unit of isolation.
      const result = statements.map(statement => {
        if (!(statement instanceof SQLiteStatement)) throw new Error("foreign test statement");
        return statement.execute<T>();
      });
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
}
class SQLiteStatement implements D1PreparedStatement {
  constructor(private readonly binding: SQLiteBinding, private readonly sql: string, private readonly values: Value[] = []) {}
  bind(...values: unknown[]): D1PreparedStatement {
    if (!values.every(v => v === null || typeof v === "string" || typeof v === "number")) throw new Error("invalid test binding");
    return new SQLiteStatement(this.binding, this.sql, values as Value[]);
  }
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const result = this.binding.sqlite.prepare(this.sql).get(...this.values) as Record<string, unknown> | undefined;
    return (result === undefined ? null : column === undefined ? result : result[column]) as T | null;
  }
  execute<T>(): D1Result<T> {
    const statement = this.binding.sqlite.prepare(this.sql);
    const before = Number(this.binding.sqlite.prepare("SELECT total_changes() AS n").get().n);
    const results = statement.all(...this.values) as T[];
    // D1 metadata counts trigger/cascade writes, unlike SQLite changes().
    const changes = Number(this.binding.sqlite.prepare("SELECT total_changes() AS n").get().n) - before;
    return { results, success: true, meta: { changes, duration: 0, size_after: 0, rows_read: results.length,
      rows_written: changes, last_row_id: 0, changed_db: changes > 0 } };
  }
  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> { return this.execute<T>(); }
  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> { return this.execute<T>(); }
  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(_options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    throw new Error("raw not used by adapter");
  }
}
function seed(db: SQLiteBinding, target: StoredJob): void {
  const s = db.sqlite;
  const t = target.admitted_at; const key = target.job.job_id;
  s.prepare("INSERT INTO exploration_shared_requests VALUES (?,1,?,?)").run(key, JSON.stringify(target.job.request), t);
  s.prepare(`INSERT INTO exploration_request_links VALUES (?, 'synthetic-account', ?,
    strftime('%Y-%m-%dT%H:%M:%SZ', ?, '+90 days'))`).run(key, t, t);
  s.prepare(`INSERT INTO exploration_shared_jobs
    (job_id,request_id,status,attempt,admitted_at,created_at,updated_at,expires_at)
    VALUES (?,?,'queued',0,?,?,?,strftime('%Y-%m-%dT%H:%M:%SZ',?,'+30 days'))`).run(key, key, t, t, t, t);
  // Establish every seeded revision through the production state machine.
  for (let attempt = 1; attempt <= target.job.attempt; attempt++) {
    const final = attempt === target.job.attempt;
    const expiry = final && target.job.status === "running" ? target.job.lease_expires_at : NOW;
    s.prepare(`UPDATE exploration_shared_jobs SET revision=revision+1,status='running',attempt=?,
      lease_id=?,lease_owner='runner-a',lease_expires_at=?,claimed_at=strftime('%Y-%m-%dT%H:%M:%SZ',?,'-900 seconds')
      WHERE job_id=?`).run(attempt, final && target.job.lease_id ? target.job.lease_id : `lease-seed-${attempt}`, expiry, expiry, key);
    if (final && target.job.status === "running") break;
    const publication = final && target.job.status === "published" ? target.job.publication : null;
    s.prepare(`UPDATE exploration_shared_jobs SET revision=revision+1,status=?,lease_expires_at=NULL,
      failure=?,retry_after=?,publication_json=? WHERE job_id=?`).run(publication ? "published" : "failed",
      publication ? null : final && target.job.status === "failed" ? target.job.failure : "source_unavailable",
      publication ? null : final && target.job.status === "failed" ? target.job.retry_after : "2026-10-23T12:05:00Z",
      publication ? JSON.stringify(publication) : null, key);
    if (final && (target.job.status === "failed" || target.job.status === "published")) break;
    s.prepare(`UPDATE exploration_shared_jobs SET revision=revision+1,status='queued',lease_id=NULL,lease_owner=NULL,
      lease_expires_at=NULL,retry_after=NULL,failure=NULL WHERE job_id=?`).run(key);
  }
}
function fixture(rows: StoredJob[]) {
  const binding = new SQLiteBinding();
  for (const r of rows) seed(binding, r);
  return { binding, store: new D1BridgeStore(binding), dispose: () => binding.sqlite.close() };
}
bridgeStoreConformance("D1 SQL", async rows => fixture(rows));

describe("D1 bridge integration and atomicity", () => {
  const disposers: (() => void)[] = [];
  afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); });
  function setup(rows = [row(1), row(2), row(3)]) {
    const f = fixture(rows); disposers.push(f.dispose); return f;
  }
  function deps(store: D1BridgeStore, time = NOW): BridgeDeps {
    return { store, now: () => new Date(time), newLeaseId: () => "lease-a", verifier: { verify: async () => true },
      cursorSigner: hmacCursorSigner(new Uint8Array(32).fill(17)) };
  }
  const caller = { service: "runner-a", capability: "arrival-manager:1" };
  const envelope = (kind: string, payload: unknown) => JSON.stringify({ version: 1, kind, payload });

  it("rolls back the job if operation insertion fails after a successful update", async () => {
    const { binding, store } = setup();
    await expect(store.commit(1, running(row(1)), operation({ response: null }))).rejects.toThrow();
    expect(await store.get(id(1))).toEqual(row(1));
    expect(await store.getOperation("runner-a", "claim", "op-a")).toBeNull();
    expect(binding.batches).toBe(1);
    expect(await store.commit(1, running(row(1)), operation())).toBe(true);
  });
  it("preserves audit leases but projects null terminal leases across claim, failure, retry and publication", async () => {
    const { binding, store } = setup(); const d = deps(store);
    const claim = (op: string) => claimJob(d, caller, envelope("claim", { job_id: id(1), expected_attempt: 0, operation_id: op }));
    expect(await claim("claim-one")).toMatchObject({ ok: true });
    expect((await store.get(id(1)))?.job.status).toBe("running");
    const ack = await ackJob(d, caller, envelope("ack", { job_id: id(1), attempt: 1, lease_id: "lease-a",
      operation_id: "ack-one", outcome: { status: "failed", reason: "source_unavailable" } }));
    expect(ack).toEqual({ ok: true, body: envelope("ack_result", { outcome: "accepted" }) });
    const failed = (await store.get(id(1)))!;
    expect(failed).toMatchObject({ revision: 3, lease_owner: null, job: { status: "failed", lease_id: null,
      lease_expires_at: null, retry_after: "2026-10-23T12:05:00Z" } });
    expect({ ...binding.sqlite.prepare("SELECT lease_id,lease_owner,claimed_at FROM exploration_shared_jobs WHERE job_id=?").get(id(1)) })
      .toEqual({ lease_id: "lease-a", lease_owner: "runner-a", claimed_at: NOW });
    expect(await sweepRetryDue(deps(store, "2026-10-23T12:05:00Z"))).toBe(1);
    const queued = (await store.get(id(1)))!;
    expect(queued).toMatchObject({ revision: 4, job: { status: "queued", retry_after: null } });
    const d2 = deps(store, "2026-10-23T12:05:00Z");
    await claimJob(d2, caller, envelope("claim", { job_id: id(1), expected_attempt: 1, operation_id: "claim-two" }));
    const publication = { artifact_key: id(98), request_id: id(1), validation_record_id: "validation-1",
      publication_id: "publication-1", loaded_snapshot_id: "snapshot-1", coverage_record_id: "coverage-1", loaded_at: NOW, lineage: ["lineage-1"] };
    const published = await ackJob(d2, caller, envelope("ack", { job_id: id(1), attempt: 2, lease_id: "lease-a",
      operation_id: "ack-two", outcome: { status: "published", publication } }));
    expect(published).toEqual({ ok: true, body: envelope("ack_result", { outcome: "accepted" }) });
    expect(await store.get(id(1))).toMatchObject({ revision: 6, lease_owner: null,
      job: { status: "published", lease_id: null, lease_expires_at: null, publication } });
    const raw = binding.sqlite.prepare("SELECT response_json FROM exploration_bridge_operations WHERE operation_id='ack-two'").get();
    expect(JSON.parse(raw.response_json)).toEqual({ version: 1, kind: "ack_result", payload: { outcome: "accepted" } });
    expect((await store.getOperation("runner-a", "ack", "ack-two"))?.response).toEqual({ outcome: "accepted" });
  });
  it("performs operation-free lease expiry and exhausts the third attempt", async () => {
    const { store } = setup([row(1)]);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const queued = (await store.get(id(1)))!;
      const active = running(queued);
      expect(await store.commit(queued.revision, active, null)).toBe(true);
      expect(await sweepExpiredLeases(deps(store, LATER))).toBe(1);
      const failed = (await store.get(id(1)))!;
      if (attempt < 3) expect(await sweepRetryDue(deps(store, failed.job.retry_after!))).toBe(1);
      else expect(failed.job).toMatchObject({ status: "failed", failure: "attempts_exhausted", retry_after: null, lease_id: null });
    }
  });
  it("reproduces the frozen core/schema blocker on lease recovery after a day", async () => {
    const { store } = setup([row(1)]);
    const active = running(row(1));
    expect(await store.commit(1, active, null)).toBe(true);
    // The core computes now + backoff, but 0008 caps retry_after at claim +1d.
    // This documents the stop condition; it does not establish adapter acceptance.
    await expect(sweepExpiredLeases(deps(store, "2026-10-24T12:00:00Z")))
      .rejects.toThrow("invalid exploration job state transition");
    expect(await store.get(id(1))).toEqual(active);
  });
  it("uses decoded .000Z cursor positions without skipping tied admission times", async () => {
    const { store } = setup(); const d = deps(store);
    const result = await readJobs(d, caller, envelope("read", { cursor: null, limit: 1 }));
    if (!result.ok) throw new Error(result.error);
    const first = JSON.parse(result.body).payload;
    expect(first.jobs.map((j: { job_id: string }) => j.job_id)).toEqual([id(1)]);
    const result2 = await readJobs(d, caller, envelope("read", { cursor: first.next_cursor, limit: 1 }));
    if (!result2.ok) throw new Error(result2.error);
    expect(JSON.parse(result2.body).payload.jobs.map((j: { job_id: string }) => j.job_id)).toEqual([id(2)]);
  });
  it("keeps successful operation replay protection when orphan collection deletes the finished job", async () => {
    const { binding, store } = setup([row(1)]);
    const active = running(row(1));
    // A fixed future lease keeps this orphan test independent of test-run time.
    active.job.lease_expires_at = "2099-01-01T12:15:00Z";
    expect(await store.commit(1, active, null)).toBe(true);
    // Model unlink during a live lease. Deleting the final link keeps running work.
    binding.sqlite.prepare("DELETE FROM exploration_request_links WHERE request_id=?").run(id(1));
    expect(await store.get(id(1))).not.toBeNull();
    const failed: StoredJob = { ...active, revision: 3, lease_owner: null, job: { ...active.job, status: "failed",
      lease_id: null, lease_expires_at: null, failure: "source_unavailable", retry_after: "2099-01-01T12:05:00Z" } };
    expect(await store.commit(2, failed, operation({ type: "ack", response: { outcome: "accepted" } }))).toBe(true);
    expect(await store.get(id(1))).toBeNull();
    expect((await store.getOperation("runner-a", "ack", "op-a"))?.response).toEqual({ outcome: "accepted" });
  });
  it("binds hostile lookup values and rejects unbounded limits and fractional cursor loss", async () => {
    const { store } = setup(); const hostile = "' OR 1=1 --";
    expect(await store.get(hostile)).toBeNull();
    expect(await store.getOperation(hostile, "claim", hostile)).toBeNull();
    expect(await store.listPage({ admitted_at: NOW, job_id: hostile }, 1)).toHaveLength(1);
    for (const limit of [-1, 0, 101, 1.5, Infinity, NaN]) {
      await expect(store.listPage(null, limit)).rejects.toThrow("invalid bridge page limit");
      await expect(store.listExpiredLeases(NOW, limit)).rejects.toThrow();
      await expect(store.listRetryDue(NOW, limit)).rejects.toThrow();
    }
    await expect(store.listPage({ admitted_at: "2026-10-23T12:00:00.001Z", job_id: id(1) }, 1)).rejects.toThrow();
    expect(await store.commit(1, { ...running(row(1)), revision: 3 }, operation())).toBe(false);
    expect(await store.get(id(1))).toEqual(row(1));
  });
});
