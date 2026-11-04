import { renewRequestSpec, retainedRequestSpec, type RequestAcceptanceSpec } from "./question-request-intent";
import { validAccountSub } from "./question-requests";

type DB = Pick<D1Database, "prepare">;
const ID = /^[0-9a-f]{64}$/;
const tables = ["question_requests", "question_request_results", "question_request_clarifications", "snapshots", "players", "player_identities",
  "question_request_refresh_counts", "question_request_result_refreshes", "question_request_confirmation_context", "question_request_confirmations"];
const triggers = [
  "question_requests_no_replace", "question_requests_initial_insert", "question_requests_clock_insert", "question_requests_triaging_lease_fence", "question_requests_verdict_shape",
  "question_request_results_no_replace", "question_request_results_initial", "question_request_results_spec_insert",
  "question_request_results_clock_insert", "question_request_results_clock_update", "question_request_results_evidence", "question_request_results_retention",
  "question_request_clarifications_insert", "question_request_clarifications_update", "question_request_clarifications_no_replace", "question_request_clarifications_retention",
  "question_requests_clarification_clock_update", "question_requests_clarification_state_machine", "question_request_results_spec_update", "question_request_results_generation_transition",
  "question_request_refresh_counts_initial", "question_request_refresh_counts_no_replace", "question_request_results_refresh_count", "question_request_refresh_counts_retention",
  "question_request_result_refreshes_validate", "question_request_result_refreshes_no_replace", "question_request_result_refreshes_no_update", "question_request_refresh_counts_increment",
  "question_request_confirmation_context_insert", "question_request_confirmation_context_no_update", "question_request_confirmation_context_retention",
  "question_request_confirmations_insert", "question_request_confirmations_no_update", "question_request_confirmations_retention",
  "question_request_results_capture_confirmation", "question_request_results_record_confirmation", "question_request_result_refreshes_apply",
];

/** Absent or interrupted 0016 is never usable. Also reject superseded guards. */
export async function refreshSchemaReady(db: DB): Promise<boolean> {
  try {
    const objects = await db.prepare("SELECT type,name FROM sqlite_master WHERE type IN ('table','trigger')").all<{ type: string; name: string }>();
    const found = new Set(objects.results.map(row => `${row.type}:${row.name}`));
    return tables.every(name => found.has(`table:${name}`)) && triggers.every(name => found.has(`trigger:${name}`))
      && ["question_request_results_refresh_upgrade_lock", "question_requests_state_machine", "question_requests_clock_update", "question_request_results_transition"]
        .every(name => !found.has(`trigger:${name}`));
  } catch { return false; }
}

interface RefreshRow {
  revision: number; request_revision: number; parent_revision: number; parent_status: string;
  state: string; clarification_count: number; spec_json: string | null; locale: string;
  expires_at: string; parent_expires_at: string; updated_at: string; refresh_count: number;
  snapshot_id: string | null; db_now: string;
}
export type RefreshOutcome = "accepted" | "conflict" | "unavailable" | "expired" | "exhausted";

/** Account comes exclusively from authenticated server context. The caller supplies
 * only an ID and revision, never intent, spec, player, snapshot or timestamps. */
