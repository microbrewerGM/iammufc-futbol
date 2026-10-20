/** Pure B14 query seam. No reads, SQL, capability inference or publication.
 * Rows are the producer's single season/PL/venue/opponent grain. Catalog coverage
 * is supplied by a validated publication adapter; row presence never proves it.
 */
export type Venue = "home" | "away";
export type SplitCoverage = "complete" | "partial" | "missing";
export interface SeasonSplitRequest {
  schema_version: 1;
  competition: "PL";
  seasons: string[];
  group_by: "venue" | "opponent";
  venue: Venue | null;
  opponent_id: string | null;
}
export interface SeasonSplitCatalog {
  snapshot_id: string;
  seasons: { season: string; coverage: SplitCoverage }[];
}
/** Exact snake_case counter/identity projection from private SeasonSplit. */
export interface SeasonSplitRow {
  season: string;
  competition: "PL";
  venue: Venue;
  opponent_id: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goals_for: number;
  goals_against: number;
  snapshot_id: string;
  lineage: string[];
}
interface Counters {
  played: number; won: number; drawn: number; lost: number;
  goals_for: number; goals_against: number;
}
export interface SeasonSplitGroup extends Counters {
  key: string;
  points: number;
  goal_difference: number;
  /** All rates divide by this group's played, including partial schedules. */
  rate_denominator: number;
  points_per_match: number | null;
  goals_for_per_match: number | null;
  goals_against_per_match: number | null;
  win_rate: number | null;
  contributing_seasons: string[];
  lineage: string[];
}
export interface SeasonSplitResult {
  request: SeasonSplitRequest;
  snapshot_id: string;
  status: "available" | "no_matches" | "missing_capability";
  partial: boolean;
  coverage: { season: string; coverage: SplitCoverage }[];
  groups: SeasonSplitGroup[];
}
const COUNTERS = ["played", "won", "drawn", "lost", "goals_for", "goals_against"] as const;
const REQUEST_KEYS = ["schema_version", "competition", "seasons", "group_by", "venue", "opponent_id"];
const ROW_KEYS = ["season", "competition", "venue", "opponent_id", ...COUNTERS, "snapshot_id", "lineage"];
const MAX_ROWS = 4096;
function fail(message: string): never { throw new Error(`Invalid season splits: ${message}`); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected object");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some(k => !Object.hasOwn(result, k))) {
    fail("closed object fields");
  }
  return result;
}
function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value;
}
function season(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{4}-[0-9]{2}$/.test(value)
    && Number(value.slice(-2)) === (Number(value.slice(0, 4)) + 1) % 100;
}
function club(value: unknown): value is string {
  return typeof value === "string" && /^club:[1-9][0-9]{0,17}$/.test(value);
}
function venue(value: unknown): value is Venue { return value === "home" || value === "away"; }
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function add(a: number, b: number): number {
  const value = a + b;
  if (!Number.isSafeInteger(value)) fail("counter overflow");
  return value;
}
function catalog(value: unknown): SeasonSplitCatalog {
  const obj = record(value, ["snapshot_id", "seasons"]);
  if (!identity(obj.snapshot_id) || !Array.isArray(obj.seasons) || obj.seasons.length > 256) fail("catalog");
  const seen = new Set<string>();
  const seasons = Array.from(obj.seasons, (value: unknown): { season: string; coverage: SplitCoverage } => {
    const entry = record(value, ["season", "coverage"]);
    if (!season(entry.season) || seen.has(entry.season)) fail("catalog season");
    if (entry.coverage !== "complete" && entry.coverage !== "partial" && entry.coverage !== "missing") fail("coverage");
    seen.add(entry.season);
    return { season: entry.season, coverage: entry.coverage };
  });
  return { snapshot_id: obj.snapshot_id, seasons };
}
/** Reject unsupported/duplicate selections; return canonical ascending seasons. */
export function parseSeasonSplitRequest(value: unknown, catalogSeasons: readonly string[]): SeasonSplitRequest {
  const obj = record(value, REQUEST_KEYS);
  if (obj.schema_version !== 1 || obj.competition !== "PL") fail("version or competition");
  if (obj.group_by !== "venue" && obj.group_by !== "opponent") fail("group_by");
  if (obj.venue !== null && !venue(obj.venue)) fail("venue");
  if (obj.opponent_id !== null && !club(obj.opponent_id)) fail("opponent");
  if (!Array.isArray(obj.seasons) || obj.seasons.length < 1 || obj.seasons.length > 16) fail("season count");
  const seasons: string[] = [];
  for (const item of obj.seasons) {
    if (!season(item) || !catalogSeasons.includes(item) || seasons.includes(item)) fail("season selection");
    seasons.push(item);
  }
  return { schema_version: 1, competition: "PL", seasons: seasons.sort(), group_by: obj.group_by,
    venue: obj.venue, opponent_id: obj.opponent_id };
}
function row(value: unknown, metadata: SeasonSplitCatalog): SeasonSplitRow {
  const obj = record(value, ROW_KEYS);
  if (!season(obj.season) || !metadata.seasons.some(s => s.season === obj.season && s.coverage !== "missing")) fail("row season coverage");
  if (obj.competition !== "PL" || !venue(obj.venue) || !club(obj.opponent_id)) fail("row dimensions");
  if (obj.snapshot_id !== metadata.snapshot_id) fail("mixed snapshots");
  for (const key of COUNTERS) if (!integer(obj[key])) fail("counter");
  // Validation above is runtime validation of every field, not a trust cast at entry.
  const counters = obj as unknown as Counters;
  if (add(add(counters.won, counters.drawn), counters.lost) !== counters.played) fail("WDL reconciliation");
  if (counters.played !== 1) fail("expected single completed fixture grain");
  if ((counters.won === 1 && counters.goals_for <= counters.goals_against)
      || (counters.drawn === 1 && counters.goals_for !== counters.goals_against)
      || (counters.lost === 1 && counters.goals_for >= counters.goals_against)) fail("score outcome");
  if (!Array.isArray(obj.lineage) || obj.lineage.length < 1 || obj.lineage.length > 32
      || ![...obj.lineage].every(identity) || new Set(obj.lineage).size !== obj.lineage.length) fail("lineage");
  return { season: obj.season, competition: "PL", venue: obj.venue, opponent_id: obj.opponent_id,
    ...Object.fromEntries(COUNTERS.map(k => [k, obj[k]])) as unknown as Counters,
    snapshot_id: metadata.snapshot_id, lineage: [...obj.lineage] as string[] };
}
/** Validate the whole bounded input before filtering; never hide bad rows or
 * duplicate grains behind a filter. Missing seasons retain explicit coverage.
 * Empty partial capability is unknown, never an asserted zero-match result.
 */
