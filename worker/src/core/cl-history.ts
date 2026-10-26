import type { Env } from "./db";
import type { CompiledCatalog } from "./feasibility";

export interface CLHistoryRecord {
  season: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goals: number;
  goals_against: number;
  snapshot_id: string;
}

export type CLHistoryEntry =
  | { status: "observed"; row: CLHistoryRecord }
  | { status: "gap"; season: string };

export interface CLHistoryResult {
  snapshot_id: string | null;
  entries: CLHistoryEntry[];
}

const SEASON_RE = /^(\d{4})-(\d{2})$/;
const SNAPSHOT_RE = /^[a-f0-9]{64}$/;
const MAX_COVERAGE_SEASONS = 20;

function validSeason(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = SEASON_RE.exec(value);
  return !!match && Number(match[2]) === (Number(match[1]) + 1) % 100;
}

function safeCount(value: unknown, positive = false): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && (positive ? value > 0 : value >= 0);
}

function eligibleSeasons(catalog: CompiledCatalog): string[] {
  if (!Array.isArray(catalog.coverage)) {
    throw new Error("invalid CL history catalog");
  }
  const seasons = new Set<string>();
  for (const cell of catalog.coverage) {
    if (cell.metric !== "goals" || cell.entity_type !== "season" || cell.granularity !== "box_score" ||
        cell.competition !== "CL" || cell.source_id !== "openfootball") continue;
    if (!validSeason(cell.season) || seasons.has(cell.season)) throw new Error("invalid CL history coverage");
    seasons.add(cell.season);
  }
  if (seasons.size > MAX_COVERAGE_SEASONS) throw new Error("invalid CL history coverage");
  return [...seasons].sort((a, b) => Number(b.slice(0, 4)) - Number(a.slice(0, 4)));
}

function validateRows(rows: unknown[], seasons: readonly string[], snapshotId: string): CLHistoryRecord[] {
  const allowed = new Set(seasons);
  const seen = new Set<string>();
  return rows.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid CL history row");
    const row = value as Record<string, unknown>;
    const keys = ["season", "played", "won", "drawn", "lost", "goals", "goals_against", "snapshot_id"];
    if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key)) ||
        !validSeason(row.season) || !allowed.has(row.season) || seen.has(row.season) ||
        !safeCount(row.played, true) || !safeCount(row.won) || !safeCount(row.drawn) || !safeCount(row.lost) ||
        !safeCount(row.goals) || !safeCount(row.goals_against) || row.won + row.drawn + row.lost !== row.played ||
        row.snapshot_id !== snapshotId) throw new Error("invalid CL history row");
    seen.add(row.season);
    return row as unknown as CLHistoryRecord;
  });
}

/** Read observed Champions League season totals against exact catalog coverage.
 * Pass the request's already-read latest snapshot id; without it, read it once. */
export async function clHistoryRows(env: Env, catalog: CompiledCatalog, snapshotId?: string | null): Promise<CLHistoryResult> {
  const seasons = eligibleSeasons(catalog);
  const before = { snapshot_id: snapshotId !== undefined ? snapshotId : (await env.DB.prepare(
    "SELECT snapshot_id FROM snapshots ORDER BY created_at DESC LIMIT 1",
  ).first<{ snapshot_id: unknown }>())?.snapshot_id };
  if (typeof before.snapshot_id !== "string" || !SNAPSHOT_RE.test(before.snapshot_id)) {
    return { snapshot_id: null, entries: [] };
  }
  if (seasons.length === 0) return { snapshot_id: before.snapshot_id, entries: [] };
  const placeholders = seasons.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    `SELECT season, played, won, drawn, lost, goals, goals_against, snapshot_id
       FROM season_stats
      WHERE competition = ? AND season IN (${placeholders})
      ORDER BY season DESC LIMIT ${seasons.length + 1}`,
  ).bind("CL", ...seasons).all<CLHistoryRecord>();
  if ((results ?? []).length > seasons.length) throw new Error("invalid CL history row");
  const rows = validateRows(results ?? [], seasons, before.snapshot_id);
  const observed = new Map(rows.map((row) => [row.season, row]));
  return {
    snapshot_id: before.snapshot_id,
    entries: seasons.map((season) => {
      const row = observed.get(season);
      return row ? { status: "observed", row } : { status: "gap", season };
    }),
  };
}
