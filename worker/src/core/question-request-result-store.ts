import { requestCatalogDigest, type RequestAcceptanceSpec } from "./question-request-intent";
import type { QuestionResult, ResultStore } from "./question-request-results";

type DB = Pick<D1Database, "prepare">;
interface StoredResult {
  request_id: string; account_sub: string; request_revision: number; revision: number;
  state: QuestionResult["state"]; spec_json: string; verified_json: string | null;
  attempt: number; lease_id: string | null; lease_owner: string | null;
  lease_expires_at: string | null; created_at: string; updated_at: string;
  response_deadline: string; expires_at: string;
}

/** Server-side storage port. Authentication belongs to the calling route; every
 * mutation additionally binds the account inherited from the parent record.
 */
export class D1QuestionResultStore implements ResultStore {
  constructor(private readonly db: DB) {}
  async get(requestId: string): Promise<QuestionResult | null> {
    if (!/^[0-9a-f]{64}$/.test(requestId)) return null;
    const row = await this.db.prepare(`SELECT r.*,q.account_sub FROM question_request_results r JOIN question_requests q ON q.request_id=r.request_id WHERE r.request_id=? AND r.spec_json IS NOT NULL AND r.state IN ('confirmation_required','building','in_review','released','failed','expired')`).bind(requestId).first<StoredResult>();
    if (!row) return null;
    return {
      requestId: row.request_id, accountSub: row.account_sub, requestRevision: row.request_revision,
      revision: row.revision, state: row.state, spec: JSON.parse(row.spec_json) as RequestAcceptanceSpec,
      attempt: row.attempt, leaseId: row.lease_id, leaseOwner: row.lease_owner,
      leaseExpiresAt: row.lease_expires_at, evidence: row.verified_json === null ? null : JSON.parse(row.verified_json) as QuestionResult["evidence"],
      createdAt: row.created_at, updatedAt: row.updated_at, responseDeadline: row.response_deadline, expiresAt: row.expires_at,
    };
  }

  async compareAndSet(before: QuestionResult | null, next: QuestionResult): Promise<boolean> {
    const closing = next.state === "expired" || next.state === "failed";
    if (!/^[0-9a-f]{64}$/.test(next.requestId) || next.spec.request_id !== next.requestId || next.spec.request_revision !== next.requestRevision || !closing && next.spec.catalog_digest !== await requestCatalogDigest()) return false;
    const spec = JSON.stringify(next.spec), evidence = next.evidence === null ? null : JSON.stringify(next.evidence);
    if (before === null) {
      const result = await this.db.prepare(`INSERT INTO question_request_results(request_id,request_revision,revision,state,spec_json,verified_json,attempt,lease_id,lease_owner,lease_expires_at,created_at,updated_at,response_deadline,expires_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM question_requests q
        WHERE q.request_id=? AND q.account_sub=? AND q.revision=? AND q.expires_at=?
        AND q.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now')
        AND (SELECT snapshot_id FROM snapshots ORDER BY created_at DESC LIMIT 1)=?
        ON CONFLICT(request_id) DO NOTHING RETURNING request_id`).bind(
        next.requestId,next.requestRevision,next.revision,next.state,spec,evidence,next.attempt,next.leaseId,next.leaseOwner,next.leaseExpiresAt,next.createdAt,next.updatedAt,next.responseDeadline,next.expiresAt,
        next.requestId,next.accountSub,next.requestRevision,next.expiresAt,next.spec.data_snapshot_id,
      ).all<{ request_id: string }>();
      return result.results.length === 1;
    }
    if (before.requestId !== next.requestId || before.accountSub !== next.accountSub || next.revision !== before.revision+1 || before.requestRevision !== next.requestRevision || JSON.stringify(before.spec) !== spec) return false;
    const result = await this.db.prepare(`UPDATE question_request_results AS r SET state=?,revision=?,verified_json=?,attempt=?,lease_id=?,lease_owner=?,lease_expires_at=?,updated_at=?
      WHERE r.request_id=? AND r.revision=? AND r.request_revision=? AND r.spec_json=?
      AND EXISTS(SELECT 1 FROM question_requests q WHERE q.request_id=r.request_id AND q.account_sub=? AND q.revision=? AND q.expires_at=? AND (?=1 OR q.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now')))
      AND (?=1 OR (SELECT snapshot_id FROM snapshots ORDER BY created_at DESC LIMIT 1)=?)
      AND (r.state!='confirmation_required' OR ?!='building' OR r.response_deadline>strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      AND (?!='released' OR r.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      RETURNING request_id`).bind(
      next.state,next.revision,evidence,next.attempt,next.leaseId,next.leaseOwner,next.leaseExpiresAt,next.updatedAt,
      next.requestId,before.revision,next.requestRevision,JSON.stringify(before.spec),
      next.accountSub,next.requestRevision,next.expiresAt,closing?1:0,closing?1:0,next.spec.data_snapshot_id,next.state,next.state,
    ).all<{ request_id: string }>();
    return result.results.length === 1;
  }
}
