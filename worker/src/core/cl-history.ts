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
  stage_reached: StageCode | null;
}

export type StageCode = "group_stage" | "league_phase" | "knockout_playoff" | "round_of_16" |
  "quarter_final" | "semi_final" | "final" | "winner";

const STAGE_CODES = new Set<StageCode>([
  "group_stage", "league_phase", "knockout_playoff", "round_of_16",
  "quarter_final", "semi_final", "final", "winner",
]);

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

export function validSeason(value: unknown): value is string {
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

function validateRows(rows: unknown[], seasons: readonly string[], snapshotId: string): Omit<CLHistoryRecord, "stage_reached">[] {
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
        row.snapshot_id !== snapshotId) {
      throw new Error("invalid CL history row");
    }
    seen.add(row.season);
    return row as unknown as Omit<CLHistoryRecord, "stage_reached">;
  });
}

/** Read totals against the latest snapshot, then load stage cells independently. */
export async function clHistoryRead(env: Env, catalog: CompiledCatalog): Promise<{ result: CLHistoryResult; sourcesJson: unknown }> {
  const seasons = eligibleSeasons(catalog);
  const statements = [env.DB.prepare("SELECT snapshot_id, sources_json FROM snapshots ORDER BY created_at DESC LIMIT 1")];
  if (seasons.length > 0) {
    const placeholders = seasons.map(() => "?").join(", ");
    statements.push(env.DB.prepare(
      `SELECT season, played, won, drawn, lost, goals, goals_against, snapshot_id
       FROM season_stats WHERE competition = ? AND season IN (${placeholders})
       ORDER BY season DESC LIMIT ${seasons.length + 1}`,
    ).bind("CL", ...seasons));
  }
  const [latest, rowsResult] = await env.DB.batch(statements);
  const meta = (latest?.results ?? [])[0] as { snapshot_id?: unknown; sources_json?: unknown } | undefined;
  const snapshotId = meta?.snapshot_id;
  if (typeof snapshotId !== "string" || !SNAPSHOT_RE.test(snapshotId)) {
    return { result: { snapshot_id: null, entries: [] }, sourcesJson: undefined };
  }
  if (seasons.length === 0) return { result: { snapshot_id: snapshotId, entries: [] }, sourcesJson: meta?.sources_json };
  const results = (rowsResult?.results ?? []) as unknown[];
  if (results.length > seasons.length) throw new Error("invalid CL history row");
  const rows = validateRows(results, seasons, snapshotId);
  const stages = new Map<string, StageCode>();
  try {
    const stageResult = await env.DB.prepare(
      `SELECT season, stage_reached, snapshot_id FROM cl_season_stage
       WHERE season IN (${seasons.map(() => "?").join(", ")}) AND snapshot_id = ?
       ORDER BY season DESC LIMIT ${seasons.length + 1}`,
    ).bind(...seasons, snapshotId).all<unknown>();
    const stageRows = stageResult.results ?? [];
    if (stageRows.length <= seasons.length) {
      const seen = new Set<string>();
      for (const value of stageRows) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const row = value as Record<string, unknown>;
        if (!validSeason(row.season) || !seasons.includes(row.season) || seen.has(row.season)) continue;
        seen.add(row.season);
        if (row.snapshot_id === snapshotId && typeof row.stage_reached === "string" &&
            STAGE_CODES.has(row.stage_reached as StageCode)) stages.set(row.season, row.stage_reached as StageCode);
      }
    }
  } catch {
    // Stage storage is optional for serving totals; unavailable cells stay null.
  }
  const observed = new Map(rows.map((row) => [row.season, { ...row, stage_reached: stages.get(row.season) ?? null }]));
  return {
    sourcesJson: meta?.sources_json,
    result: {
      snapshot_id: snapshotId,
      entries: seasons.map((season) => {
        const row = observed.get(season);
        return row ? { status: "observed", row } : { status: "gap", season };
      }),
    },
  };
}

/** Observed Champions League season totals against exact catalog coverage. */
export async function clHistoryRows(env: Env, catalog: CompiledCatalog): Promise<CLHistoryResult> {
  return (await clHistoryRead(env, catalog)).result;
}
