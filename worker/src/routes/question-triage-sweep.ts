import { parseTriageReceipt,sweepQuestions,type AnswerNowDraft,type TriageDeps,type TriageOperation,type TriageQuestion,type TriageStore } from "../core/question-triage-bridge";
import {requestCatalogDigest} from "../core/question-request-intent";
import {RENDERER_VERSION,TRANSFORM_CODE_VERSION} from "../core/intent";

type DB=Pick<D1Database,"prepare"|"batch">;
type OpRow={service:string;operation_type:"claim"|"ack";operation_id:string;body_hash:string;response_json:string;lease_id:string|null};
const SELECT=`SELECT q.request_id,q.locale,
  CASE WHEN c.generation=r.clarification_count AND c.parent_revision=r.request_revision THEN c.text ELSE q.text END AS text,
  q.account_sub,q.status,q.attempt,q.lease_id,q.lease_owner,q.lease_expires_at,q.retry_after,q.revision,q.claimed_at,q.verdict_json,q.exploration_request_id,q.expires_at,
  (r.request_id IS NOT NULL) AS managed,coalesce(r.clarification_count,0) AS generation,coalesce(r.revision,0) AS result_revision,
  r.state AS result_state,r.response_deadline,
  CASE WHEN c.generation=r.clarification_count AND c.parent_revision=r.request_revision THEN 1 ELSE 0 END AS clarification_valid
  FROM question_requests q LEFT JOIN question_request_results r ON r.request_id=q.request_id
  LEFT JOIN question_request_clarifications c ON c.request_id=r.request_id`;
const V1_SCOPE="NOT EXISTS(SELECT 1 FROM question_request_results r WHERE r.request_id=q.request_id) AND (q.lease_id IS NULL OR substr(q.lease_id,1,3)!='q2:')";
const V2_SCOPE=`(q.status!='triaging' OR substr(q.lease_id,1,3)='q2:') AND (NOT EXISTS(SELECT 1 FROM question_request_results r WHERE r.request_id=q.request_id)
  OR EXISTS(SELECT 1 FROM question_request_results r JOIN question_request_clarifications c ON c.request_id=r.request_id
    WHERE r.request_id=q.request_id AND r.state='triaging' AND r.clarification_count BETWEEN 1 AND 3
    AND c.generation=r.clarification_count AND c.parent_revision=r.request_revision AND q.revision>=r.request_revision
    AND r.response_deadline>strftime('%Y-%m-%dT%H:%M:%SZ','now')))`;
