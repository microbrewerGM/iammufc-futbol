/** Tier-0 proposals. Coverage alone never establishes release readiness. */
import compiled from "../generated/catalog.json";
import { decodeCompiledCatalog } from "./catalog-contract";
import { Catalog, type FeasibilityState } from "./feasibility";
import { artifactKey, canonicalize, RENDERER_VERSION, TRANSFORM_CODE_VERSION, withDefaults, type QueryIntent } from "./intent";
import { validateVerdict } from "./question-triage-bridge";
import { parseIntent, validateExecutionSupport } from "./validate-intent";

const catalog = new Catalog(decodeCompiledCatalog(compiled));
const HASH = /^[0-9a-f]{64}$/;
const SNAPSHOT = /^[a-zA-Z0-9:_-]{1,128}$/;
type Locale = "en" | "es";
export interface RequestContext {
  requestId: string; revision: number; locale: Locale; snapshotId: string | null;
  /** Server-owned exact stable-ID lookup; aliases and model assertions do not count. */
  resolvePerson(id: string, competition: string): Promise<string | null>;
}
export interface RequestAcceptanceSpec {
  version: 1; request_id: string; request_revision: number; locale: Locale;
  canonical_intent: string; result_path: string; data_snapshot_id: string;
  catalog_digest: string; transform_code_version: string; renderer_version: string;
  artifact_key: string; expected_cell_state: FeasibilityState;
}
export type RequestMapping =
  | { kind: "invalid" | "irrelevant" }
  | { kind: "clarification_required"; field: "season" | "competition" | "person_id" | "visual" }
  | { kind: "unsupported"; reason: "composition" | "family" | "opponent" | "execution" }
  | { kind: "unavailable"; state: FeasibilityState | "snapshot_unavailable" }
  | { kind: "ready"; intent: QueryIntent; spec: RequestAcceptanceSpec };

