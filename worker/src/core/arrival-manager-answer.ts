import type { ArrivalManagerRequest } from "./discovery-arrivals";
import type { ArrivalManagerView, ArrivalEntry, ArrivalUnknownReason } from "../views/arrival-managers";

const reasons = new Set<ArrivalUnknownReason>(["identity_unresolved", "spell_missing", "arrival_missing", "promotion_missing", "date_uncertain", "boundary_unresolved", "tenure_missing", "tenure_overlap", "source_conflict"]);
const entryTypes = new Set(["effective_arrival", "registration", "first_team_promotion", "re_signing"]);
const coverages = new Set(["complete", "partial", "missing"]);
const idPattern = /^[a-z0-9][a-z0-9:_-]{0,95}$/;
const creditPattern = /^[\p{L}\p{N} .,:;()'’&/+-]+$/u;
const labelPattern = /^[\p{L}\p{M} '\u2019.-]{1,80}$/u;
type Row = { player: string | null; manager: string | null; entry_type: string | null; entry_date: string | null; status: "assigned" | "unknown"; reason: string | null; coverage: "complete" | "partial" | "missing"; as_of: string; snapshot_id: string; lineage: string[] };
type Export = { version: 1; as_of: string; snapshot_id: string; coverage: "complete" | "partial" | "missing"; population_count: number; lineage: string[]; rows: Row[] };
const keys = (value: unknown): string[] | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some(key => typeof key !== "string")) return null;
  for (const key of ownKeys as string[]) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !("value" in d) || !d.enumerable) return null;
  }
  return ownKeys as string[];
};
const isObject = (value: unknown): value is object => typeof value === "object" && value !== null && !Array.isArray(value);
const read = (value: object, key: string): unknown => Object.getOwnPropertyDescriptor(value, key)?.value;
const exact = (value: unknown, required: string[]): boolean => {
  const actual = keys(value);
  return actual !== null && required.length === actual.length && required.every(k => actual.includes(k));
};
function validDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || v.startsWith("0000")) return false;
  const n = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === v;
}
function stringList(v: unknown, min: number, max: number): v is string[] {
  if (!Array.isArray(v) || v.length < min || v.length > max) return false;
  for (let i = 0; i < v.length; i++) {
    const d = Object.getOwnPropertyDescriptor(v, String(i));
    if (!d || !("value" in d) || typeof d.value !== "string" || !idPattern.test(d.value)) return false;
  }
  return new Set(v).size === v.length;
}
const label = (v: unknown) => v === null || (typeof v === "string" && labelPattern.test(v));
function validRow(v: unknown): v is Row {
  if (!isObject(v) || !exact(v, ["player", "manager", "entry_type", "entry_date", "status", "reason", "coverage", "as_of", "snapshot_id", "lineage"])) return false;
  const player = read(v, "player"), manager = read(v, "manager"), type = read(v, "entry_type"), date = read(v, "entry_date");
  const status = read(v, "status"), reason = read(v, "reason");
  const assigned = status === "assigned" && manager !== null && type !== null && date !== null && reason === null;
  const unknown = status === "unknown" && manager === null && (reason === null || reasons.has(reason as ArrivalUnknownReason) || reason === "label_or_entry_date_missing");
  return label(player) && label(manager) && (type === null || (typeof type === "string" && entryTypes.has(type))) &&
    (date === null || validDate(date)) && (assigned || unknown) && coverages.has(read(v, "coverage") as string) &&
    validDate(read(v, "as_of")) && typeof read(v, "snapshot_id") === "string" && idPattern.test(read(v, "snapshot_id") as string) &&
    stringList(read(v, "lineage"), 1, 32);
}
function validExport(v: unknown): v is Export {
  if (!isObject(v) || !exact(v, ["version", "as_of", "snapshot_id", "coverage", "population_count", "lineage", "rows"])) return false;
  const rows = read(v, "rows"), count = read(v, "population_count");
  if (!Array.isArray(rows) || rows.length > 100) return false;
  for (let i = 0; i < rows.length; i++) {
    const d = Object.getOwnPropertyDescriptor(rows, String(i));
    if (!d || !("value" in d) || !validRow(d.value)) return false;
  }
  return read(v, "version") === 1 && validDate(read(v, "as_of")) && typeof read(v, "snapshot_id") === "string" && idPattern.test(read(v, "snapshot_id") as string) &&
    !(read(v, "coverage") === "missing" && rows.length > 0) &&
    coverages.has(read(v, "coverage") as string) && Number.isSafeInteger(count) && count === rows.length && stringList(read(v, "lineage"), 0, 32);
}
const emptyRequest = (asOf: string): ArrivalManagerRequest => ({ version: 1, family: "arrival_manager", as_of: asOf, population: "first_team_available", joining_basis: "effective_first_team_spell_entry", academy_basis: "documented_first_team_promotion", visualization: "table" });
const emptyView = (asOf: string): ArrivalManagerView => ({ request: emptyRequest(asOf), players: {}, managers: {}, entries: {}, credits: {} });
const dayDate = (date: string | null) => date === null ? null : { earliest: date, latest: date, precision: "day" as const };
function validRequest(v: unknown): v is ArrivalManagerRequest {
  return isObject(v) && exact(v, ["version", "family", "as_of", "population", "joining_basis", "academy_basis", "visualization"]) &&
    read(v, "version") === 1 && read(v, "family") === "arrival_manager" && validDate(read(v, "as_of")) &&
    read(v, "population") === "first_team_available" && read(v, "joining_basis") === "effective_first_team_spell_entry" &&
    read(v, "academy_basis") === "documented_first_team_promotion" && read(v, "visualization") === "table";
}
export interface ArrivalAnswerExpectations { request?: ArrivalManagerRequest; snapshot_id?: string; denied?: boolean }
function fail(asOf = "1970-01-01"): ArrivalManagerView { return { ...emptyView(asOf), error: "The answer export is invalid or belongs to a different dated snapshot." }; }
/** Validates untrusted answer-export data without invoking getters or trusting prototypes. */
export function adaptArrivalManagerAnswer(input: unknown, lineageCredits: Readonly<Record<string, string>>, expected: ArrivalAnswerExpectations = {}): ArrivalManagerView {
  try {
    const expKeys = keys(expected);
    if (!expKeys || expKeys.some(k => !["request", "snapshot_id", "denied"].includes(k))) return fail();
    const expectedRequest = read(expected, "request"), expectedSnapshot = read(expected, "snapshot_id"), denied = read(expected, "denied");
    if ((expectedRequest !== undefined && !validRequest(expectedRequest)) || (expectedSnapshot !== undefined && (typeof expectedSnapshot !== "string" || !idPattern.test(expectedSnapshot))) || (denied !== undefined && typeof denied !== "boolean")) return fail();
    if (!validExport(input)) return fail(validDate(read(input as object, "as_of")) ? read(input as object, "as_of") as string : undefined);
    const asOf = read(input, "as_of") as string, snapshot = read(input, "snapshot_id") as string, coverage = read(input, "coverage") as Export["coverage"];
    const lineage = read(input, "lineage") as string[], rows = read(input, "rows") as Row[];
    if (rows.some(r => r.as_of !== asOf || r.snapshot_id !== snapshot) || (expectedSnapshot !== undefined && snapshot !== expectedSnapshot) || (expectedRequest !== undefined && (expectedRequest.as_of !== asOf || !validRequest(expectedRequest)))) return fail(asOf);
    const request = (expectedRequest as ArrivalManagerRequest | undefined) ?? emptyRequest(asOf);
    if (denied) return { request, players: {}, managers: {}, entries: {}, credits: {}, result: { request, snapshot_id: snapshot, artifact_key: "0".repeat(64), transform_code_version: "answer-export-v1", renderer_version: "arrival-manager-view-v1", roster_snapshot_id: snapshot, feasibility: "no_rights", coverage, population_count: 0, assigned: [], unknown: [], lineage: [] } };
    const visible = coverage === "missing" ? [] : rows, players: Record<string,string> = {}, managers: Record<string,string> = {}, entries: Record<string,ArrivalEntry> = {}, unknownEntries: Record<string,ArrivalEntry> = {};
    const assigned: NonNullable<ArrivalManagerView["result"]>["assigned"] = [], unknown: NonNullable<ArrivalManagerView["result"]>["unknown"] = [];
    for (const [i, row] of visible.entries()) {
      const id = `answer-row:${i}`;
      if (row.player !== null) players[id] = row.player;
      if (row.status === "assigned") {
        const managerId = `answer-manager:${row.manager}`; managers[managerId] = row.manager!;
        assigned.push({ member_id: id, person_id: id, spell_id: id, manager_id: managerId, event_id: id, tenure_id: id, lineage: row.lineage });
        entries[id] = { event_type: row.entry_type as ArrivalEntry["event_type"], date: dayDate(row.entry_date) };
      } else {
        const reason = row.reason && reasons.has(row.reason as ArrivalUnknownReason) ? row.reason as ArrivalUnknownReason : row.player === null ? "identity_unresolved" : row.entry_type === null ? "arrival_missing" : "tenure_missing";
        unknown.push({ member_id: id, person_id: null, spell_id: null, reason, lineage: row.lineage });
        if (row.entry_type !== null) unknownEntries[id] = { event_type: row.entry_type as ArrivalEntry["event_type"], date: dayDate(row.entry_date) };
      }
    }
    const creditKeys = keys(lineageCredits);
    if (!creditKeys) return fail(asOf);
    const credits: Record<string,string> = {};
    for (const ref of lineage) {
      if (!Object.hasOwn(lineageCredits, ref)) continue;
      const d = Object.getOwnPropertyDescriptor(lineageCredits, ref);
      if (!d || !("value" in d)) return fail(asOf);
      const text = d.value;
      if (typeof text !== "string" || text.length > 240 || (text.trim() && !creditPattern.test(text))) return fail(asOf);
      if (text.trim()) credits[ref] = text;
    }
    return { request, players, managers, entries, unknown_entries: unknownEntries, credits, result: { request, snapshot_id: snapshot, artifact_key: "0".repeat(64), transform_code_version: "answer-export-v1", renderer_version: "arrival-manager-view-v1", roster_snapshot_id: snapshot, feasibility: "available", coverage, population_count: coverage === "missing" ? 0 : rows.length, assigned, unknown, lineage } };
  } catch { return fail(); }
}