type SweepKind="expired"|"triaged"|"queued";
const lastSweepAt:Record<1|2,number|null>={1:null,2:null};
const nextSweep:Record<1|2,SweepKind>={1:"expired",2:"expired"};
let queuedSweepCursor:string|null=null;
const NEXT:Record<SweepKind,SweepKind>={expired:"triaged",triaged:"queued",queued:"expired"};
export async function sweepQuestionBeforeRequest(deps:TriageDeps):Promise<boolean>{
  const protocol=deps.protocol ?? 1,now=deps.now().getTime();
  if(lastSweepAt[protocol]!==null && now-lastSweepAt[protocol]!<60_000)return true;
  const kind=protocol===2?"expired":nextSweep[protocol];lastSweepAt[protocol]=now;nextSweep[protocol]=NEXT[kind];
  try{await sweepQuestions(deps,100,kind);return true;}catch{return false;}
}
export function resetQuestionSweepForTest():void{lastSweepAt[1]=null;lastSweepAt[2]=null;nextSweep[1]="expired";nextSweep[2]="expired";queuedSweepCursor=null;}
function safeReceiptResult(receipt:NonNullable<TriageOperation["receipt"]>,type:"claim"|"ack",value:unknown):boolean{
  if(!value || typeof value!=="object" || Array.isArray(value))return false;
  const result=value as Record<string,unknown>;
  if(type==="ack")return Object.keys(result).length===4 && result.outcome==="accepted"
    && ["received","triage_failed","junk","filled","partial","no_data"].includes(String(result.status))
    && result.revision===receipt.applied_revision && result.generation===receipt.generation;
  if(Object.keys(result).length!==2 || result.outcome!=="claimed" || !result.question || typeof result.question!=="object" || Array.isArray(result.question))return false;
  const question=result.question as Record<string,unknown>;
  return Object.keys(question).length===7 && ["request_id","locale","attempt","lease_id","lease_expires_at","revision","generation"].every(k=>Object.hasOwn(question,k))
    && question.request_id===receipt.request_id && ["en","es"].includes(String(question.locale))
    && Number.isInteger(question.attempt) && Number(question.attempt)>=1 && Number(question.attempt)<=3
    && question.lease_id===receipt.lease_id && typeof question.lease_expires_at==="string" && Number.isFinite(Date.parse(question.lease_expires_at))
    && question.revision===receipt.applied_revision && question.generation===receipt.generation;
}
function operationFrom(row:OpRow|null):TriageOperation|null{
  if(!row)return null;
  const env=JSON.parse(row.response_json) as {payload:unknown};
  let response=env.payload,receipt:TriageOperation["receipt"];
  if(response && typeof response==="object" && Object.hasOwn(response,"receipt")){
    const payload=response as Record<string,unknown>;receipt=parseTriageReceipt(payload.receipt) ?? undefined;
    if(!receipt || Object.keys(payload).length!==2 || !Object.hasOwn(payload,"result")
      || row.operation_type==="claim" && receipt.applied_revision!==receipt.input_revision+1
      || !safeReceiptResult(receipt,row.operation_type,payload.result))throw new Error("invalid triage receipt");
    response=payload.result;
  }
  return {service:row.service,type:row.operation_type,operation_id:row.operation_id,body_hash:row.body_hash,response,lease_id:row.lease_id,...(receipt?{receipt}:{})};
}
function operationJSON(op:TriageOperation):string{
  return JSON.stringify({version:1,kind:op.type+"_result",payload:op.receipt?{receipt:op.receipt,result:op.response}:op.response});
}
export class D1QuestionTriageStore implements TriageStore{
  constructor(private readonly db:DB,private readonly protocol:1|2=1){}
  private scope():string{return this.protocol===2?V2_SCOPE:V1_SCOPE;}
  private fence():string{return this.scope()+(this.protocol===2?` AND coalesce((SELECT clarification_count FROM question_request_results WHERE request_id=q.request_id),0)=?
    AND coalesce((SELECT revision FROM question_request_results WHERE request_id=q.request_id),0)=?`:"");}
  private fenceValues(row:TriageQuestion):unknown[]{return this.protocol===2?[row.generation ?? 0,row.result_revision ?? 0]:[];}
  async page(after:string|null,limit:number):Promise<TriageQuestion[]>{
    return (await this.db.prepare(`${SELECT} WHERE q.status='received' AND q.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now')
      AND (q.retry_after IS NULL OR q.retry_after<=strftime('%Y-%m-%dT%H:%M:%SZ','now')) AND ${this.scope()}
      AND (? IS NULL OR q.request_id>?) ORDER BY q.request_id LIMIT ?`).bind(after,after,limit).all<TriageQuestion>()).results;
  }
  async get(id:string):Promise<TriageQuestion|null>{return this.db.prepare(`${SELECT} WHERE q.request_id=?${this.protocol===1?" AND "+V1_SCOPE:""}`).bind(id).first<TriageQuestion>();}
  async operation(service:string,type:"claim"|"ack",id:string,requestId:string):Promise<TriageOperation|null>{
    const scope=this.protocol===1?`EXISTS(SELECT 1 FROM question_requests q WHERE q.request_id=? AND ${V1_SCOPE})`:
      `EXISTS(SELECT 1 FROM question_requests q LEFT JOIN question_request_results r ON r.request_id=q.request_id
        WHERE q.request_id=? AND q.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now')
        AND json_extract(o.response_json,'$.payload.receipt.protocol')=2
        AND json_extract(o.response_json,'$.payload.receipt.request_id')=q.request_id
        AND json_extract(o.response_json,'$.payload.receipt.generation')=coalesce(r.clarification_count,0)
        AND json_extract(o.response_json,'$.payload.receipt.applied_revision')=q.revision
        AND (o.operation_type!='claim' OR q.status='triaging' AND q.lease_id=o.lease_id AND q.lease_owner=o.service
          AND q.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now') AND ${V2_SCOPE}))`;
    return operationFrom(await this.db.prepare(`SELECT o.service,o.operation_type,o.operation_id,o.body_hash,o.response_json,o.lease_id FROM exploration_bridge_operations o
      WHERE o.service=? AND o.operation_type=? AND o.operation_id=? AND o.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now') AND ${scope}`)
      .bind(service,type,id,requestId).first<OpRow>());
  }
  private receipt(op:TriageOperation):D1PreparedStatement{
    return this.db.prepare(`INSERT INTO exploration_bridge_operations(service,scope_key,operation_type,operation_id,body_hash,response_json,lease_id,created_at,expires_at)
      SELECT ?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%SZ','now'),strftime('%Y-%m-%dT%H:%M:%SZ','now','+30 days') WHERE changes()=1`)
      .bind(op.service,op.service,op.type,op.operation_id,op.body_hash,operationJSON(op),op.lease_id);
  }
  async claim(row:TriageQuestion,next:TriageQuestion,op:TriageOperation):Promise<boolean>{
    const update=this.db.prepare(`UPDATE question_requests AS q SET status=?,attempt=?,lease_id=?,lease_owner=?,lease_expires_at=?,claimed_at=?,retry_after=NULL,revision=?,
      updated_at=max(updated_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')) WHERE q.request_id=? AND q.status=? AND q.revision=? AND q.attempt=?
      AND q.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now') AND (q.retry_after IS NULL OR q.retry_after<=?)
      AND ?>strftime('%Y-%m-%dT%H:%M:%SZ','now') AND ?<=strftime('%Y-%m-%dT%H:%M:%SZ','now','+900 seconds')
      AND NOT EXISTS(SELECT 1 FROM exploration_bridge_operations WHERE service=? AND operation_type='claim' AND operation_id=?)
      AND ${this.fence()} RETURNING request_id`).bind(next.status,next.attempt,next.lease_id,next.lease_owner,next.lease_expires_at,next.claimed_at,next.revision,
      row.request_id,row.status,row.revision,row.attempt,next.claimed_at,next.lease_expires_at,next.lease_expires_at,op.service,op.operation_id,...this.fenceValues(row));
    const result=await this.db.batch([update,this.receipt(op)]);return result[0]!.results.length===1;
  }
  private remap(row:TriageQuestion,next:TriageQuestion,draft:AnswerNowDraft,now:string):D1PreparedStatement{
    if(row.managed)return this.db.prepare(`UPDATE question_request_results SET request_revision=?,state=?,spec_json=?,verified_json=NULL,
      attempt=0,lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=?,response_deadline=min(expires_at,strftime('%Y-%m-%dT%H:%M:%SZ',?,'+1 day')),revision=revision+1
      WHERE changes()=1 AND request_id=? AND revision=? AND clarification_count=? AND state='triaging'
      AND EXISTS(SELECT 1 FROM question_requests q WHERE q.request_id=question_request_results.request_id AND q.revision=? AND q.status=?) RETURNING request_id`)
      .bind(next.revision,draft.state,draft.specJson,now,now,row.request_id,row.result_revision,row.generation,next.revision,next.status);
    return this.db.prepare(`INSERT INTO question_request_results(request_id,request_revision,state,spec_json,created_at,updated_at,response_deadline,expires_at)
      SELECT request_id,revision,?,?,?,?,min(expires_at,strftime('%Y-%m-%dT%H:%M:%SZ',?,'+1 day')),expires_at FROM question_requests
      WHERE changes()=1 AND request_id=? AND revision=? AND status=? RETURNING request_id`)
      .bind(draft.state,draft.specJson,now,now,now,row.request_id,next.revision,next.status);
  }
  async ack(row:TriageQuestion,next:TriageQuestion,op:TriageOperation,admission:{requestId:string;requestJson:string;jobId:string;accountSub:string;createdAt:string}|null,
    now:string,answerNow?:AnswerNowDraft):Promise<boolean>{
    const stmts:D1PreparedStatement[]=[];
    const snapshot=answerNow?` AND (? IS NULL OR (SELECT snapshot_id FROM snapshots ORDER BY created_at DESC LIMIT 1)=?)`:"";
    const snapshotValues=answerNow?[answerNow.snapshotId,answerNow.snapshotId]:[];
    if(["queued","filled","partial","no_data"].includes(next.status)){
      stmts.push(this.db.prepare(`UPDATE question_requests AS q SET status='triaged',verdict_json=?,lease_expires_at=NULL,retry_after=NULL,revision=?,
        updated_at=max(updated_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')) WHERE q.request_id=? AND q.status='triaging' AND q.revision=? AND q.attempt=?
        AND q.lease_id=? AND q.lease_owner=? AND q.lease_expires_at>? AND q.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now')
        AND q.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now')
        AND NOT EXISTS(SELECT 1 FROM exploration_bridge_operations WHERE service=? AND operation_type='ack' AND operation_id=?)
        AND ${this.fence()}${snapshot} RETURNING request_id`).bind(next.verdict_json,row.revision+1,row.request_id,row.revision,row.attempt,row.lease_id,row.lease_owner,now,
        op.service,op.operation_id,...this.fenceValues(row),...snapshotValues));
      stmts.push(this.db.prepare(`UPDATE question_requests AS q SET status=?,exploration_request_id=?,revision=?,updated_at=max(updated_at,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        WHERE changes()=1 AND q.request_id=? AND q.status='triaged' AND q.revision=? AND q.attempt=? AND q.lease_id=? AND q.lease_owner=?
        AND ${this.fence()} RETURNING request_id`).bind(next.status,next.exploration_request_id,next.revision,row.request_id,row.revision+1,row.attempt,row.lease_id,row.lease_owner,...this.fenceValues(row)));
    }else{
      stmts.push(this.db.prepare(`UPDATE question_requests AS q SET status=?,verdict_json=?,exploration_request_id=?,lease_expires_at=NULL,retry_after=?,revision=?,
        updated_at=max(updated_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')) WHERE q.request_id=? AND q.status='triaging' AND q.revision=? AND q.attempt=?
        AND q.lease_id=? AND q.lease_owner=? AND q.lease_expires_at>? AND q.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now')
        AND q.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now')
        AND NOT EXISTS(SELECT 1 FROM exploration_bridge_operations WHERE service=? AND operation_type='ack' AND operation_id=?)
        AND ${this.fence()}${snapshot} RETURNING request_id`).bind(next.status,next.verdict_json,next.exploration_request_id,next.retry_after,next.revision,
        row.request_id,row.revision,row.attempt,row.lease_id,row.lease_owner,now,op.service,op.operation_id,...this.fenceValues(row),...snapshotValues));
    }
    if(answerNow)stmts.push(this.remap(row,next,answerNow,now));
    stmts.push(this.receipt(op));
    if (admission) {
      stmts.push(this.db.prepare(`INSERT INTO exploration_shared_requests(request_id,contract_version,request_json,created_at) SELECT ?,1,?,? WHERE changes()=1 ON CONFLICT(request_id) DO NOTHING`).bind(admission.requestId,admission.requestJson,admission.createdAt));
      stmts.push(this.db.prepare(`INSERT INTO exploration_request_links(request_id,account_sub,created_at,expires_at) SELECT ?,?,?,strftime('%Y-%m-%dT%H:%M:%SZ',?,'+90 days') WHERE EXISTS (SELECT 1 FROM question_requests WHERE request_id=? AND status='queued' AND exploration_request_id=?) ON CONFLICT(request_id,account_sub) DO NOTHING`).bind(admission.requestId,admission.accountSub,admission.createdAt,admission.createdAt,row.request_id,admission.requestId));
      stmts.push(this.db.prepare(`INSERT INTO exploration_shared_jobs(job_id,request_id,status,attempt,admitted_at,created_at,updated_at,expires_at) SELECT ?,?,'queued',0,?,?,?,strftime('%Y-%m-%dT%H:%M:%SZ',?,'+30 days') WHERE EXISTS (SELECT 1 FROM exploration_request_links WHERE request_id=? AND account_sub=?) ON CONFLICT(job_id) DO NOTHING`).bind(admission.jobId,admission.requestId,admission.createdAt,admission.createdAt,admission.createdAt,admission.createdAt,admission.requestId,admission.accountSub));
    }
    const result=await this.db.batch(stmts);return result[0]!.results.length===1;
  }
  async sweepRows(kind:SweepKind,now:string,limit:number):Promise<TriageQuestion[]>{
    if(this.protocol===2 && kind!=="expired")return [];
    if(kind==="queued"){
      const cursor=queuedSweepCursor;
      const page=async(operator:">"|"<=",after:string,count:number)=>(await this.db.prepare(`${SELECT} WHERE q.status='queued' AND ${V1_SCOPE} AND q.request_id ${operator} ? ORDER BY q.request_id LIMIT ?`).bind(after,count).all<TriageQuestion>()).results;
      let rows=cursor===null?(await this.db.prepare(`${SELECT} WHERE q.status='queued' AND ${V1_SCOPE} ORDER BY q.request_id LIMIT ?`).bind(limit).all<TriageQuestion>()).results:await page(">",cursor,limit);
      if(cursor!==null && rows.length<limit)rows=rows.concat(await page("<=",cursor,limit-rows.length));
      if(rows.length)queuedSweepCursor=rows[rows.length-1]!.request_id;
      return rows;
    }
    const where=kind==="expired"?"q.status='triaging' AND q.lease_expires_at<=? AND q.lease_expires_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')":"q.status='triaged'";
    return (await this.db.prepare(`${SELECT} WHERE ${where} AND ${this.scope()} ORDER BY q.updated_at,q.request_id LIMIT ?`).bind(...(kind==="expired"?[now,limit]:[limit])).all<TriageQuestion>()).results;
  }
  async settle(row:TriageQuestion,next:TriageQuestion,now:string):Promise<boolean>{
    const update=this.db.prepare(`UPDATE question_requests AS q SET status=?,lease_expires_at=?,retry_after=?,revision=?,updated_at=max(updated_at,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      WHERE q.request_id=? AND q.status=? AND q.revision=? AND q.lease_id IS ? AND q.lease_owner IS ?
      AND (q.status!='triaging' OR q.lease_expires_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')) AND ${this.fence()} RETURNING request_id`)
      .bind(next.status,next.lease_expires_at,next.retry_after,next.revision,row.request_id,row.status,row.revision,row.lease_id,row.lease_owner,...this.fenceValues(row));
    if(this.protocol===2 && row.managed && next.status==="triage_failed"){
      const result=await this.db.batch([update,this.remap(row,next,{state:"failed",specJson:null,snapshotId:null},now)]);
      return result[0]!.results.length===1;
    }
    return (await update.all()).results.length===1;
  }
  async maintainResults(limit:number):Promise<number>{
    if(this.protocol!==2 || !Number.isInteger(limit) || limit<1 || limit>100)return 0;
    const expired=`((r.state IN ('triaging','clarification_required','confirmation_required') AND r.response_deadline<=strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      OR (r.state IN ('building','in_review') AND r.expires_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')))`;
    const result=await this.db.prepare(`UPDATE question_request_results AS r SET state=CASE WHEN ${expired} THEN 'expired' ELSE 'stale' END,
      verified_json=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=max(updated_at,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      WHERE r.request_id IN(SELECT r.request_id FROM question_request_results r JOIN question_requests q ON q.request_id=r.request_id
        WHERE ${expired} OR (r.state IN ('confirmation_required','building','in_review','released') AND
          (r.request_revision!=q.revision OR json_extract(r.spec_json,'$.data_snapshot_id') IS NOT (SELECT snapshot_id FROM snapshots ORDER BY created_at DESC LIMIT 1)
          OR json_extract(r.spec_json,'$.catalog_digest')!=? OR json_extract(r.spec_json,'$.transform_code_version')!=? OR json_extract(r.spec_json,'$.renderer_version')!=?))
        ORDER BY r.updated_at,r.request_id LIMIT ?) RETURNING request_id`).bind(await requestCatalogDigest(),TRANSFORM_CODE_VERSION,RENDERER_VERSION,limit).all<{request_id:string}>();
    return result.results.length;
  }
  async queueResult(row: TriageQuestion, now: string): Promise<"complete" | "partial" | "no_data" | "gone" | "failed" | "pending"> {
    const result = await this.db.prepare(`SELECT j.status AS job_status,j.failure,r.coverage,r.expires_at FROM exploration_shared_jobs j LEFT JOIN exploration_shared_results r ON r.request_id=j.request_id WHERE j.request_id=?`).bind(row.exploration_request_id).first<{job_status:string;failure:string|null;coverage:string|null;expires_at:string|null}>();
    if (!result || result.job_status === null) return "gone"; if (result.job_status === "published") { if (!result.coverage || !result.expires_at || result.expires_at <= now) return "gone"; return result.coverage === "complete" ? "complete" : result.coverage === "partial" ? "partial" : "no_data"; } if (result.job_status === "failed" && result.failure === "attempts_exhausted") return "failed"; return "pending";
  }
}