export async function requestCatalogDigest(): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(compiled)));
  return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, "0")).join("");
}
export function requestResultPath(intent: QueryIntent, locale: Locale): string {
  const params = new URLSearchParams();
  for (const key of ["metric", "entity_type", "entity_id", "season", "competition", "viz", "limit"] as const) params.set(key, String(intent[key]));
  return `/${locale}/q?${params}`;
}
export async function mapQuestionVerdict(raw: unknown, ctx: RequestContext): Promise<RequestMapping> {
  if (!HASH.test(ctx.requestId) || !Number.isSafeInteger(ctx.revision) || ctx.revision < 0 || !["en", "es"].includes(ctx.locale) || !validateVerdict(raw, ctx.requestId)) return { kind: "invalid" };
  const v = raw as { relevant: boolean; families: string[]; visuals: { kind: string; table_index: number }[]; tables: { fields: string[]; filters: { season: string[]; competition: string[]; person_id: string[]; opponent_id: string[] } }[] };
  if (!v.relevant) return { kind: "irrelevant" };
  if (v.families.length) return { kind: "unsupported", reason: "family" };
  if (v.tables.length !== 1 || v.tables[0]!.fields.length !== 1 || v.visuals.length > 1) return { kind: "unsupported", reason: "composition" };
  const table = v.tables[0]!, f = table.filters;
  if (f.opponent_id.length) return { kind: "unsupported", reason: "opponent" };
  if (f.season.length > 1 || f.competition.length > 1 || f.person_id.length > 1) return { kind: "unsupported", reason: "composition" };
  if (!f.season.length) return { kind: "clarification_required", field: "season" };
  if (!f.competition.length) return { kind: "clarification_required", field: "competition" };
  if (!f.person_id.length || f.person_id[0] === "all") return { kind: "clarification_required", field: "person_id" };
  if (!v.visuals.length) return { kind: "clarification_required", field: "visual" };
  const intent = withDefaults({ metric: table.fields[0]!, entity_type: "player", entity_id: f.person_id[0]!, season: f.season[0]!, competition: f.competition[0]!, viz: v.visuals[0]!.kind as QueryIntent["viz"], limit: 1 });
  if (validateExecutionSupport(intent)) return { kind: "unsupported", reason: "execution" };
  if (await ctx.resolvePerson(intent.entity_id, intent.competition) !== intent.entity_id) return { kind: "clarification_required", field: "person_id" };
  const state = catalog.checkFeasibility(intent, ctx.locale).state;
  if (state !== "available" && state !== "computable_now_queued") return { kind: "unavailable", state };
  if (ctx.snapshotId === null || !SNAPSHOT.test(ctx.snapshotId)) return { kind: "unavailable", state: "snapshot_unavailable" };
  return { kind: "ready", intent, spec: {
    version: 1, request_id: ctx.requestId, request_revision: ctx.revision, locale: ctx.locale,
    canonical_intent: canonicalize(intent), result_path: requestResultPath(intent, ctx.locale),
    data_snapshot_id: ctx.snapshotId, catalog_digest: await requestCatalogDigest(),
    transform_code_version: TRANSFORM_CODE_VERSION, renderer_version: RENDERER_VERSION,
    artifact_key: await artifactKey(intent, ctx.snapshotId), expected_cell_state: state,
  } };
}
function record(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === "object" && !Array.isArray(v); }
/** Verify a trusted executor response with revision/snapshot freshly read AFTER execution. */
export async function verifyQuestionResult(spec: RequestAcceptanceSpec, response: unknown, current: { requestId: string; revision: number; snapshotId: string | null }): Promise<boolean> {
  if (spec.version !== 1 || !HASH.test(spec.request_id) || spec.request_id !== current.requestId || spec.request_revision !== current.revision || !Number.isSafeInteger(current.revision) || current.revision < 0 || spec.data_snapshot_id !== current.snapshotId || !SNAPSHOT.test(spec.data_snapshot_id) || !["en", "es"].includes(spec.locale)) return false;
  if (spec.catalog_digest !== await requestCatalogDigest() || spec.transform_code_version !== TRANSFORM_CODE_VERSION || spec.renderer_version !== RENDERER_VERSION) return false;
  let raw: unknown;
  try { raw = JSON.parse(spec.canonical_intent); } catch { return false; }
  const parsed = parseIntent(raw);
  if (!parsed.ok || validateExecutionSupport(parsed.intent) || canonicalize(parsed.intent) !== spec.canonical_intent) return false;
  const intent = parsed.intent, state = catalog.checkFeasibility(intent, spec.locale).state;
  if (intent.entity_type !== "player" || intent.entity_id === "all" || intent.limit !== 1 || requestResultPath(intent, spec.locale) !== spec.result_path) return false;
  if (state !== spec.expected_cell_state || !["available", "computable_now_queued"].includes(state) || await artifactKey(intent, spec.data_snapshot_id) !== spec.artifact_key) return false;
  if (!record(response) || response.artifact_key !== spec.artifact_key || response.snapshot_id !== spec.data_snapshot_id || !record(response.feasibility) || !["available", "computable_now_queued"].includes(String(response.feasibility.state))) return false;
  const executed = parseIntent(response.intent);
  if (!executed.ok || canonicalize(executed.intent) !== spec.canonical_intent) return false;
  if (!Array.isArray(response.rows) || response.rows.length !== 1 || !record(response.rows[0]) || response.rows[0].route_key !== intent.entity_id || typeof response.rows[0].label !== "string" || !response.rows[0].label.trim() || typeof response.rows[0].value !== "number" || !Number.isFinite(response.rows[0].value)) return false;
  // /api/query currently emits English catalog attribution for both locales.
  // Verify the executor's actual source text, not an arbitrary nonempty string.
  const attribution = catalog.checkFeasibility(intent, "en").attribution_text;
  return typeof attribution === "string" && attribution.trim().length > 0 && Array.isArray(response.attribution) && response.attribution.length === 1 && response.attribution[0] === attribution;
}
