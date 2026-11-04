import type {Env} from "./db";
import {validAccountSub,validQuestionText} from "./question-requests";

export async function clarificationSchemaReady(env:Env):Promise<boolean>{
  const objects=await env.DB.prepare("SELECT name FROM sqlite_master WHERE (type='table' AND name IN ('question_request_results','question_request_clarifications')) OR (type='trigger' AND name IN ('question_request_clarifications_insert','question_request_clarifications_update','question_request_clarifications_no_replace','question_request_clarifications_retention','question_requests_clarification_state_machine','question_requests_clarification_clock_update','question_request_results_generation_transition','question_request_results_spec_update','question_requests_state_machine','question_requests_clock_update','question_request_results_transition'))").all<{name:string}>();
  const expected=new Set(['question_request_results','question_request_clarifications','question_request_clarifications_insert','question_request_clarifications_update','question_request_clarifications_no_replace','question_request_clarifications_retention','question_requests_clarification_state_machine','question_requests_clarification_clock_update','question_request_results_generation_transition','question_request_results_spec_update']);
  return objects.results.length===expected.size && objects.results.every(row=>expected.has(row.name));
}
interface ClarificationRow{
  parent_revision:number;parent_status:string;request_revision:number;revision:number;
  state:string;clarification_count:number;response_deadline:string;expires_at:string;db_now:string;
}
export type ClarificationOutcome="accepted"|"conflict"|"not_found"|"unavailable";

/** Original text/hash/identity and retention never change. All replacement text
 * stays in bound private D1 parameters. No model/notification input is emitted.
 */
export async function clarifyQuestionResult(env:Env,account:string,id:string,revision:number,input:unknown):Promise<ClarificationOutcome>{
  const text=validQuestionText(input);
  if(!validAccountSub(account) || id.length!==64 || !/^[0-9a-f]{64}$/.test(id) || !Number.isSafeInteger(revision) || revision<1 || text===null)return "conflict";
  try{
    if(!await clarificationSchemaReady(env))return "unavailable";
    const row=await env.DB.prepare(`SELECT q.revision AS parent_revision,q.status AS parent_status,r.request_revision,r.revision,r.state,r.clarification_count,r.response_deadline,q.expires_at,
      strftime('%Y-%m-%dT%H:%M:%SZ','now') AS db_now FROM question_requests q JOIN question_request_results r ON r.request_id=q.request_id
      WHERE q.request_id=? AND q.account_sub=?`).bind(id,account).first<ClarificationRow>();
    if(!row)return "not_found";
    if(row.revision!==revision || row.state!=="clarification_required" || row.clarification_count>=3 || row.response_deadline<=row.db_now || row.expires_at<=row.db_now
      || row.request_revision!==row.parent_revision || !["filled","partial","no_data"].includes(row.parent_status))return "conflict";
    const nextParent=row.parent_revision+1,generation=row.clarification_count+1,now=row.db_now;
    const parent=env.DB.prepare(`UPDATE question_requests AS q SET status='received',attempt=0,verdict_json=NULL,exploration_request_id=NULL,
      lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,claimed_at=NULL,retry_after=NULL,updated_at=?,revision=revision+1
      WHERE q.request_id=? AND q.account_sub=? AND q.revision=? AND q.status IN ('filled','partial','no_data')
      AND q.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now')
      AND EXISTS(SELECT 1 FROM question_request_results r WHERE r.request_id=q.request_id AND r.revision=? AND r.request_revision=q.revision
        AND r.state='clarification_required' AND r.clarification_count<3 AND r.response_deadline>strftime('%Y-%m-%dT%H:%M:%SZ','now')
        AND (r.clarification_count=0 OR EXISTS(SELECT 1 FROM question_request_clarifications c WHERE c.request_id=r.request_id AND c.generation=r.clarification_count))) RETURNING request_id`)
      .bind(now,id,account,row.parent_revision,revision);
    const replace=env.DB.prepare(`UPDATE question_request_clarifications SET generation=?,parent_revision=?,text=?,submitted_at=?
      WHERE changes()=1 AND request_id=? AND generation=? RETURNING request_id`).bind(generation,nextParent,text,now,id,row.clarification_count);
    const initial=env.DB.prepare(`INSERT INTO question_request_clarifications(request_id,generation,parent_revision,text,submitted_at)
      SELECT ?,?,?,?,? WHERE ?=0 AND NOT EXISTS(SELECT 1 FROM question_request_clarifications WHERE request_id=?)
      AND EXISTS(SELECT 1 FROM question_requests q JOIN question_request_results r ON r.request_id=q.request_id
        WHERE q.request_id=? AND q.account_sub=? AND q.revision=? AND q.status='received' AND q.updated_at=?
        AND r.revision=? AND r.state='clarification_required' AND r.clarification_count=0) RETURNING request_id`)
      .bind(id,generation,nextParent,text,now,row.clarification_count,id,id,account,nextParent,now,revision);
    const result=env.DB.prepare(`UPDATE question_request_results AS r SET state='triaging',request_revision=?,clarification_count=clarification_count+1,
      spec_json=NULL,verified_json=NULL,attempt=0,lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=?,
      response_deadline=min(expires_at,strftime('%Y-%m-%dT%H:%M:%SZ',?,'+1 day')),revision=revision+1
      WHERE r.request_id=? AND r.revision=? AND r.clarification_count=? AND r.state='clarification_required'
      AND r.response_deadline>strftime('%Y-%m-%dT%H:%M:%SZ','now')
      AND EXISTS(SELECT 1 FROM question_requests q WHERE q.request_id=r.request_id AND q.account_sub=? AND q.revision=? AND q.status='received' AND q.updated_at=?)
      AND EXISTS(SELECT 1 FROM question_request_clarifications c WHERE c.request_id=r.request_id AND c.generation=? AND c.parent_revision=? AND c.submitted_at=? AND c.text=?) RETURNING request_id`)
      .bind(nextParent,now,now,id,revision,row.clarification_count,account,nextParent,now,generation,nextParent,now,text);
    // A zero-change successor must roll back a successful parent reset. This
    // deliberately invalid no-op revision invokes the existing state guard;
    // a losing/duplicate parent CAS cannot match the still-old sidecar here.
    const assertContinuation=env.DB.prepare(`UPDATE question_requests AS q SET revision=revision WHERE q.request_id=? AND q.account_sub=?
      AND q.revision=? AND q.status='received' AND EXISTS(SELECT 1 FROM question_request_results r WHERE r.request_id=q.request_id AND r.revision=? AND r.state='clarification_required') RETURNING request_id`)
      .bind(id,account,nextParent,revision);
    const writes=await env.DB.batch<{request_id:string}>([parent,replace,initial,result,assertContinuation]);
    return writes[0]!.results.length===1 && writes[3]!.results.length===1 ? "accepted" : "conflict";
  }catch{return "unavailable";}
}
