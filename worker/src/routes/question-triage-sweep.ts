import { sweepQuestions, type TriageDeps, type TriageOperation, type TriageQuestion, type TriageStore } from "../core/question-triage-bridge";

type DB = Pick<D1Database, "prepare" | "batch">;
type OpRow = { service: string; operation_type: "claim" | "ack"; operation_id: string; body_hash: string; response_json: string; lease_id: string | null };
const SELECT = `SELECT request_id, locale, text, account_sub, status, attempt, lease_id, lease_owner, lease_expires_at, retry_after, revision, claimed_at, verdict_json, exploration_request_id FROM question_requests`;
type SweepKind = "expired" | "triaged" | "queued";
let lastSweepAt: number | null = null;
let nextSweep: SweepKind = "expired";
const NEXT: Record<SweepKind, SweepKind> = { expired: "triaged", triaged: "queued", queued: "expired" };
export async function sweepQuestionBeforeRequest(deps: TriageDeps): Promise<boolean> {
  const now = deps.now().getTime(); if (lastSweepAt !== null && now - lastSweepAt < 60_000) return true;
  const kind = nextSweep; lastSweepAt = now; nextSweep = NEXT[kind];
  try { await sweepQuestions(deps, 100, kind); return true; } catch { return false; }
}
export function resetQuestionSweepForTest(): void { lastSweepAt = null; nextSweep = "expired"; }
function operationFrom(row: OpRow | null): TriageOperation | null { if (!row) return null; const env = JSON.parse(row.response_json) as { payload: unknown }; return { service: row.service, type: row.operation_type, operation_id: row.operation_id, body_hash: row.body_hash, response: env.payload, lease_id: row.lease_id }; }
export class D1QuestionTriageStore implements TriageStore {
  constructor(private readonly db: DB) {}
  async page(after: string | null, limit: number): Promise<TriageQuestion[]> {
    const stmt = after === null ? this.db.prepare(`${SELECT} WHERE status='received' AND (retry_after IS NULL OR retry_after <= strftime('%Y-%m-%dT%H:%M:%SZ','now')) ORDER BY request_id LIMIT ?`).bind(limit)
      : this.db.prepare(`${SELECT} WHERE status='received' AND (retry_after IS NULL OR retry_after <= strftime('%Y-%m-%dT%H:%M:%SZ','now')) AND request_id > ? ORDER BY request_id LIMIT ?`).bind(after, limit);
    return (await stmt.all<TriageQuestion>()).results;
  }
  async get(id: string): Promise<TriageQuestion | null> { return this.db.prepare(`${SELECT} WHERE request_id=?`).bind(id).first<TriageQuestion>(); }
  async operation(service: string, type: "claim" | "ack", id: string): Promise<TriageOperation | null> { return operationFrom(await this.db.prepare(`SELECT service,operation_type,operation_id,body_hash,response_json,lease_id FROM exploration_bridge_operations WHERE service=? AND operation_type=? AND operation_id=? AND expires_at > strftime('%Y-%m-%dT%H:%M:%SZ','now')`).bind(service,type,id).first<OpRow>()); }
  async claim(row: TriageQuestion, next: TriageQuestion, op: TriageOperation): Promise<boolean> {
    const update = this.db.prepare(`UPDATE question_requests SET status=?, attempt=?, lease_id=?, lease_owner=?, lease_expires_at=?, claimed_at=?, retry_after=NULL, revision=?, updated_at=max(updated_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')) WHERE request_id=? AND status=? AND revision=? AND attempt=? AND (retry_after IS NULL OR retry_after<=?) AND NOT EXISTS (SELECT 1 FROM exploration_bridge_operations WHERE service=? AND operation_type='claim' AND operation_id=?) RETURNING request_id`).bind(next.status,next.attempt,next.lease_id,next.lease_owner,next.lease_expires_at,next.claimed_at,next.revision,row.request_id,row.status,row.revision,row.attempt,next.claimed_at!,op.service,op.operation_id);
    const result = await this.db.batch([update, this.db.prepare(`INSERT INTO exploration_bridge_operations(service,scope_key,operation_type,operation_id,body_hash,response_json,lease_id,created_at,expires_at) SELECT ?,?,'claim',?,?,?,?,strftime('%Y-%m-%dT%H:%M:%SZ','now'),strftime('%Y-%m-%dT%H:%M:%SZ','now','+30 days') WHERE changes()=1`).bind(op.service,op.service,op.operation_id,op.body_hash,JSON.stringify({version:1,kind:"claim_result",payload:op.response}),op.lease_id)]);
    return result[0]!.results.length === 1;
  }
  async ack(row: TriageQuestion, next: TriageQuestion, op: TriageOperation, admission: { requestId: string; requestJson: string; jobId: string; accountSub: string; createdAt: string } | null): Promise<boolean> {
    const stmts: D1PreparedStatement[] = [];
    if (["queued", "filled", "partial", "no_data"].includes(next.status)) {
      stmts.push(this.db.prepare(`UPDATE question_requests SET status='triaged', verdict_json=?, lease_expires_at=NULL, retry_after=NULL, revision=?, updated_at=max(updated_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')) WHERE request_id=? AND status='triaging' AND revision=? AND attempt=? AND lease_id=? AND lease_owner=? AND NOT EXISTS (SELECT 1 FROM exploration_bridge_operations WHERE service=? AND operation_type='ack' AND operation_id=?) RETURNING request_id`).bind(next.verdict_json,row.revision + 1,row.request_id,row.revision,row.attempt,row.lease_id,row.lease_owner,op.service,op.operation_id));
      stmts.push(this.db.prepare(`UPDATE question_requests SET status=?, exploration_request_id=?, revision=?, updated_at=max(updated_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')) WHERE request_id=? AND status='triaged' AND revision=? AND attempt=? AND lease_id=? AND lease_owner=? RETURNING request_id`).bind(next.status,next.exploration_request_id,next.revision,row.request_id,row.revision + 1,row.attempt,row.lease_id,row.lease_owner));
    } else {
      stmts.push(this.db.prepare(`UPDATE question_requests SET status=?, verdict_json=?, exploration_request_id=?, lease_expires_at=NULL, retry_after=?, revision=?, updated_at=max(updated_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')) WHERE request_id=? AND status='triaging' AND revision=? AND attempt=? AND lease_id=? AND lease_owner=? AND NOT EXISTS (SELECT 1 FROM exploration_bridge_operations WHERE service=? AND operation_type='ack' AND operation_id=?) RETURNING request_id`).bind(next.status,next.verdict_json,next.exploration_request_id,next.retry_after,next.revision,row.request_id,row.revision,row.attempt,row.lease_id,row.lease_owner,op.service,op.operation_id));
    }
    stmts.push(this.db.prepare(`INSERT INTO exploration_bridge_operations(service,scope_key,operation_type,operation_id,body_hash,response_json,lease_id,created_at,expires_at) SELECT ?,?,'ack',?,?,?,?,strftime('%Y-%m-%dT%H:%M:%SZ','now'),strftime('%Y-%m-%dT%H:%M:%SZ','now','+30 days') WHERE changes()=1`).bind(op.service,op.service,op.operation_id,op.body_hash,JSON.stringify({version:1,kind:"ack_result",payload:op.response}),op.lease_id));
    if (admission) {
      stmts.push(this.db.prepare(`INSERT INTO exploration_shared_requests(request_id,contract_version,request_json,created_at) SELECT ?,1,?,? WHERE changes()=1 ON CONFLICT(request_id) DO NOTHING`).bind(admission.requestId,admission.requestJson,admission.createdAt));
      stmts.push(this.db.prepare(`INSERT INTO exploration_request_links(request_id,account_sub,created_at,expires_at) SELECT ?,?,?,strftime('%Y-%m-%dT%H:%M:%SZ',?,'+90 days') WHERE EXISTS (SELECT 1 FROM question_requests WHERE request_id=? AND status='queued' AND exploration_request_id=?) ON CONFLICT(request_id,account_sub) DO NOTHING`).bind(admission.requestId,admission.accountSub,admission.createdAt,admission.createdAt,row.request_id,admission.requestId));
      stmts.push(this.db.prepare(`INSERT INTO exploration_shared_jobs(job_id,request_id,status,attempt,admitted_at,created_at,updated_at,expires_at) SELECT ?,?,'queued',0,?,?,?,strftime('%Y-%m-%dT%H:%M:%SZ',?,'+30 days') WHERE EXISTS (SELECT 1 FROM exploration_request_links WHERE request_id=? AND account_sub=?) ON CONFLICT(job_id) DO NOTHING`).bind(admission.jobId,admission.requestId,admission.createdAt,admission.createdAt,admission.createdAt,admission.createdAt,admission.requestId,admission.accountSub));
    }
    const result = await this.db.batch(stmts); return result[0]!.results.length === 1;
  }
  async sweepRows(kind: "expired" | "triaged" | "queued", now: string, limit: number): Promise<TriageQuestion[]> {
    const where = kind === "expired" ? `status='triaging' AND lease_expires_at<=?` : kind === "triaged" ? `status='triaged'` : `status='queued'`;
    return (await this.db.prepare(`${SELECT} WHERE ${where} ORDER BY updated_at,request_id LIMIT ?`).bind(...(kind === "expired" ? [now,limit] : [limit])).all<TriageQuestion>()).results;
  }
  async settle(row: TriageQuestion, next: TriageQuestion): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE question_requests SET status=?, lease_expires_at=?, retry_after=?, revision=?, updated_at=max(updated_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')) WHERE request_id=? AND status=? AND revision=? AND lease_id IS ? AND lease_owner IS ? RETURNING request_id`).bind(next.status,next.lease_expires_at,next.retry_after,next.revision,row.request_id,row.status,row.revision,row.lease_id,row.lease_owner).all();
    return result.results.length === 1;
  }
  async queueResult(row: TriageQuestion): Promise<"complete" | "partial" | "missing" | "failed" | "pending"> {
    const result = await this.db.prepare(`SELECT j.status AS job_status,j.failure,r.coverage,r.expires_at FROM exploration_shared_jobs j LEFT JOIN exploration_shared_results r ON r.request_id=j.request_id WHERE j.request_id=?`).bind(row.exploration_request_id).first<{job_status:string;failure:string|null;coverage:string|null;expires_at:string|null}>();
    if (!result) return "missing"; if (result.job_status === "published") { if (!result.coverage || !result.expires_at || result.expires_at <= new Date().toISOString().replace(/\.\d{3}Z$/, "Z")) return "missing"; return result.coverage === "complete" ? "complete" : result.coverage === "partial" ? "partial" : "missing"; } if (result.job_status === "failed" && result.failure === "attempts_exhausted") return "failed"; return "pending";
  }
}
