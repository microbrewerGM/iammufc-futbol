import { LEASE_SECONDS } from "./exploration-bridge";
import type { BridgeStore, Job, OperationRecord, PagePosition, StoredJob } from "./exploration-bridge";

interface JobRow {
  job_id: string; request_json: string; status: Job["status"]; attempt: number;
  lease_id: string | null; lease_owner: string | null; lease_expires_at: string | null;
  retry_after: string | null; failure: Job["failure"]; publication_json: string | null;
  admitted_at: string; revision: number;
}
interface OperationRow {
  service: string; operation_type: OperationRecord["type"]; operation_id: string;
  body_hash: string; response_json: string; lease_id: string | null;
}
const SELECT_JOB = `SELECT j.job_id, r.request_json, j.status, j.attempt,
  j.lease_id, j.lease_owner, j.lease_expires_at, j.retry_after, j.failure,
  j.publication_json, j.admitted_at, j.revision
  FROM exploration_shared_jobs j JOIN exploration_shared_requests r ON r.request_id = j.request_id`;
const ORDER = " ORDER BY j.admitted_at, j.job_id LIMIT ?";
function project(row: JobRow): StoredJob {
  const running = row.status === "running";
  return { admitted_at: row.admitted_at, revision: row.revision,
    lease_owner: running ? row.lease_owner : null,
    job: { job_id: row.job_id, request: JSON.parse(row.request_json), status: row.status,
      attempt: row.attempt, lease_id: running ? row.lease_id : null,
      lease_expires_at: running ? row.lease_expires_at : null, retry_after: row.retry_after,
      failure: row.failure, publication: row.publication_json === null ? null : JSON.parse(row.publication_json) } };
}
function bounded(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("invalid bridge page limit");
  return limit;
}
// Cursors decode to ISO with .000Z, whereas 0008 stores whole UTC seconds.
// Compare the same representation; reject precision loss instead of truncating.
function seconds(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() % 1000 !== 0) throw new RangeError("invalid bridge time");
  return date.toISOString().replace(".000Z", "Z");
}

/** Storage only: admission, authentication, sweeps and publication verification
 * remain with their existing owners. No account/history tables are accessed. */
export class D1BridgeStore implements BridgeStore {
  constructor(private readonly db: Pick<D1Database, "prepare" | "batch">) {}

  async get(jobId: string): Promise<StoredJob | null> {
    const row = await this.db.prepare(SELECT_JOB + " WHERE j.job_id = ?").bind(jobId).first<JobRow>();
    return row === null ? null : project(row);
  }
  private async rows(sql: string, values: unknown[]): Promise<StoredJob[]> {
    const result = await this.db.prepare(SELECT_JOB + sql + ORDER).bind(...values).all<JobRow>();
    return result.results.map(project);
  }
  async listPage(after: PagePosition | null, limit: number): Promise<StoredJob[]> {
    const size = bounded(limit);
    if (after === null) return this.rows("", [size]);
    const time = seconds(after.admitted_at);
    return this.rows(" WHERE (j.admitted_at > ? OR (j.admitted_at = ? AND j.job_id > ?))",
      [time, time, after.job_id, size]);
  }
  async listExpiredLeases(now: string, limit: number): Promise<StoredJob[]> {
    return this.rows(" WHERE j.status = 'running' AND j.lease_expires_at <= ?", [seconds(now), bounded(limit)]);
  }
  async listRetryDue(now: string, limit: number): Promise<StoredJob[]> {
    return this.rows(" WHERE j.status = 'failed' AND j.failure != 'attempts_exhausted' AND j.retry_after <= ?",
      [seconds(now), bounded(limit)]);
  }
  async getOperation(service: string, type: OperationRecord["type"], operationId: string): Promise<OperationRecord | null> {
    const row = await this.db.prepare(`SELECT service, operation_type, operation_id, body_hash, response_json, lease_id
      FROM exploration_bridge_operations WHERE service = ? AND operation_type = ? AND operation_id = ?`)
      .bind(service, type, operationId).first<OperationRow>();
    if (row === null) return null;
    // 0008 persists a closed envelope; the core port stores its payload only.
    const envelope = JSON.parse(row.response_json) as { payload: unknown };
    return { service: row.service, type: row.operation_type, operation_id: row.operation_id,
      body_hash: row.body_hash, response: envelope.payload, lease_id: row.lease_id };
  }
  async commit(expectedRevision: number, next: StoredJob, operation: OperationRecord | null): Promise<boolean> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || next.revision !== expectedRevision + 1) return false;
    const job = next.job;
    const terminal = job.status === "failed" || job.status === "published";
    // Terminal rows retain their prior lease as audit/fencing data in SQL. The
    // port projects it to null. A new running claim derives its claimed_at from
    // the core's frozen 900-second lease, without sampling another clock.
    let sql = `UPDATE exploration_shared_jobs SET status = ?, attempt = ?, revision = ?,
      lease_id = CASE WHEN ? THEN lease_id ELSE ? END,
      lease_owner = CASE WHEN ? THEN lease_owner ELSE ? END,
      lease_expires_at = ?,
      claimed_at = CASE WHEN ? = 'running' THEN strftime('%Y-%m-%dT%H:%M:%SZ', ?, '-${LEASE_SECONDS} seconds') ELSE claimed_at END,
      retry_after = ?, failure = ?, publication_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE job_id = ? AND revision = ? AND admitted_at = ?`;
    const values: unknown[] = [job.status, job.attempt, next.revision, Number(terminal), job.lease_id,
      Number(terminal), next.lease_owner, job.lease_expires_at, job.status, job.lease_expires_at,
      job.retry_after, job.failure, job.publication === null ? null : JSON.stringify(job.publication),
      job.job_id, expectedRevision, next.admitted_at];
    if (operation !== null) {
      sql += ` AND NOT EXISTS (SELECT 1 FROM exploration_bridge_operations
        WHERE service = ? AND operation_type = ? AND operation_id = ?)`;
      values.push(operation.service, operation.type, operation.operation_id);
    }
    // RETURNING reports the directly matched job even when AFTER triggers also
    // collect an orphan. D1 meta.changes includes trigger/FK side effects.
    const statements = [this.db.prepare(sql + " RETURNING job_id").bind(...values)];
    if (operation !== null) {
      statements.push(this.db.prepare(`INSERT INTO exploration_bridge_operations
        (service, scope_key, operation_type, operation_id, body_hash, response_json, lease_id, created_at, expires_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
          strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+30 days') WHERE changes() = 1`)
        .bind(operation.service, operation.service, operation.type, operation.operation_id, operation.body_hash,
          JSON.stringify({ version: 1, kind: `${operation.type}_result`, payload: operation.response }), operation.lease_id));
    }
    // D1 batch is transactional: a rejected operation insert rolls back its job
    // update. changes() binds the insert to THIS update, including the no-op case.
    // Storage errors propagate; they must never be reported as a successful CAS.
    const result = await this.db.batch(statements);
    return result[0]!.results.length === 1;
  }
}
