import type { Catalog, FeasibilityResult } from "./feasibility";
import type { LocaleCode } from "./locale";

export interface SeasonHistoryRow {
  season: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goals: number;
  goals_against: number;
  snapshot_id: string;
}

export interface SeasonComparisonRow extends SeasonHistoryRow {
  league_points: number;
  points_per_match: number | null;
  goals_per_match: number | null;
  partial: boolean;
}

export type SeasonComparison =
  | { ok: true; rows: SeasonComparisonRow[]; sourceName: string; attribution: string | null }
  | { ok: false; reason: string };

const executable = (result: FeasibilityResult) =>
  result.state === "available" || result.state === "computable_now_queued";

export function eligibleLeagueSeasons(catalog: Catalog, selected: string): string[] {
  const cells = catalog.coverage.filter((cell) =>
    cell.metric === "goals" &&
    cell.entity_type === "season" &&
    cell.granularity === "box_score" &&
    cell.competition === "PL" &&
    cell.season <= selected,
  );
  if (!cells.some((cell) => cell.season === selected)) return [];
  // Never silently skip a no-rights or deferred historical season: the whole
  // comparison withholds rather than presenting a discontinuous series.
  if (cells.some((cell) => !cell.redistributable || cell.cost_class !== "cheap")) return [];
  const seasons = [...new Set(cells.map((cell) => cell.season))].sort().reverse();
  return seasons.includes(selected) ? seasons : [];
}

export function buildSeasonComparison(
  rows: readonly SeasonHistoryRow[],
  eligibleSeasons: readonly string[],
  catalog: Catalog,
  locale: LocaleCode,
): SeasonComparison {
  if (eligibleSeasons.length === 0 || rows.length !== eligibleSeasons.length) {
    return { ok: false, reason: locale === "es" ? "La comparación no está disponible." : "The comparison is unavailable." };
  }
  const expected = new Set(eligibleSeasons);
  const seen = new Set<string>();
  const snapshots = new Set<string>();
  const lineages = new Set<string>();
  const out: SeasonComparisonRow[] = [];

  for (const row of rows) {
    const feasibility = catalog.checkFeasibility({
      metric: "goals", entity_type: "season", entity_id: "all", season: row.season,
      competition: "PL", dimensions: [], filters: {}, viz: "table", limit: 50,
    }, locale);
    const integers = [row.played, row.won, row.drawn, row.lost, row.goals, row.goals_against]
      .every((value) => Number.isSafeInteger(value) && value >= 0);
    if (
      !expected.has(row.season) || seen.has(row.season) || !executable(feasibility) ||
      !integers || row.played < 1 || row.played > 38 || row.played !== row.won + row.drawn + row.lost ||
      typeof row.snapshot_id !== "string" || row.snapshot_id.length === 0
    ) {
      return { ok: false, reason: locale === "es" ? "La comparación no está disponible." : "The comparison is unavailable." };
    }
    seen.add(row.season);
    snapshots.add(row.snapshot_id);
    const cell = catalog.coverage.find((candidate) =>
      candidate.metric === "goals" && candidate.entity_type === "season" &&
      candidate.granularity === "box_score" && candidate.competition === "PL" &&
      candidate.season === row.season,
    );
    if (!cell) return { ok: false, reason: locale === "es" ? "La comparación no está disponible." : "The comparison is unavailable." };
    const localizedAttribution = locale === "es"
      ? cell.attribution_text_es ?? cell.attribution_text
      : cell.attribution_text;
    lineages.add(JSON.stringify([cell.source_id, cell.source_name, localizedAttribution]));
    const leaguePoints = 3 * row.won + row.drawn;
    out.push({
      ...row,
      league_points: leaguePoints,
      points_per_match: row.played > 0 ? leaguePoints / row.played : null,
      goals_per_match: row.played > 0 ? row.goals / row.played : null,
      partial: row.played < 38,
    });
  }
  if (snapshots.size !== 1 || lineages.size !== 1 || seen.size !== expected.size) {
    return { ok: false, reason: locale === "es" ? "La comparación no está disponible." : "The comparison is unavailable." };
  }
  const selectedCell = catalog.coverage.find((cell) =>
    cell.metric === "goals" && cell.entity_type === "season" && cell.granularity === "box_score" &&
    cell.competition === "PL" && cell.season === eligibleSeasons[0] &&
    cell.redistributable && cell.cost_class === "cheap",
  );
  if (!selectedCell) return { ok: false, reason: locale === "es" ? "La comparación no está disponible." : "The comparison is unavailable." };
  out.sort((a, b) => b.season.localeCompare(a.season));
  return {
    ok: true,
    rows: out,
    sourceName: selectedCell.source_name,
    attribution: locale === "es" ? selectedCell.attribution_text_es ?? selectedCell.attribution_text : selectedCell.attribution_text,
  };
}