export function querySeasonSplits(value: unknown, metadataValue: unknown, rowsValue: unknown): SeasonSplitResult {
  const metadata = catalog(metadataValue);
  const request = parseSeasonSplitRequest(value, metadata.seasons.map(s => s.season));
  if (!Array.isArray(rowsValue) || rowsValue.length > MAX_ROWS) fail("row count");
  const seen = new Set<string>();
  const opponents = new Set<string>();
  const seasons = new Set<string>();
  const selected = new Set(request.seasons);
  const buckets = new Map<string, { totals: Counters; seasons: Set<string>; lineage: Set<string> }>();
  for (const value of rowsValue) {
    const current = row(value, metadata);
    const grain = JSON.stringify([current.season, current.competition, current.venue, current.opponent_id]);
    if (seen.has(grain)) fail("duplicate grain");
    seen.add(grain);
    opponents.add(current.opponent_id);
    seasons.add(current.season);
    if (seasons.size > 16) fail("input season count");
    if (opponents.size > 128) fail("opponent count");
    if (!selected.has(current.season) || (request.venue !== null && current.venue !== request.venue)
        || (request.opponent_id !== null && current.opponent_id !== request.opponent_id)) continue;
    const key = request.group_by === "venue" ? current.venue : current.opponent_id;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { totals: { played: 0, won: 0, drawn: 0, lost: 0, goals_for: 0, goals_against: 0 },
        seasons: new Set(), lineage: new Set() };
      buckets.set(key, bucket);
    }
    for (const k of COUNTERS) bucket.totals[k] = add(bucket.totals[k], current[k]);
    if (current.played > 0) bucket.seasons.add(current.season);
    current.lineage.forEach(ref => bucket.lineage.add(ref));
  }
  const groups = [...buckets].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, bucket]) => {
    const t = bucket.totals;
    const points = add(add(t.won, t.won), add(t.won, t.drawn));
    const rate = (n: number) => t.played ? n / t.played : null;
    return { key, ...t, points, goal_difference: t.goals_for - t.goals_against,
      rate_denominator: t.played, points_per_match: rate(points), goals_for_per_match: rate(t.goals_for),
      goals_against_per_match: rate(t.goals_against), win_rate: rate(t.won),
      contributing_seasons: [...bucket.seasons].sort(), lineage: [...bucket.lineage].sort() };
  });
  if (groups.length > (request.group_by === "venue" ? 2 : 128)) fail("group count");
  const coverage = request.seasons.map(s => ({ ...metadata.seasons.find(entry => entry.season === s)! }));
  const partial = coverage.some(s => s.coverage !== "complete");
  const hasMatches = groups.some(g => g.played > 0);
  return { request, snapshot_id: metadata.snapshot_id, partial, coverage, groups,
    status: hasMatches ? "available" : partial ? "missing_capability" : "no_matches" };
}
