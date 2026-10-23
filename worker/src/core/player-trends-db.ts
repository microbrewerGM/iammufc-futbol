import type { D1Database } from "@cloudflare/workers-types";
import type { CoverageCell } from "./feasibility";
import type { PlayerTrendRow, PlayerTrendsRequest, TrendMetric } from "./player-trends";

/** SQL is exported so the exact bounded statement and its placeholders stay pinned. */
export const PLAYER_TRENDS_SNAPSHOT_SQL = `SELECT r.snapshot_id FROM publication_runs r
  JOIN snapshots s ON s.snapshot_id = r.snapshot_id
  ORDER BY r.run_id DESC LIMIT 1`;

export const PLAYER_TRENDS_FACTS_SQL = `SELECT i.person_id, s.season, s.competition,
  s.goals, s.assists, s.minutes, s.snapshot_id
  FROM player_season_stats s JOIN player_identities i ON i.player_id = s.player_id
  WHERE i.person_id IN (/*PERSONS*/) AND s.season IN (/*SEASONS*/) AND i.season = s.season
    AND s.competition = 'PL' AND s.snapshot_id = ?
  ORDER BY i.person_id, s.season LIMIT 41`;

export const PLAYER_TRENDS_MAX_FACTS = 40;
const SOURCES = new Set(["fpl"]);

function placeholders(values: readonly string[]): string {
  return values.map(() => "?").join(",");
}

export function playerTrendsFactsSql(personCount: number, seasonCount: number): string {
  if (!Number.isInteger(personCount) || personCount < 1 || personCount > 5 ||
      !Number.isInteger(seasonCount) || seasonCount < 1 || seasonCount > 8) {
    throw new Error("invalid player trends SQL bounds");
  }
  return PLAYER_TRENDS_FACTS_SQL
    .replace("/*PERSONS*/", placeholders(Array(personCount).fill("?")))
    .replace("/*SEASONS*/", placeholders(Array(seasonCount).fill("?")));
}

function usable(cell: CoverageCell | undefined, metric: string, season: string): cell is CoverageCell {
  return !!cell && cell.metric === metric && cell.entity_type === "player" &&
    cell.granularity === "box_score" && cell.competition === "PL" && cell.season === season &&
    cell.source_id === "fpl" && SOURCES.has(cell.source_id) && cell.redistributable &&
    cell.cost_class === "cheap";
}

function validSeason(season: string): boolean {
  return /^\d{4}-\d{2}$/.test(season) && Number(season.slice(-2)) === (Number(season.slice(0, 4)) + 1) % 100;
}

function currentPublication(db: D1Database): Promise<{ snapshot_id: unknown } | null> {
  return db.prepare(PLAYER_TRENDS_SNAPSHOT_SQL).first<{ snapshot_id: unknown }>();
}

export async function playerTrendsFacts(
  db: D1Database,
  request: PlayerTrendsRequest,
  snapshotId: string,
  catalogPeople: readonly string[],
  catalogSeasons: readonly string[],
  coverage: readonly (CoverageCell & { feasibility?: string })[],
): Promise<PlayerTrendRow[]> {
  if (!/^[0-9a-f]{64}$/.test(snapshotId) || request.competition !== "PL" ||
      request.person_ids.length < 1 || request.person_ids.length > 5 ||
      request.seasons.length < 1 || request.seasons.length > 8 ||
      new Set(request.person_ids).size !== request.person_ids.length ||
      new Set(request.seasons).size !== request.seasons.length ||
      request.person_ids.some((id) => !/^fpl:code:[1-9][0-9]{0,17}$/.test(id) || !catalogPeople.includes(id)) ||
      request.seasons.some((season) => !validSeason(season) || !catalogSeasons.includes(season)) ||
      request.seasons.some((season, index) => index > 0 && request.seasons[index - 1]! >= season)) {
    throw new Error("invalid player trends read");
  }

  const metric: TrendMetric = request.metric;
  for (const season of request.seasons) {
    const metricCell = coverage.find((cell) => cell.metric === metric && cell.season === season);
    const minutesCell = coverage.find((cell) => cell.metric === "minutes" && cell.season === season);
    const metricFeasibility = (metricCell as (CoverageCell & { feasibility?: string }) | undefined)?.feasibility;
    const minutesFeasibility = (minutesCell as (CoverageCell & { feasibility?: string }) | undefined)?.feasibility;
    if (!usable(metricCell, metric, season) || !usable(minutesCell, "minutes", season) ||
        !["available", "computable_now_queued"].includes(metricFeasibility ?? "") ||
        !["available", "computable_now_queued"].includes(minutesFeasibility ?? "")) {
      throw new Error("player trends coverage or rights unavailable");
    }
  }

  const before = await currentPublication(db);
  if (before?.snapshot_id !== snapshotId) throw new Error("stale player trends publication");
  const sql = playerTrendsFactsSql(request.person_ids.length, request.seasons.length);
  const result = await db.prepare(sql)
    .bind(...request.person_ids, ...request.seasons, snapshotId)
    .all<{ person_id: string; season: string; competition: "PL"; goals: number | null;
      assists: number | null; minutes: number | null; snapshot_id: string }>();
  if ((result.results ?? []).length > PLAYER_TRENDS_MAX_FACTS) throw new Error("player trends fact bound reached");
  const after = await currentPublication(db);
  if (after?.snapshot_id !== snapshotId) throw new Error("player trends publication changed during read");

  const lineageFor = (season: string, name: string): string => {
    const cell = coverage.find((candidate) => usable(candidate, name, season));
    if (!cell) throw new Error("player trends coverage or rights unavailable");
    const ref = cell.attribution_asset ?? cell.source_name;
    if (!ref || !ref.trim()) throw new Error("player trends lineage unavailable");
    return `${cell.source_id}:${ref}`;
  };
  const seen = new Set<string>();
  const rows: PlayerTrendRow[] = (result.results ?? []).map((row): PlayerTrendRow => {
    if (!request.person_ids.includes(row.person_id) || !request.seasons.includes(row.season) ||
        row.competition !== "PL" || row.snapshot_id !== snapshotId) {
      throw new Error("invalid player trends fact");
    }
    const key = `${row.person_id}\0${row.season}`;
    if (seen.has(key)) throw new Error("duplicate player trends fact");
    seen.add(key);
    for (const counter of [row[metric], row.minutes]) {
      if (counter !== null && (!Number.isSafeInteger(counter) || counter < 0)) throw new Error("invalid player trends counter");
    }
    return {
      person_id: row.person_id, season: row.season, competition: "PL", metric,
      definition: metric === "goals" ? "goals" : "fpl_assists",
      total: row[metric], minutes: row.minutes, snapshot_id: row.snapshot_id,
      lineage: [...new Set([lineageFor(row.season, metric), lineageFor(row.season, "minutes")])],
    };
  });
  const finalPublication = await currentPublication(db);
  if (finalPublication?.snapshot_id !== snapshotId) throw new Error("player trends publication changed during read");
  return rows;
}
