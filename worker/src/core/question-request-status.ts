import { currentSnapshot, resolvePlayerIdentity, type Env } from "./db";
import { artifactKey, canonicalize, RENDERER_VERSION, TRANSFORM_CODE_VERSION, type QueryIntent } from "./intent";
import { requestCatalogDigest, requestResultPath, verifyQuestionResult, type RequestAcceptanceSpec } from "./question-request-intent";
import { D1QuestionResultStore } from "./question-request-result-store";
import type { ResultDeps, ResultState } from "./question-request-results";
import { parseIntent, validateExecutionSupport } from "./validate-intent";
import { Catalog } from "./feasibility";
import { decodeCompiledCatalog } from "./catalog-contract";
import compiled from "../generated/catalog.json";

const catalog = new Catalog(decodeCompiledCatalog(compiled));
type State = ResultState | "clarification_required" | "unsupported" | "unavailable" | "stale";
export interface RequestStatusView {
  requestId: string; revision: number; state: State; personLabel?: string;
  intent?: QueryIntent; resultPath?: string; currentBinding?: boolean;
}
interface StatusRow {
  request_id: string; request_revision: number; parent_revision: number; revision: number; state: State;
  spec_json: string | null; verified_json: string | null; expires_at: string; parent_expires_at: string;
  response_deadline: string; db_now: string;
}

/** Account filtering occurs in SQL, before any interpretation or identity lookup.
 * No original question or model-authored text is read by this status projection.
 */
export async function readQuestionResultStatus(env: Env, account: string, requestId: string, locale: "en" | "es"): Promise<RequestStatusView | undefined> {
  const row = await env.DB.prepare(`SELECT r.request_id,r.request_revision,q.revision AS parent_revision,r.revision,r.state,
    r.spec_json,r.verified_json,r.expires_at,q.expires_at AS parent_expires_at,r.response_deadline,
    strftime('%Y-%m-%dT%H:%M:%SZ','now') AS db_now
    FROM question_request_results r JOIN question_requests q ON q.request_id=r.request_id
    WHERE r.request_id=? AND q.account_sub=?`).bind(requestId,account).first<StatusRow>();
  if (!row) return undefined;
  const view: RequestStatusView = {requestId,revision:row.revision,state:row.state,currentBinding:false};
  if (row.expires_at<=row.db_now || row.parent_expires_at<=row.db_now || ["confirmation_required","clarification_required"].includes(row.state) && row.response_deadline<=row.db_now) return {...view,state:"expired"};
  if (row.request_revision!==row.parent_revision) return {...view,state:"stale"};
  if (row.spec_json===null) return view;
  let spec: RequestAcceptanceSpec;
  try { spec=JSON.parse(row.spec_json); } catch { return {...view,state:"stale"}; }
  if (!spec || spec.version!==1 || spec.request_id!==requestId || spec.request_revision!==row.parent_revision || !["en","es"].includes(spec.locale) || spec.catalog_digest!==await requestCatalogDigest() || spec.transform_code_version!==TRANSFORM_CODE_VERSION || spec.renderer_version!==RENDERER_VERSION) return {...view,state:"stale"};
  let raw: unknown;
  try { raw=JSON.parse(spec.canonical_intent); } catch { return {...view,state:"stale"}; }
  const parsed=parseIntent(raw);
  if (!parsed.ok || validateExecutionSupport(parsed.intent) || canonicalize(parsed.intent)!==spec.canonical_intent || parsed.intent.entity_type!=="player" || parsed.intent.entity_id==="all" || parsed.intent.limit!==1) return {...view,state:"stale"};
  const intent=parsed.intent, snapshotId=await currentSnapshot(env);
  const feasibility=catalog.checkFeasibility(intent,spec.locale);
  if (snapshotId===null || snapshotId!==spec.data_snapshot_id || spec.result_path!==requestResultPath(intent,spec.locale) || spec.artifact_key!==await artifactKey(intent,snapshotId) || spec.expected_cell_state!==feasibility.state || !["available","computable_now_queued"].includes(feasibility.state)) return {...view,state:"stale"};
  const person=await resolvePlayerIdentity(env,intent.entity_id,intent.competition);
  if (!person || person.person_id!==intent.entity_id) return {...view,state:"stale"};
  if (row.state==="released") {
    let evidence: {artifact_key:string;snapshot_id:string;entity_id:string;value:number;attribution:string};
    try { evidence=JSON.parse(row.verified_json ?? "null"); } catch { return {...view,state:"stale"}; }
    if (!evidence || evidence.entity_id!==intent.entity_id || !await verifyQuestionResult(spec,{artifact_key:evidence.artifact_key,snapshot_id:evidence.snapshot_id,intent,feasibility,rows:[{route_key:evidence.entity_id,label:person.web_name,value:evidence.value}],attribution:[evidence.attribution]},{requestId,revision:row.parent_revision,snapshotId})) return {...view,state:"stale"};
  }
  return {...view,intent,personLabel:person.web_name,currentBinding:true,...(row.state==="released" ? {resultPath:requestResultPath(intent,locale)} : {})};
}

/** Parent ownership is checked again by the atomic D1 mutation. */
export function questionResultDeps(env: Env, account: string): ResultDeps {
  return {store:new D1QuestionResultStore(env.DB),now:()=>new Date(),newLeaseId:()=>crypto.randomUUID(),currentBinding:async requestId=>{
    const parent=await env.DB.prepare("SELECT revision FROM question_requests WHERE request_id=? AND account_sub=?").bind(requestId,account).first<{revision:number}>();
    return {revision:parent?.revision ?? -1,snapshotId:await currentSnapshot(env)};
  }};
}