export async function refreshQuestionResult(db: DB, account: string, requestId: string, revision: number): Promise<RefreshOutcome> {
  if (!validAccountSub(account) || !ID.test(requestId) || !Number.isSafeInteger(revision) || revision < 1) return "conflict";
  if (!await refreshSchemaReady(db)) return "unavailable";
  try {
    const row = await db.prepare(`SELECT r.revision,r.request_revision,q.revision AS parent_revision,q.status AS parent_status,
      r.state,r.clarification_count,r.spec_json,q.locale,r.expires_at,q.expires_at AS parent_expires_at,r.updated_at,c.refresh_count,
      (SELECT snapshot_id FROM snapshots ORDER BY created_at DESC LIMIT 1) AS snapshot_id,
      strftime('%Y-%m-%dT%H:%M:%SZ','now') AS db_now
      FROM question_requests q JOIN question_request_results r ON r.request_id=q.request_id
      JOIN question_request_refresh_counts c ON c.request_id=q.request_id WHERE q.request_id=? AND q.account_sub=?`)
      .bind(requestId, account).first<RefreshRow>();
    if (!row || row.revision !== revision) return "conflict";
    if (row.expires_at <= row.db_now || row.parent_expires_at <= row.db_now) return "expired";
    if (row.refresh_count >= 3) return "exhausted";
    if (row.request_revision !== row.parent_revision || row.expires_at !== row.parent_expires_at || row.updated_at > row.db_now
      || !["filled", "partial", "no_data"].includes(row.parent_status)
      || !["confirmation_required", "building", "in_review", "released", "stale"].includes(row.state) || row.spec_json === null) return "conflict";
    let raw: unknown;
    try { raw = JSON.parse(row.spec_json); } catch { return "unavailable"; }
    const retained = retainedRequestSpec(raw);
    if (!retained || retained.spec.request_id !== requestId || retained.spec.request_revision !== row.parent_revision || retained.spec.locale !== row.locale) return "unavailable";
    if (row.snapshot_id === null) return "unavailable";
    const identities = await db.prepare(`SELECT i.player_id FROM player_identities i JOIN players p ON p.player_id=i.player_id
      WHERE i.person_id=? AND i.season=? AND p.season=i.season AND i.source_id='fpl'
      AND i.person_id='fpl:code:' || i.source_person_code LIMIT 2`).bind(retained.intent.entity_id, retained.intent.season).all<{ player_id: string }>();
    if (identities.results.length !== 1) return "unavailable";
    const spec = await renewRequestSpec(retained.spec, row.snapshot_id);
    if (!spec) return "unavailable";
    if (spec.data_snapshot_id === retained.spec.data_snapshot_id && spec.catalog_digest === retained.spec.catalog_digest
      && spec.transform_code_version === retained.spec.transform_code_version && spec.renderer_version === retained.spec.renderer_version) return "conflict";
    // Re-fence after all asynchronous hashes. The command trigger independently
    // checks snapshot, exact player, ownership, generation, retention and counter.
    if (!await refreshSchemaReady(db)) return "unavailable";
    const fresh = await db.prepare(`SELECT (SELECT snapshot_id FROM snapshots ORDER BY created_at DESC LIMIT 1) AS snapshot_id,
      strftime('%Y-%m-%dT%H:%M:%SZ','now') AS db_now`).first<{ snapshot_id: string | null; db_now: string }>();
    if (!fresh || fresh.snapshot_id !== row.snapshot_id) return "conflict";
    if (fresh.db_now >= row.expires_at) return "expired";
    await db.prepare(`INSERT INTO question_request_result_refreshes(request_id,account_sub,expected_revision,expected_parent_revision,
      expected_clarification_count,expected_spec_json,expected_expires_at,expected_refresh_count,expected_player_id,next_spec_json)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(requestId, account, revision, row.parent_revision, row.clarification_count,
      row.spec_json, row.expires_at, row.refresh_count, identities.results[0]!.player_id, JSON.stringify(spec)).run();
    return "accepted";
  } catch (error) {
    // Only known CAS rejections are conflicts; infrastructure/validation errors
    // remain explicit unavailable outcomes, never a successful renewal.
    return error instanceof Error && /request refresh conflict|request refresh already pending/.test(error.message) ? "conflict" : "unavailable";
  }
}

export interface RequestConfirmation {
  acceptedRevision: number; spec: RequestAcceptanceSpec; acceptedAt: string; expiresAt: string;
}
/** History proves human acceptance only. It never asserts execution or release. */
export async function readQuestionConfirmations(db: DB, account: string, requestId: string): Promise<RequestConfirmation[]> {
  if (!validAccountSub(account) || !ID.test(requestId) || !await refreshSchemaReady(db)) return [];
  const rows = await db.prepare(`SELECT h.accepted_revision,h.spec_json,h.accepted_at,h.expires_at
    FROM question_request_confirmations h JOIN question_requests q ON q.request_id=h.request_id
    WHERE q.request_id=? AND q.account_sub=? AND h.expires_at=q.expires_at
    AND q.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now')
    ORDER BY h.accepted_revision LIMIT 7`).bind(requestId, account)
    .all<{ accepted_revision: number; spec_json: string; accepted_at: string; expires_at: string }>();
  const history: RequestConfirmation[] = [];
  for (const row of rows.results) {
    let raw: unknown;
    try { raw = JSON.parse(row.spec_json); } catch { return []; }
    const retained = retainedRequestSpec(raw);
    if (!retained || retained.spec.request_id !== requestId) return [];
    history.push({ acceptedRevision: row.accepted_revision, spec: retained.spec, acceptedAt: row.accepted_at, expiresAt: row.expires_at });
  }
  return history;
}
