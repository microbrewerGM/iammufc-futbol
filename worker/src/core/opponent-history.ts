import { parseSeasonSplitRequest, type SeasonSplitCatalog, type SeasonSplitRequest, type SeasonSplitRow } from "./season-splits";
import type { Env } from "./db";
import { recordReadTiming } from "./timing";

/** Explicit IDs approved by the private season_splits_seed._CLUBS crosswalk. */
export const APPROVED_OPPONENT_IDS: ReadonlySet<string> = new Set([
  "club:1001", "club:1002", "club:1003", "club:1004", "club:1005", "club:1006", "club:1007", "club:1008",
  "club:1009", "club:1010", "club:1011", "club:1012", "club:1013", "club:1014", "club:1015", "club:1017",
  "club:1018", "club:1019", "club:1020", "club:1021", "club:1022", "club:1023", "club:1024", "club:1025",
  "club:1026", "club:1027", "club:1028", "club:1029", "club:1030", "club:1031", "club:1032", "club:1033",
  "club:1034", "club:1035", "club:1036", "club:1037", "club:1038", "club:1039", "club:1040", "club:1041",
  "club:1042", "club:1043", "club:1044",
]);
type Coverage = "complete" | "partial" | "missing";
type Counts = Pick<SeasonSplitRow, "played" | "won" | "drawn" | "lost" | "goals_for" | "goals_against">;
export interface HistoryRecord extends Counts {
  points: number; goal_difference: number; rate_denominator: number;
  points_per_match: number | null; goals_for_per_match: number | null;
  goals_against_per_match: number | null; win_rate: number | null; lineage: string[];
}
export interface OpponentHistoryResult {
  request: SeasonSplitRequest;
  snapshot_id: string;
  seasons: { season: string; coverage: Coverage; status: "available" | "no_matches" | "missing_capability"; record?: HistoryRecord }[];
  combined?: HistoryRecord;
  status: "available" | "partial" | "no_matches" | "missing_capability";
  partial: boolean;
  contributing_seasons: string[];
}
export interface OpponentHistoryQuery {
  sql: string;
  bindings: readonly unknown[];
}
const fail = (s: string): never => { throw new Error(`Invalid opponent history: ${s}`); };
const MAX_ROWS = 4096;
const COUNTERS = ["played", "won", "drawn", "lost", "goals_for", "goals_against"] as const;

/** Exact bounded query shape used with seasonSplitFacts' shared split table. */
export function buildOpponentHistoryQuery(request: SeasonSplitRequest, catalog: SeasonSplitCatalog): OpponentHistoryQuery {
  const snapshotId = catalog?.snapshot_id;
  if (request.group_by !== "opponent" || request.opponent_id === null ||
      !APPROVED_OPPONENT_IDS.has(request.opponent_id) || typeof snapshotId !== "string" || !/^[0-9a-f]{64}$/.test(snapshotId)) fail("query selection");
  const marks = request.seasons.map(() => "?").join(",");
  const venueClause = request.venue === null ? "" : " AND venue = ?";
  const opponentClause = " AND opponent_id = ?";
  return {
    sql: `SELECT snapshot_id, season, competition, venue, opponent_id, played, won, drawn, lost,\n            goals_for, goals_against, lineage_json\n       FROM season_splits WHERE snapshot_id = ? AND season IN (${marks})${venueClause}${opponentClause}\n       ORDER BY season, venue, opponent_id LIMIT ${MAX_ROWS + 1}`,
    bindings: [snapshotId, ...request.seasons, ...(request.venue === null ? [] : [request.venue]), request.opponent_id],
  };
}

/** Execute the bounded production query against the supplied catalog snapshot. */
export async function readOpponentHistory(env: Env, value: unknown, metadata: unknown): Promise<OpponentHistoryResult> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) fail("catalog");
  const catalog = metadata as SeasonSplitCatalog;
  let request: SeasonSplitRequest;
  try { request = parseSeasonSplitRequest(value, Array.isArray(catalog.seasons) ? catalog.seasons.map(s => s.season) : []); }
  catch { return fail("selection"); }
  const query = buildOpponentHistoryQuery(request, catalog);
  const result = await env.DB.prepare(query.sql).bind(...query.bindings).all<SeasonSplitRow & { lineage_json: string }>();
  recordReadTiming("readOpponentHistory", result.meta);
  const { results } = result;
  // The publication reader may withhold an entire season for bad lineage or
  // incomplete totals. Do not restore those raw rows in this second read.
  // Keep the raw bound and reject identity/selection corruption before omission.
  if (!Array.isArray(results) || results.length > MAX_ROWS) return queryOpponentHistory(request, catalog, results);
  const missing = new Set(catalog.seasons.filter(entry => entry.coverage === "missing").map(entry => entry.season));
  const visible = results.filter(row => !(row && missing.has(row.season) &&
    request.seasons.includes(row.season) && row.snapshot_id === catalog.snapshot_id &&
    row.competition === request.competition && row.opponent_id === request.opponent_id &&
    (row.venue === "home" || row.venue === "away") && (request.venue === null || row.venue === request.venue)));
  return queryOpponentHistory(request, catalog, visible);
}

