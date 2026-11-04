import { currentSnapshot, resolvePlayerIdentity, type Env } from "./db";
import { artifactKey, canonicalize, RENDERER_VERSION, TRANSFORM_CODE_VERSION, type QueryIntent } from "./intent";
import { requestCatalogDigest, requestResultPath, verifyQuestionResult, type RequestAcceptanceSpec } from "./question-request-intent";
import { D1QuestionResultStore } from "./question-request-result-store";
import type { ResultDeps, ResultState } from "./question-request-results";
import { parseIntent, validateExecutionSupport } from "./validate-intent";
import { Catalog } from "./feasibility";
import { decodeCompiledCatalog } from "./catalog-contract";
import compiled from "../generated/catalog.json";
import {clarificationSchemaReady} from "./question-request-clarification";
import { readQuestionConfirmations, refreshSchemaReady } from "./question-request-refresh";
import { retainedRequestSpec, renewRequestSpec } from "./question-request-intent";

const catalog = new Catalog(decodeCompiledCatalog(compiled));
type State = ResultState | "triaging" | "clarification_required" | "unsupported" | "unavailable" | "stale";
export interface RequestStatusView {
  requestId: string; revision: number; state: State; personLabel?: string;
  intent?: QueryIntent; resultPath?: string; currentBinding?: boolean; clarificationAvailable?: boolean;
  /** Retained executed provenance only; never grants a current result link. */
  executedSnapshotId?: string;
  confirmationAvailable?: boolean;
  refreshStatus?: "available" | "current" | "pending" | "expired" | "exhausted" | "unavailable";
  confirmationHistory?: { revision: number; snapshotId: string; acceptedAt: string }[];
}
interface StatusRow {
  request_id: string; request_revision: number; parent_revision: number; revision: number; state: State;
  spec_json: string | null; verified_json: string | null; expires_at: string; parent_expires_at: string;
  response_deadline: string; db_now: string;
  clarification_count:number; created_at:string;
}

function storedObject(raw: string | null, keys: readonly string[]): Record<string, unknown> | undefined {
  if (typeof raw !== "string" || raw.length > 8192 || new TextEncoder().encode(raw).length > 8192) return;
  try {
    const value: unknown = JSON.parse(raw);
    // Server writes use JSON.stringify; duplicate keys/noncanonical storage
    // cannot establish historical evidence.
    if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value) !== raw) return;
    if (Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) return;
    return value as Record<string, unknown>;
  } catch { return; }
}
function safeSnapshot(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[^A-Za-z0-9:_-]/.test(value);
}
function hash(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 && !/[^a-f0-9]/.test(value);
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && value.length === 20 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace(".000Z", "Z") === value;
}

/** Historical structural binding only. Current catalog/lineage checks below
 * still decide release links; cleared evidence cannot establish history. */
