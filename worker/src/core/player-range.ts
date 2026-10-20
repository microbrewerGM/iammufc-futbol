import { per90 } from "./rates";

/** B13 pure calculator. Adapters supply validated canonical identities/coverage;
 * absence is unknown, never an invented zero or non-membership assertion. */
export interface PlayerRangeRequest {
  schema_version: 1; competition: "PL"; person_ids: string[]; seasons: string[];
  metric: "goals" | "assists"; normalization: "total" | "per90";
  min_minutes: number; viz: "table" | "bar";
}
export interface PlayerRangeCatalog { snapshot_id: string; person_ids: string[]; seasons: string[] }
export interface PlayerRangeRow {
  person_id: string; season: string; competition: "PL"; metric: "goals" | "assists";
  definition: "goals" | "fpl_assists"; total: number | null; minutes: number | null;
  snapshot_id: string; lineage: string[];
}
export interface PlayerRangeCell {
  season: string; total: number | null; minutes: number | null;
  reason: "supported" | "missing_row" | "missing_support"; lineage: string[];
}
export interface PlayerRangePlayer {
  person_id: string; cells: PlayerRangeCell[]; contributing_seasons: string[];
  missing_seasons: string[]; eligible_minutes: number; total: number | null;
  rate: number | null; value: number | null; partial: boolean; comparable: boolean;
  reasons: ("partial_subtotal" | "no_supported_rows" | "zero_minutes" | "below_minimum")[];
  lineage: string[];
}
export interface PlayerRangeResult {
  request: PlayerRangeRequest; snapshot_id: string; definition: "goals" | "fpl_assists";
  players: PlayerRangePlayer[]; ranked_person_ids: string[];
}
function fail(message: string): never { throw new Error(`Invalid player range: ${message}`); }
function record(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("object");
  const obj = value as Record<string, unknown>;
  if (keys.some(k => !Object.hasOwn(obj, k)) || Object.keys(obj).some(k => !keys.includes(k) && !optional.includes(k))) fail("closed fields");
  return obj;
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value;
}
function person(value: unknown): value is string {
  return typeof value === "string" && /^fpl:code:[1-9][0-9]{0,17}$/.test(value);
}
function season(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{4}-[0-9]{2}$/.test(value)
    && Number(value.slice(-2)) === (Number(value.slice(0, 4)) + 1) % 100;
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function list(value: unknown, min: number, max: number, valid: (v: unknown) => boolean): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail("list bound");
  const items = Array.from(value);
  if (!items.every(valid) || new Set(items).size !== items.length) fail("list entries");
  return (items as string[]).sort();
}
function catalog(value: unknown): PlayerRangeCatalog {
  const obj = record(value, ["snapshot_id", "person_ids", "seasons"]);
  if (!text(obj.snapshot_id)) fail("snapshot");
  return { snapshot_id: obj.snapshot_id, person_ids: list(obj.person_ids, 2, 256, person), seasons: list(obj.seasons, 1, 64, season) };
}
export function parsePlayerRangeRequest(value: unknown, metadataValue: unknown): PlayerRangeRequest {
  const metadata = catalog(metadataValue);
  const obj = record(value, ["schema_version", "competition", "person_ids", "seasons", "metric", "normalization", "viz"], ["min_minutes"]);
  if (obj.schema_version !== 1 || obj.competition !== "PL") fail("version/competition");
  if (obj.metric !== "goals" && obj.metric !== "assists") fail("metric");
  if (obj.normalization !== "total" && obj.normalization !== "per90") fail("normalization");
  if (obj.viz !== "table" && obj.viz !== "bar") fail("viz");
  const people = list(obj.person_ids, 2, 5, person);
  const seasons = list(obj.seasons, 1, 8, season);
  if (people.some(p => !metadata.person_ids.includes(p)) || seasons.some(s => !metadata.seasons.includes(s))) fail("unknown selection");
  const minimum = Object.hasOwn(obj, "min_minutes") ? obj.min_minutes : obj.normalization === "per90" ? 450 : 0;
  if (!integer(minimum) || minimum > 20000) fail("minimum");
  return { schema_version: 1, competition: "PL", person_ids: people, seasons,
    metric: obj.metric, normalization: obj.normalization, min_minutes: minimum, viz: obj.viz };
}
function add(a: number, b: number): number {
  const result = a + b;
  if (!Number.isSafeInteger(result)) fail("overflow");
  return result;
}
export function calculatePlayerRange(value: unknown, metadataValue: unknown, rowsValue: unknown): PlayerRangeResult {
  const metadata = catalog(metadataValue);
  const request = parsePlayerRangeRequest(value, metadata);
  if (!Array.isArray(rowsValue) || rowsValue.length > 2048) fail("row bound");
  const rows = new Map<string, PlayerRangeRow>();
  // Validate all facts, even those outside the selection; filtering cannot hide corruption.
  for (const value of rowsValue) {
    const obj = record(value, ["person_id", "season", "competition", "metric", "definition", "total", "minutes", "snapshot_id", "lineage"]);
    if (!person(obj.person_id) || !metadata.person_ids.includes(obj.person_id)
      || !season(obj.season) || !metadata.seasons.includes(obj.season) || obj.competition !== "PL") fail("row identity");
    if ((obj.metric !== "goals" && obj.metric !== "assists")
      || obj.definition !== (obj.metric === "goals" ? "goals" : "fpl_assists")) fail("metric definition");
    if ((obj.total !== null && !integer(obj.total)) || (obj.minutes !== null && !integer(obj.minutes))) fail("row counters");
    if (obj.snapshot_id !== metadata.snapshot_id) fail("mixed snapshots");
    const lineage = list(obj.lineage, 1, 32, text);
    const key = JSON.stringify([obj.person_id, obj.season, obj.metric]);
    if (rows.has(key)) fail("duplicate fact");
    rows.set(key, { ...obj, lineage } as unknown as PlayerRangeRow);
  }
  const players = request.person_ids.map((person_id): PlayerRangePlayer => {
    const cells = request.seasons.map((season): PlayerRangeCell => {
      const row = rows.get(JSON.stringify([person_id, season, request.metric]));
      return { season, total: row?.total ?? null, minutes: row?.minutes ?? null,
        reason: !row ? "missing_row" : row.total === null || row.minutes === null ? "missing_support" : "supported",
        lineage: row ? [...row.lineage] : [] };
    });
    const support = cells.filter(c => c.reason === "supported");
    const total = support.length ? support.reduce((sum, c) => add(sum, c.total!), 0) : null;
    const minutes = support.reduce((sum, c) => add(sum, c.minutes!), 0);
    // Multiplication must remain exact before division; reject unsafe arithmetic.
    if (total !== null && !Number.isSafeInteger(total * 90)) fail("rate overflow");
    const rate = per90(total, minutes);
    const missing = cells.filter(c => c.reason !== "supported").map(c => c.season);
    const reasons: PlayerRangePlayer["reasons"] = [];
    if (missing.length) reasons.push("partial_subtotal");
    if (!support.length) reasons.push("no_supported_rows");
    if (request.normalization === "per90" && minutes === 0) reasons.push("zero_minutes");
    if (minutes < request.min_minutes) reasons.push("below_minimum");
    const comparable = reasons.length === 0;
    return { person_id, cells, contributing_seasons: support.map(c => c.season), missing_seasons: missing,
      eligible_minutes: minutes, total, rate, value: request.normalization === "total" ? total : rate,
      partial: missing.length > 0, comparable, reasons,
      lineage: [...new Set(cells.flatMap(c => c.lineage))].sort() };
  });
  const ranked = players.filter(p => p.comparable).sort((a, b) => {
    const diff = request.normalization === "total" ? BigInt(b.total!) - BigInt(a.total!)
      : BigInt(b.total!) * BigInt(a.eligible_minutes) - BigInt(a.total!) * BigInt(b.eligible_minutes);
    return diff > 0n ? 1 : diff < 0n ? -1 : a.person_id < b.person_id ? -1 : 1;
  });
  return { request, snapshot_id: metadata.snapshot_id, definition: request.metric === "goals" ? "goals" : "fpl_assists",
    players, ranked_person_ids: ranked.map(p => p.person_id) };
}
