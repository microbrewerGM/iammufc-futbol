import { withDefaults, type QueryIntent } from "./intent";

export interface IntentIssue { code: "invalid_intent" | "unsupported_field" | "unsupported_semantics" | "unsupported_execution"; field: string }
type Parsed = { ok: true; intent: QueryIntent } | { ok: false; issue: IntentIssue };
const fields = new Set(["metric", "entity_type", "entity_id", "season", "competition", "dimensions", "filters", "viz", "limit"]);
const entities = new Set(["player", "match", "season", "opponent", "competition"]);
const visualizations = new Set(["table", "bar", "line", "shot_map", "pass_map", "heatmap"]);
function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
const invalid = (field: string): Parsed => ({ ok: false, issue: { code: "invalid_intent", field } });

/** Runtime validation is separate from canonical defaults and future catalog
 * vocabulary. Never discard unsupported fields before validating them. */
export function parseIntent(raw: unknown): Parsed {
  if (!record(raw)) return invalid("intent");
  if (Object.keys(raw).some((key) => !fields.has(key))) return { ok: false, issue: { code: "unsupported_field", field: "intent" } };
  for (const field of ["metric", "season"] as const) {
    if (typeof raw[field] !== "string" || !raw[field].trim() || raw[field].length > 128) return invalid(field);
  }
  for (const field of ["entity_id", "competition"] as const) {
    if (Object.hasOwn(raw, field) && (typeof raw[field] !== "string" || raw[field].length > 128)) return invalid(field);
  }
  if (Object.hasOwn(raw, "competition") && !(raw.competition as string).trim()) return invalid("competition");
  if (Object.hasOwn(raw, "entity_type") && (typeof raw.entity_type !== "string" || !entities.has(raw.entity_type))) return invalid("entity_type");
  if (Object.hasOwn(raw, "viz") && (typeof raw.viz !== "string" || !visualizations.has(raw.viz))) return invalid("viz");
  if (Object.hasOwn(raw, "dimensions") && (!Array.isArray(raw.dimensions) || !raw.dimensions.every((v) => typeof v === "string"))) return invalid("dimensions");
  if (Object.hasOwn(raw, "filters") && (!record(raw.filters) || !Object.values(raw.filters).every((v) => typeof v === "string"))) return invalid("filters");
  if (Object.hasOwn(raw, "limit") && (typeof raw.limit !== "number" || !Number.isSafeInteger(raw.limit) || raw.limit < 1 || raw.limit > 50)) return invalid("limit");
  return { ok: true, intent: withDefaults(raw as Partial<QueryIntent>) };
}

export function validateQuerySemantics(intent: QueryIntent): IntentIssue | null {
  if (intent.dimensions.length) return { code: "unsupported_semantics", field: "dimensions" };
  if (Object.keys(intent.filters).length) return { code: "unsupported_semantics", field: "filters" };
  if (intent.entity_type === "season" && intent.entity_id !== "" && intent.entity_id !== "all") return { code: "unsupported_semantics", field: "entity_id" };
  return null;
}

/** Only after feasibility permits immediate compute: event vocabulary can
 * still get an honest no-data/no-rights answer without a renderer. */
export function validateExecutionSupport(intent: QueryIntent): IntentIssue | null {
  const issue = validateQuerySemantics(intent);
  if (issue) return issue;
  if (intent.viz !== "table" && intent.viz !== "bar") return { code: "unsupported_execution", field: "viz" };
  if (intent.entity_type === "season") return intent.metric === "goals" ? null : { code: "unsupported_execution", field: "metric" };
  if (intent.entity_type !== "player") return { code: "unsupported_execution", field: "entity_type" };
  if (!intent.entity_id.trim()) return { code: "unsupported_execution", field: "entity_id" };
  return ["goals", "assists", "minutes", "points", "xg"].includes(intent.metric) ? null : { code: "unsupported_execution", field: "metric" };
}