function makeRecord(rows: readonly SeasonSplitRow[]): HistoryRecord {
  const t: Counts = { played: 0, won: 0, drawn: 0, lost: 0, goals_for: 0, goals_against: 0 };
  const lineage = new Set<string>();
  for (const row of rows) {
    for (const key of COUNTERS) {
      const sum = t[key] + row[key];
      if (!Number.isSafeInteger(sum)) fail("counter overflow");
      t[key] = sum;
    }
    row.lineage.forEach(x => lineage.add(x));
  }
  const points = 3 * t.won + t.drawn;
  if (!Number.isSafeInteger(points)) fail("counter overflow");
  const goal_difference = t.goals_for - t.goals_against;
  if (!Number.isSafeInteger(goal_difference)) fail("counter overflow");
  const rate = (n: number) => t.played ? n / t.played : null;
  return { ...t, points, goal_difference, rate_denominator: t.played,
    points_per_match: rate(points), goals_for_per_match: rate(t.goals_for),
    goals_against_per_match: rate(t.goals_against), win_rate: rate(t.won), lineage: [...lineage].sort() };
}

/** Validate the closed parser input and every bounded row before projection. */
export function queryOpponentHistory(value: unknown, metadata: unknown, rowsValue: unknown): OpponentHistoryResult {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) fail("catalog");
  const cat = metadata as SeasonSplitCatalog;
  // The generic reader's parser owns closed request and catalog validation.
  let request: SeasonSplitRequest;
  try { request = parseSeasonSplitRequest(value, Array.isArray(cat.seasons) ? cat.seasons.map(s => s.season) : []); }
  catch { return fail("selection"); }
  if (request.group_by !== "opponent" || request.opponent_id === null ||
      !APPROVED_OPPONENT_IDS.has(request.opponent_id)) fail("opponent");
  if (typeof cat.snapshot_id !== "string" || !/^[0-9a-f]{64}$/.test(cat.snapshot_id) || !Array.isArray(cat.seasons) || cat.seasons.length > 256) fail("catalog");
  const coverageBySeason = new Map<string, Coverage>();
  for (const entry of cat.seasons) {
    if (!entry || typeof entry !== "object" || typeof entry.season !== "string" ||
        !/^\d{4}-\d{2}$/.test(entry.season) || Number(entry.season.slice(-2)) !== (Number(entry.season.slice(0, 4)) + 1) % 100 ||
        (entry.coverage !== "complete" && entry.coverage !== "partial" && entry.coverage !== "missing") || coverageBySeason.has(entry.season)) fail("catalog");
    coverageBySeason.set(entry.season, entry.coverage);
  }
  if (!Array.isArray(rowsValue) || rowsValue.length > MAX_ROWS) fail("row count");
  const selected = new Set(request.seasons), seen = new Set<string>(), rows: SeasonSplitRow[] = [];
  const seasonsSeen = new Set<string>(), opponentsSeen = new Set<string>();
  for (const candidate of rowsValue as unknown[]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) fail("row");
    const row = candidate as Record<string, unknown>;
    let lineage: unknown = row.lineage;
    if (lineage === undefined && typeof row.lineage_json === "string") {
      try { lineage = JSON.parse(row.lineage_json) as unknown; } catch { fail("lineage"); }
    }
    if (!Array.isArray(lineage) || lineage.length < 1 || lineage.length > 32 ||
        !lineage.every(x => typeof x === "string" && x.length > 0 && x.length <= 128 && x.trim() === x) ||
        new Set(lineage).size !== lineage.length) fail("lineage");
    if (row.competition !== "PL" || (row.venue !== "home" && row.venue !== "away") ||
        typeof row.opponent_id !== "string" || !APPROVED_OPPONENT_IDS.has(row.opponent_id)) fail("row dimensions");
    if (typeof row.season !== "string" || coverageBySeason.get(row.season) === undefined || coverageBySeason.get(row.season) === "missing" ||
        row.snapshot_id !== cat.snapshot_id) fail("snapshot or coverage");
    for (const key of COUNTERS) if (typeof row[key] !== "number" || !Number.isSafeInteger(row[key]) || row[key] < 0) fail("counter");
    if (row.played !== 1 || Number(row.won) + Number(row.drawn) + Number(row.lost) !== 1) fail("base grain");
    if ((row.won === 1 && Number(row.goals_for) <= Number(row.goals_against)) ||
        (row.drawn === 1 && row.goals_for !== row.goals_against) ||
        (row.lost === 1 && Number(row.goals_for) >= Number(row.goals_against))) fail("score outcome");
    const season = row.season as string;
    const opponentId = row.opponent_id as string;
    const rowVenue = row.venue as "home" | "away";
    const validLineage = lineage as string[];
    seasonsSeen.add(season);
    opponentsSeen.add(opponentId);
    if (seasonsSeen.size > 16 || opponentsSeen.size > 128) fail("input dimensions");
    const grain = JSON.stringify([row.season, row.competition, row.venue, row.opponent_id]);
    if (seen.has(grain)) fail("duplicate grain");
    seen.add(grain);
    if (!selected.has(season) || opponentId !== request.opponent_id ||
        (request.venue !== null && rowVenue !== request.venue)) fail("row dimensions differ from request");
    rows.push({ ...row, lineage: [...validLineage] } as unknown as SeasonSplitRow);
  }
  const seasons = request.seasons.map(season => {
    const coverage = coverageBySeason.get(season)!;
    const matches = rows.filter(r => r.season === season);
    const status = matches.length ? "available" as const : coverage === "complete" ? "no_matches" as const : "missing_capability" as const;
    return { season, coverage, status, ...(matches.length ? { record: makeRecord(matches) } : {}) };
  });
  const contributing = seasons.filter(s => s.record).map(s => s.season);
  const partial = seasons.some(s => s.coverage !== "complete");
  const status = partial ? "partial" : contributing.length ? "available" : "no_matches";
  return { request, snapshot_id: cat.snapshot_id, seasons, ...(rows.length ? { combined: makeRecord(rows) } : {}), status, partial, contributing_seasons: contributing };
}
