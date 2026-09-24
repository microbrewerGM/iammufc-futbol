import type { Env } from "./db";
import type { Catalog, FeasibilityState } from "./feasibility";
import { artifactKey, withDefaults } from "./intent";
import type { LocaleCode } from "./locale";
import { per90 } from "./rates";

export interface ComparisonRequest {
  season: string;
  metric: "goals" | "assists";
  minMinutes: number;
}

export interface ComparisonRow {
  player_id: string;
  label: string;
  total: number | null;
  minutes: number | null;
  snapshot_id: string;
}

export interface RankedRow {
  player_id: string;
  label: string;
  total: number;
  minutes: number;
  rate: number;
}

function canExecute(state: FeasibilityState): boolean {
  return state === "available" || state === "computable_now_queued";
}

export function parseComparison(
  params: URLSearchParams,
  defaultSeason: string,
): ComparisonRequest | null {
  const allowed = new Set(["season", "metric", "min_minutes"]);
  if ([...params.keys()].some((key) => !allowed.has(key) || params.getAll(key).length !== 1)) {
    return null;
  }
  const season = params.get("season") ?? defaultSeason;
  const metric = params.get("metric") ?? "goals";
  const minimum = params.get("min_minutes") ?? "450";
  if (
    !/^\d{4}-\d{2}$/.test(season) ||
    !["goals", "assists"].includes(metric) ||
    !/^\d{1,5}$/.test(minimum) ||
    Number(minimum) > 20_000
  ) {
    return null;
  }
  return {
    season,
    metric: metric as ComparisonRequest["metric"],
    minMinutes: Number(minimum),
  };
}

/** Internal comparison identity only. The dedicated executor owns these
 * filters; generic-route enforcement remains separate P3 work. */
export function comparisonIntent(request: ComparisonRequest) {
  return withDefaults({
    metric: request.metric,
    season: request.season,
    entity_type: "player",
    entity_id: "all",
    competition: "PL",
    filters: {
      normalization: "per90",
      min_minutes: String(request.minMinutes),
      comparison_version: "1",
    },
    viz: "table",
    limit: 50,
  });
}

export function rankComparison(rows: ComparisonRow[], minimum: number): RankedRow[] {
  const valid = rows.filter(
    (row): row is ComparisonRow & { total: number; minutes: number } =>
      Number.isSafeInteger(row.total) &&
      row.total !== null &&
      row.total >= 0 &&
      Number.isSafeInteger(row.minutes) &&
      row.minutes !== null &&
      row.minutes > 0 &&
      row.minutes >= minimum,
  );
  valid.sort((a, b) => {
    const difference = BigInt(b.total) * BigInt(a.minutes) - BigInt(a.total) * BigInt(b.minutes);
    return difference > 0n
      ? 1
      : difference < 0n
        ? -1
        : b.minutes - a.minutes ||
          (a.player_id < b.player_id ? -1 : a.player_id > b.player_id ? 1 : 0);
  });
  return valid.slice(0, 50).map((row) => ({
    player_id: row.player_id,
    label: row.label,
    total: row.total,
    minutes: row.minutes,
    rate: per90(row.total, row.minutes)!,
  }));
}

export async function executeComparison(
  env: Env,
  catalog: Catalog,
  request: ComparisonRequest,
  locale: LocaleCode = "en",
) {
  const intent = comparisonIntent(request);
  const numerator = catalog.checkFeasibility({ ...intent, filters: {} }, locale);
  const denominator = catalog.checkFeasibility(
    { ...intent, metric: "minutes", filters: {} },
    locale,
  );
  const sourceFor = (metric: string) =>
    catalog.coverage.find(
      (cell) =>
        cell.metric === metric &&
        cell.entity_type === "player" &&
        cell.granularity === "box_score" &&
        cell.season === request.season &&
        cell.competition === "PL",
    )?.source_id;

  // This SQL adapter reads FPL only; matching display names are not lineage.
  if (
    !canExecute(numerator.state) ||
    !canExecute(denominator.state) ||
    sourceFor(request.metric) !== "fpl" ||
    sourceFor("minutes") !== "fpl"
  ) {
    return { ok: false as const, reason: "coverage_or_rights_unavailable" as const };
  }

  const column = request.metric === "goals" ? "s.goals" : "s.assists";
  const { results } = await env.DB.prepare(
    `SELECT p.player_id, p.web_name AS label, ${column} AS total,
      s.minutes, s.snapshot_id
    FROM players p JOIN player_season_stats s
      ON p.player_id = s.player_id AND p.season = s.season
    WHERE p.season = ? AND s.competition = 'PL'
      AND p.team = 'Manchester United'`,
  )
    .bind(request.season)
    .all<ComparisonRow>();
  const sourceRows = results ?? [];
  if (!sourceRows.length) return { ok: false as const, reason: "no_rows" as const };
  const snapshots = new Set(sourceRows.map((row) => row.snapshot_id));
  if (snapshots.size !== 1 || !sourceRows[0]!.snapshot_id) {
    return { ok: false as const, reason: "inconsistent_snapshot" as const };
  }
  const snapshot = sourceRows[0]!.snapshot_id;
  return {
    ok: true as const,
    rows: rankComparison(sourceRows, request.minMinutes),
    snapshot,
    key: await artifactKey(intent, snapshot),
    attribution: numerator.attribution_text,
  };
}