async function executedSnapshot(row: StatusRow, requestId: string): Promise<string | undefined> {
  if (row.state !== "released" || row.request_revision !== row.parent_revision || row.request_id !== requestId
    || !hash(requestId) || !Number.isSafeInteger(row.parent_revision) || row.parent_revision < 0
    || !Number.isSafeInteger(row.revision) || row.revision < 1) return;
  const spec = storedObject(row.spec_json, ["version", "request_id", "request_revision", "locale", "canonical_intent", "result_path", "data_snapshot_id", "catalog_digest", "transform_code_version", "renderer_version", "artifact_key", "expected_cell_state"]);
  const evidence = storedObject(row.verified_json, ["artifact_key", "snapshot_id", "entity_id", "value", "attribution", "verified_at"]);
  if (!spec || !evidence || spec.version !== 1 || typeof spec.request_revision !== "number"
    || !Number.isSafeInteger(spec.request_revision) || spec.request_id !== requestId || spec.request_revision !== row.parent_revision
    || typeof spec.locale !== "string" || !["en", "es"].includes(spec.locale) || !safeSnapshot(spec.data_snapshot_id)
    || !hash(spec.catalog_digest) || !hash(spec.artifact_key) || typeof spec.canonical_intent !== "string"
    || typeof spec.expected_cell_state !== "string" || !["available", "computable_now_queued"].includes(spec.expected_cell_state)) return;
  for (const version of [spec.transform_code_version, spec.renderer_version]) {
    if (typeof version !== "string" || version.length < 1 || version.length > 128 || /[^A-Za-z0-9._:-]/.test(version)) return;
  }
  let raw: unknown;
  try { raw = JSON.parse(spec.canonical_intent); } catch { return; }
  const parsed = parseIntent(raw);
  if (!parsed.ok || validateExecutionSupport(parsed.intent) || canonicalize(parsed.intent) !== spec.canonical_intent
    || parsed.intent.entity_type !== "player" || parsed.intent.entity_id === "all" || parsed.intent.limit !== 1
    || spec.result_path !== requestResultPath(parsed.intent, spec.locale as "en" | "es")) return;
  if (evidence.snapshot_id !== spec.data_snapshot_id || evidence.artifact_key !== spec.artifact_key
    || evidence.entity_id !== parsed.intent.entity_id || typeof evidence.value !== "number" || !Number.isFinite(evidence.value)
    || typeof evidence.attribution !== "string" || !evidence.attribution.trim() || evidence.attribution.length > 4096
    || !timestamp(evidence.verified_at) || !timestamp(row.created_at) || evidence.verified_at < row.created_at
    || evidence.verified_at > row.db_now || evidence.verified_at >= row.expires_at || evidence.verified_at >= row.parent_expires_at) return;
  // artifactKey binds current code. History hashes the stored four-tuple
  // without admitting it as a current execution or serving an old snapshot.
  const material = [spec.canonical_intent, spec.data_snapshot_id, spec.transform_code_version, spec.renderer_version].join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  const key = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return key === spec.artifact_key ? spec.data_snapshot_id : undefined;
}

/** Account filtering occurs in SQL, before any interpretation or identity lookup.
 * No original question or model-authored text is read by this status projection.
 */
