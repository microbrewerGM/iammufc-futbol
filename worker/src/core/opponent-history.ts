import { parseSeasonSplitRequest, type SeasonSplitCatalog, type SeasonSplitRow } from "./season-splits";

/** The frozen crosswalk namespace has IDs 1001–1044; 1016 is Manchester United. */
export const APPROVED_OPPONENT_IDS: ReadonlySet<string> = new Set(
  Array.from({ length: 44 }, (_, i) => `club:${1001 + i}`).filter(id => id !== "club:1016"),
);
type Coverage = "complete" | "partial" | "missing";
type Counts = Pick<SeasonSplitRow, "played" | "won" | "drawn" | "lost" | "goals_for" | "goals_against">;
export interface HistoryRecord extends Counts {
  points: number; goal_difference: number; rate_denominator: number;
  points_per_match: number | null; goals_for_per_match: number | null;
  goals_against_per_match: number | null; win_rate: number | null; lineage: string[];
}
export interface OpponentHistoryResult {
  request: ReturnType<typeof parseSeasonSplitRequest>;
  snapshot_id: string;
  seasons: { season: string; coverage: Coverage; status: "available" | "no_matches" | "missing_capability"; record?: HistoryRecord }[];
  combined?: HistoryRecord;
  status: "available" | "no_matches" | "missing_capability";
  partial: boolean;
  contributing_seasons: string[];
}
const fail = (s: string): never => { throw new Error(`Invalid opponent history: ${s}`); };
function makeRecord(rows: readonly SeasonSplitRow[]): HistoryRecord {
  const t: Counts = { played: 0, won: 0, drawn: 0, lost: 0, goals_for: 0, goals_against: 0 };
  const lineage = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(t) as (keyof Counts)[]) {
      const sum = t[key] + row[key];
      if (!Number.isSafeInteger(sum)) fail("counter overflow");
      t[key] = sum;
    }
    row.lineage.forEach(x => lineage.add(x));
  }
  const points = 3 * t.won + t.drawn;
  if (!Number.isSafeInteger(points)) fail("counter overflow");
  const rate = (n: number) => t.played ? n / t.played : null;
  return { ...t, points, goal_difference: t.goals_for - t.goals_against, rate_denominator: t.played,
    points_per_match: rate(points), goals_for_per_match: rate(t.goals_for),
    goals_against_per_match: rate(t.goals_against), win_rate: rate(t.won), lineage: [...lineage].sort() };
}

/** Produce a bounded, deterministic projection from the already bounded DB read. */
export function queryOpponentHistory(value: unknown, metadata: unknown, rowsValue: unknown): OpponentHistoryResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("request");
  const raw = value as Record<string, unknown>;
  if (raw.group_by !== "opponent" || typeof raw.opponent_id !== "string" ||
      !/^club:[1-9][0-9]{0,17}$/.test(raw.opponent_id) || !APPROVED_OPPONENT_IDS.has(raw.opponent_id)) fail("opponent");
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) fail("catalog");
  const cat = metadata as SeasonSplitCatalog;
  if (typeof cat.snapshot_id !== "string" || !Array.isArray(cat.seasons)) fail("catalog");
  let request: ReturnType<typeof parseSeasonSplitRequest>;
  try { request = parseSeasonSplitRequest(value, cat.seasons.map(s => s.season)); }
  catch { return fail("selection"); }
  if (request.opponent_id === null || !APPROVED_OPPONENT_IDS.has(request.opponent_id)) fail("opponent");
  if (!Array.isArray(rowsValue) || rowsValue.length > 4096) fail("row count");
  const selected = new Set(request.seasons), seen = new Set<string>(), rows: SeasonSplitRow[] = [];
  for (const candidate of rowsValue as unknown[]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) fail("row");
    const row = candidate as Record<string, unknown>;
    // DB rows carry lineage_json; the adapter's validated SeasonSplitRow carries lineage.
    let lineage: unknown = row.lineage;
    if (lineage === undefined && typeof row.lineage_json === "string") {
      try { lineage = JSON.parse(row.lineage_json) as unknown; } catch { fail("lineage"); }
    }
    if (!Array.isArray(lineage) || lineage.length < 1 || lineage.length > 32) fail("lineage");
    const validLineage: string[] = [];
    for (const source of lineage as unknown[]) {
      if (typeof source !== "string" || !source.trim() || source.trim() !== source) fail("lineage");
      validLineage.push(source as string);
    }
    if (new Set(validLineage).size !== validLineage.length) fail("lineage");
    if (row.competition !== "PL" || (row.venue !== "home" && row.venue !== "away") ||
        typeof row.opponent_id !== "string" || !APPROVED_OPPONENT_IDS.has(row.opponent_id)) fail("row dimensions");
    if (row.snapshot_id !== cat.snapshot_id || typeof row.season !== "string" ||
        !cat.seasons.some(s => s.season === row.season && s.coverage !== "missing")) fail("snapshot or coverage");
    for (const key of ["played", "won", "drawn", "lost", "goals_for", "goals_against"] as const) {
      if (typeof row[key] !== "number" || !Number.isSafeInteger(row[key]) || row[key] < 0) fail("counter");
    }
    if (row.played !== 1 || Number(row.won) + Number(row.drawn) + Number(row.lost) !== 1) fail("base grain");
    if ((row.won === 1 && Number(row.goals_for) <= Number(row.goals_against)) ||
        (row.drawn === 1 && row.goals_for !== row.goals_against) ||
        (row.lost === 1 && Number(row.goals_for) >= Number(row.goals_against))) fail("score outcome");
    const season = row.season as string;
    const opponentId = row.opponent_id as string;
    const grain = JSON.stringify([season, row.competition, row.venue, opponentId]);
    if (seen.has(grain)) fail("duplicate grain");
    seen.add(grain);
    if (selected.has(season) && opponentId === request.opponent_id &&
        (request.venue === null || row.venue === request.venue)) {
      rows.push({ ...row, lineage: [...validLineage] } as unknown as SeasonSplitRow);
    }
  }
  const seasons = request.seasons.map(season => {
    const coverage = cat.seasons.find(s => s.season === season)!.coverage;
    const matches = rows.filter(r => r.season === season);
    const status = matches.length ? "available" as const : coverage === "complete" ? "no_matches" as const : "missing_capability" as const;
    return { season, coverage, status, ...(matches.length ? { record: makeRecord(matches) } : {}) };
  });
  const contributing = seasons.filter(s => s.record).map(s => s.season);
  const partial = seasons.some(s => s.coverage !== "complete");
  const status = contributing.length ? "available" : partial ? "missing_capability" : "no_matches";
  return { request, snapshot_id: cat.snapshot_id, seasons, ...(rows.length ? { combined: makeRecord(rows) } : {}), status, partial, contributing_seasons: contributing };
}
