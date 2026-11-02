import { currentSnapshot,enforceBudget,readQueryCache,runQuery,writeQueryCache,type Env } from "./db";
import type { QueryIntent } from "./intent";
import { D1QuestionResultStore } from "./question-request-result-store";
import { claimQuestionResult,completeQuestionResult,recoverQuestionResult,type QuestionResult,type ResultDeps,type ResultTransition } from "./question-request-results";
import { readQuestionResultStatus } from "./question-request-status";
import type { RequestAcceptanceSpec } from "./question-request-intent";
import { Catalog } from "./feasibility";
import { decodeCompiledCatalog } from "./catalog-contract";
import compiled from "../generated/catalog.json";

const catalog=new Catalog(decodeCompiledCatalog(compiled));
type ExecutionFailure="budget_exceeded"|"budget_unavailable"|"unavailable";
class QueryFailure extends Error { constructor(readonly outcome:ExecutionFailure){super(outcome);} }
export interface RequestExecutionDeps extends ResultDeps {
  selection(row:QuestionResult):Promise<{revision:number;intent?:QueryIntent;currentBinding?:boolean}|undefined>;
  execute(intent:QueryIntent,spec:RequestAcceptanceSpec):Promise<unknown>;
}

/** Client supplies only ID+revision. Stored acceptance chooses the query; only
 * the successful CAS claimant can reach the trusted executor. Failures retain
 * their lease until bounded recovery, rather than claiming a false release.
 */
export async function executeQuestionResult(deps:RequestExecutionDeps,requestId:string,revision:number,service:string):Promise<ResultTransition|ExecutionFailure> {
  const row=await deps.store.get(requestId);
  if (!row) return "not_found";
  if (row.revision!==revision || row.state!=="building") return "conflict";
  const selection=await deps.selection(row);
  if (!selection?.currentBinding || !selection.intent || selection.revision!==revision) return "conflict";
  const claimed=await claimQuestionResult(deps,requestId,revision,service);
  if (claimed!=="accepted") return claimed;
  const leased=await deps.store.get(requestId);
  if (!leased || leased.state!=="in_review" || leased.revision!==revision+1 || leased.leaseOwner!==service || !leased.leaseId) return "conflict";
  let response:unknown;
  try { response=await deps.execute(selection.intent,leased.spec); }
  catch (error) { return error instanceof QueryFailure ? error.outcome : "unavailable"; }
  return completeQuestionResult(deps,requestId,leased.revision,service,leased.leaseId,response);
}

/** Same cache/budget/snapshot sequence as the public deterministic query route.
 * This function receives only a server-validated current selection.
 */
export async function executeRequestQuery(env:Env,intent:QueryIntent,spec:RequestAcceptanceSpec):Promise<unknown> {
  const snapshot=spec.data_snapshot_id,key=spec.artifact_key;
  if (await currentSnapshot(env)!==snapshot) throw new QueryFailure("unavailable");
  const cached=await readQueryCache(env,key,snapshot,intent);
  let result=cached.result;
  if (!result) {
    const denial:{reason?:"over_limit"|"unavailable"}={};
    if (!await enforceBudget(env,{failClosed:true,denial})) throw new QueryFailure(denial.reason==="unavailable"?"budget_unavailable":"budget_exceeded");
    result=await runQuery(env,intent,snapshot);
    if (await currentSnapshot(env)!==snapshot) throw new QueryFailure("unavailable");
    await writeQueryCache(env,key,snapshot,result,intent);
  }
  if (await currentSnapshot(env)!==snapshot) throw new QueryFailure("unavailable");
  const feasibility=catalog.checkFeasibility(intent,"en",cached.result!==null);
  return {artifact_key:key,intent,feasibility,snapshot_id:result.snapshot_id,rows:result.rows,attribution:[catalog.checkFeasibility(intent,"en").attribution_text].filter(Boolean)};
}

export function requestExecutionDeps(env:Env):RequestExecutionDeps {
  return {store:new D1QuestionResultStore(env.DB),now:()=>new Date(),newLeaseId:()=>crypto.randomUUID(),
    currentBinding:async requestId=>{
      const row=await env.DB.prepare("SELECT revision FROM question_requests WHERE request_id=?").bind(requestId).first<{revision:number}>();
      return {revision:row?.revision ?? -1,snapshotId:await currentSnapshot(env)};
    },
    selection:row=>readQuestionResultStatus(env,row.accountSub,row.requestId,row.spec.locale),
    execute:(intent,spec)=>executeRequestQuery(env,intent,spec),
  };
}

/** Bounded service discovery. Recovery is a separate transition before any
 * new execution lease; no raw question, owner identity or query rows leave it.
 */
export async function readQuestionResults(env:Env,limit:number,deps:ResultDeps=requestExecutionDeps(env)):Promise<{request_id:string;revision:number}[]> {
  if (!Number.isInteger(limit) || limit<1 || limit>10) throw new Error("invalid_result_limit");
  const candidates=await env.DB.prepare(`SELECT r.request_id FROM question_request_results r JOIN question_requests q ON q.request_id=r.request_id
    WHERE r.spec_json IS NOT NULL AND r.request_revision=q.revision AND
    (r.state='building' OR r.state='in_review' AND r.lease_expires_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
    OR r.state='confirmation_required' AND r.response_deadline<=strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    ORDER BY r.updated_at,r.request_id LIMIT ?`).bind(limit).all<{request_id:string}>();
  const results:{request_id:string;revision:number}[]=[];
  for (const candidate of candidates.results) {
    const row=await deps.store.get(candidate.request_id);
    if (!row) continue;
    await recoverQuestionResult(deps,row.requestId,row.revision);
    const current=await deps.store.get(row.requestId);
    if (current?.state==="building") results.push({request_id:current.requestId,revision:current.revision});
  }
  return results;
}