async function readBoundQuestionResultStatus(env: Env, account: string, requestId: string, locale: "en" | "es"): Promise<RequestStatusView | undefined> {
  // Additive rollout: keep existing intake/status usable until CI applies0013.
  // Other storage errors still propagate and fail closed in the route.
  const schema=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='question_request_results'").bind().first<{name:string}>();
  if (!schema) return undefined;
  const row = await env.DB.prepare(`SELECT r.request_id,r.request_revision,q.revision AS parent_revision,r.revision,r.state,r.clarification_count,
    r.spec_json,r.verified_json,r.created_at,r.expires_at,q.expires_at AS parent_expires_at,r.response_deadline,
    strftime('%Y-%m-%dT%H:%M:%SZ','now') AS db_now
    FROM question_request_results r JOIN question_requests q ON q.request_id=r.request_id
    WHERE r.request_id=? AND q.account_sub=?`).bind(requestId,account).first<StatusRow>();
  if (!row) return undefined;
  const view: RequestStatusView = {requestId,revision:row.revision,state:row.state,currentBinding:false,clarificationAvailable:false};
  if (row.expires_at<=row.db_now || row.parent_expires_at<=row.db_now || ["triaging","confirmation_required","clarification_required"].includes(row.state) && row.response_deadline<=row.db_now) return {...view,state:"expired"};
  if (["expired","failed","unsupported","unavailable","stale"].includes(row.state)) return view;
  if (row.state==="triaging") return {...view,state:row.parent_revision>=row.request_revision?"triaging":"stale"};
  if (row.request_revision!==row.parent_revision) return {...view,state:"stale"};
  if (row.state==="clarification_required") return {...view,clarificationAvailable:row.clarification_count<3 && await clarificationSchemaReady(env)};
  const historicalSnapshot = await executedSnapshot(row, requestId);
  const withHistory = async (result: RequestStatusView, current?: string): Promise<RequestStatusView | undefined> => {
    if (historicalSnapshot === undefined) return result;
    const fresh = await env.DB.prepare(`SELECT r.request_id,r.request_revision,q.revision AS parent_revision,r.revision,r.state,
      r.spec_json,r.verified_json,r.created_at,r.expires_at,q.expires_at AS parent_expires_at,r.response_deadline,
      (SELECT snapshot_id FROM snapshots ORDER BY created_at DESC LIMIT 1) AS snapshot_id,
      strftime('%Y-%m-%dT%H:%M:%SZ','now') AS db_now
      FROM question_request_results r JOIN question_requests q ON q.request_id=r.request_id
      WHERE r.request_id=? AND q.account_sub=?`).bind(requestId,account).first<StatusRow & {snapshot_id:string|null}>();
    if (!fresh) return undefined;
    if (fresh.expires_at<=fresh.db_now || fresh.parent_expires_at<=fresh.db_now) return {...view,state:"expired"};
    if (fresh.request_id!==requestId || fresh.parent_revision!==row.parent_revision || fresh.request_revision!==row.request_revision
      || fresh.revision!==row.revision || fresh.state!==row.state || fresh.spec_json!==row.spec_json
      || fresh.verified_json!==row.verified_json || fresh.created_at!==row.created_at
      || fresh.expires_at!==row.expires_at || fresh.parent_expires_at!==row.parent_expires_at) return {...view,state:"stale"};
    const metadata = {executedSnapshotId:historicalSnapshot};
    if (current !== undefined && fresh.snapshot_id !== current) return {...view,...metadata,state:"stale"};
    return {...result,...metadata};
  };
  if (row.spec_json===null) return view;
  let spec: RequestAcceptanceSpec;
  try { spec=JSON.parse(row.spec_json); } catch { return withHistory({...view,state:"stale"}); }
  if (!spec || spec.version!==1 || spec.request_id!==requestId || spec.request_revision!==row.parent_revision || !["en","es"].includes(spec.locale) || spec.catalog_digest!==await requestCatalogDigest() || spec.transform_code_version!==TRANSFORM_CODE_VERSION || spec.renderer_version!==RENDERER_VERSION) return withHistory({...view,state:"stale"});
  let raw: unknown;
  try { raw=JSON.parse(spec.canonical_intent); } catch { return withHistory({...view,state:"stale"}); }
  const parsed=parseIntent(raw);
  if (!parsed.ok || validateExecutionSupport(parsed.intent) || canonicalize(parsed.intent)!==spec.canonical_intent || parsed.intent.entity_type!=="player" || parsed.intent.entity_id==="all" || parsed.intent.limit!==1) return withHistory({...view,state:"stale"});
  const intent=parsed.intent, snapshotId=await currentSnapshot(env);
  const feasibility=catalog.checkFeasibility(intent,spec.locale);
  if (snapshotId===null || snapshotId!==spec.data_snapshot_id || spec.result_path!==requestResultPath(intent,spec.locale) || spec.artifact_key!==await artifactKey(intent,snapshotId) || spec.expected_cell_state!==feasibility.state || !["available","computable_now_queued"].includes(feasibility.state)) return withHistory({...view,state:"stale"});
  const person=await resolvePlayerIdentity(env,intent.entity_id,intent.competition);
  if (!person || person.person_id!==intent.entity_id) return withHistory({...view,state:"stale"});
  if (row.state==="released") {
    let evidence: {artifact_key:string;snapshot_id:string;entity_id:string;value:number;attribution:string};
    try { evidence=JSON.parse(row.verified_json ?? "null"); } catch { return withHistory({...view,state:"stale"}); }
    if (!evidence || evidence.entity_id!==intent.entity_id || !await verifyQuestionResult(spec,{artifact_key:evidence.artifact_key,snapshot_id:evidence.snapshot_id,intent,feasibility,rows:[{route_key:evidence.entity_id,label:person.web_name,value:evidence.value}],attribution:[evidence.attribution]},{requestId,revision:row.parent_revision,snapshotId})) return withHistory({...view,state:"stale"});
  }
  // Identity resolution and evidence hashing await other work. Re-read the
  // parent, sidecar, retention and snapshot together after all those awaits.
  const fresh=await env.DB.prepare(`SELECT q.revision AS parent_revision,r.revision,r.state,r.expires_at,q.expires_at AS parent_expires_at,r.response_deadline,
    (SELECT snapshot_id FROM snapshots ORDER BY created_at DESC LIMIT 1) AS snapshot_id,
    strftime('%Y-%m-%dT%H:%M:%SZ','now') AS db_now
    FROM question_request_results r JOIN question_requests q ON q.request_id=r.request_id
    WHERE r.request_id=? AND q.account_sub=?`).bind(requestId,account).first<StatusRow & {snapshot_id:string|null}>();
  if (!fresh) return undefined;
  if (fresh.expires_at<=fresh.db_now || fresh.parent_expires_at<=fresh.db_now || fresh.state==="confirmation_required" && fresh.response_deadline<=fresh.db_now) return {...view,state:"expired"};
  if (fresh.parent_revision!==row.parent_revision || fresh.revision!==row.revision || fresh.state!==row.state || fresh.snapshot_id!==snapshotId) return withHistory({...view,state:"stale"});
  return withHistory({...view,intent,personLabel:person.web_name,currentBinding:true,...(row.state==="released" ? {resultPath:requestResultPath(intent,locale)} : {})},snapshotId);
}

/** Refresh history is acceptance metadata, never execution evidence. Fence the
 * bound status after all history/spec awaits so they cannot revive a stale link. */
export async function readQuestionResultStatus(env: Env, account: string, requestId: string, locale: "en" | "es", options: { requesterMetadata?: boolean } = {}): Promise<RequestStatusView | undefined> {
  const initial = await readBoundQuestionResultStatus(env, account, requestId, locale);
  if (!initial) return undefined;
  // Notification and execution consumers do not render refresh or history.
  // Confirmation still requires complete readiness and a binding recheck after
  // that await; its atomic write supplies the final revision/snapshot fence.
  if (!options.requesterMetadata) {
    if (initial.state==="released") return initial;
    const ready=await refreshSchemaReady(env.DB);
    if (initial.state!=="confirmation_required") return {...initial,confirmationAvailable:false,
      ...(!ready ? {refreshStatus:"unavailable" as const} : {})};
    const fresh=await readBoundQuestionResultStatus(env, account, requestId, locale);
    return fresh && {...fresh,confirmationAvailable:ready && fresh.currentBinding===true && fresh.state==="confirmation_required",
      ...(!ready ? {refreshStatus:"unavailable" as const} : {})};
  }
  if (!await refreshSchemaReady(env.DB)) {
    const fresh=await env.DB.prepare(`SELECT r.request_id,r.revision,r.state,r.request_revision,q.revision AS parent_revision,
      r.spec_json,r.expires_at,q.expires_at AS parent_expires_at,r.response_deadline,
      (SELECT snapshot_id FROM snapshots ORDER BY created_at DESC LIMIT 1) AS snapshot_id,
      strftime('%Y-%m-%dT%H:%M:%SZ','now') AS db_now
      FROM question_request_results r JOIN question_requests q ON q.request_id=r.request_id
      WHERE r.request_id=? AND q.account_sub=?`).bind(requestId,account).first<StatusRow & {snapshot_id:string|null}>();
    if (!fresh || fresh.request_id!==requestId) return undefined;
    const closed={requestId,revision:fresh.revision,currentBinding:false,clarificationAvailable:false,confirmationAvailable:false,refreshStatus:"unavailable" as const};
    if (fresh.expires_at<=fresh.db_now || fresh.parent_expires_at<=fresh.db_now || ["triaging","clarification_required","confirmation_required"].includes(fresh.state) && fresh.response_deadline<=fresh.db_now) return {...closed,state:"expired"};
    let snapshot: unknown;
    try { snapshot=JSON.parse(fresh.spec_json??"null")?.data_snapshot_id; } catch { /* fail closed */ }
    if (fresh.revision!==initial.revision || (initial.currentBinding===true || initial.clarificationAvailable===true) && fresh.request_revision!==fresh.parent_revision
      || initial.currentBinding===true && (fresh.state!==initial.state || fresh.snapshot_id!==snapshot)) return {...closed,state:"stale"};
    return {...initial,confirmationAvailable:false,refreshStatus:"unavailable"};
  }
  const confirmations = await readQuestionConfirmations(env.DB, account, requestId);
  const readMetadata = () => env.DB.prepare(`SELECT r.revision,r.state,r.spec_json,r.request_revision,q.revision AS parent_revision,
    r.expires_at,q.expires_at AS parent_expires_at,r.response_deadline,c.refresh_count,
    (SELECT snapshot_id FROM snapshots ORDER BY created_at DESC LIMIT 1) AS snapshot_id,
    strftime('%Y-%m-%dT%H:%M:%SZ','now') AS db_now
    FROM question_request_results r JOIN question_requests q ON q.request_id=r.request_id
    JOIN question_request_refresh_counts c ON c.request_id=r.request_id
    WHERE r.request_id=? AND q.account_sub=?`).bind(requestId,account).first<{
      revision:number; state:string; spec_json:string|null; request_revision:number; parent_revision:number;
      expires_at:string; parent_expires_at:string; response_deadline:string; refresh_count:number; snapshot_id:string|null; db_now:string;
    }>();
  const row=await readMetadata();
  let refreshStatus: NonNullable<RequestStatusView["refreshStatus"]> = "unavailable";
  if (row && row.revision===initial.revision) {
    if (row.expires_at<=row.db_now || row.parent_expires_at<=row.db_now) refreshStatus="expired";
    else if (row.refresh_count>=3) refreshStatus="exhausted";
    else if (row.request_revision===row.parent_revision && ["confirmation_required","building","in_review","released","stale"].includes(row.state) && row.snapshot_id && row.spec_json) {
      let retained: ReturnType<typeof retainedRequestSpec> = null;
      try { retained=retainedRequestSpec(JSON.parse(row.spec_json)); } catch { /* unavailable */ }
      if (retained && retained.spec.request_id===requestId && retained.spec.request_revision===row.parent_revision) {
        const next=await renewRequestSpec(retained.spec,row.snapshot_id);
        const identities=await env.DB.prepare(`SELECT i.player_id FROM player_identities i JOIN players p ON p.player_id=i.player_id
          WHERE i.person_id=? AND i.season=? AND p.season=i.season AND i.source_id='fpl'
          AND i.person_id='fpl:code:' || i.source_person_code LIMIT 2`).bind(retained.intent.entity_id,retained.intent.season).all<{player_id:string}>();
        if (next && identities.results.length===1) refreshStatus=next.artifact_key!==retained.spec.artifact_key || next.catalog_digest!==retained.spec.catalog_digest
          ? "available" : ["building","in_review"].includes(row.state) ? "pending" : "current";
      }
    } else if (["triaging","clarification_required"].includes(row.state)) refreshStatus="pending";
  }
  const ready=await refreshSchemaReady(env.DB);
  const final=await readMetadata();
  if (!final) return undefined;
  if (final.expires_at<=final.db_now || final.parent_expires_at<=final.db_now) return {requestId,revision:final.revision,state:"expired",currentBinding:false,confirmationAvailable:false,refreshStatus:"expired"};
  let approvedSnapshot:unknown;
  try {approvedSnapshot=JSON.parse(final.spec_json??"null")?.data_snapshot_id;} catch { /* fail closed */ }
  if (row && (final.revision!==row.revision || final.parent_revision!==row.parent_revision || final.request_revision!==row.request_revision
    || final.state!==row.state || final.spec_json!==row.spec_json || final.expires_at!==row.expires_at
    || final.parent_expires_at!==row.parent_expires_at || final.snapshot_id!==row.snapshot_id
    || initial.revision!==final.revision || initial.currentBinding===true && final.snapshot_id!==approvedSnapshot))
    return {requestId,revision:final.revision,state:"stale",currentBinding:false,confirmationAvailable:false,refreshStatus:"unavailable"};
  if (["triaging","clarification_required","confirmation_required"].includes(final.state) && final.response_deadline<=final.db_now)
    return {requestId,revision:final.revision,state:"expired",currentBinding:false,confirmationAvailable:false,refreshStatus};
  if (!ready || !row) return {...initial,confirmationAvailable:false,refreshStatus:"unavailable"};
  return {...initial,confirmationAvailable:initial.currentBinding===true && initial.state==="confirmation_required",
    refreshStatus,confirmationHistory:confirmations.map(h=>({revision:h.acceptedRevision,snapshotId:h.spec.data_snapshot_id,acceptedAt:h.acceptedAt}))};
}

/** Parent ownership is checked again by the atomic D1 mutation. */
export function questionResultDeps(env: Env, account: string): ResultDeps {
  return {store:new D1QuestionResultStore(env.DB),now:()=>new Date(),newLeaseId:()=>crypto.randomUUID(),currentBinding:async requestId=>{
    const parent=await env.DB.prepare("SELECT revision FROM question_requests WHERE request_id=? AND account_sub=?").bind(requestId,account).first<{revision:number}>();
    return {revision:parent?.revision ?? -1,snapshotId:await currentSnapshot(env)};
  }};
}
