/**
 * The feasibility resolver — answered BEFORE any compute.
 *
 * Mirrors pipeline/contracts/feasibility.py. Reads the compiled catalog
 * (worker/src/generated/catalog.json), which is built and invariant-checked by
 * `uv run python -m pipeline.contracts.build_catalog`.
 *
 * This must be a LOOKUP, never an inference. An optimistic false positive
 * produces a confident wrong answer, which is the worst outcome this system
 * can produce.
 */

import type { QueryIntent, VizType } from "./intent";
import type { LocaleCode } from "./locale";

export type FeasibilityState =
  | "available"
  | "computable_now_queued"
  | "computable_but_expensive"
  | "not_computable_data_missing"
  | "not_computable_no_rights";

export type Granularity = "box_score" | "event_with_coords" | "tracking";

/** Pitch overlays need event coordinates, which exist for 2017-18 only. This
 *  mapping is what turns "shot map for 2024-25" into an honest refusal rather
 *  than a silent fallback to box-score data. */
export const VIZ_GRANULARITY: Record<VizType, Granularity> = {
  table: "box_score",
  bar: "box_score",
  line: "box_score",
  shot_map: "event_with_coords",
  pass_map: "event_with_coords",
  heatmap: "event_with_coords",
};

export interface CoverageCell {
  metric: string;
  entity_type: string;
  granularity: Granularity;
  season: string;
  competition: string;
  source_id: string;
  redistributable: boolean;
  cost_class: "cheap" | "expensive";
  attribution_asset: string | null;
  attribution_text: string | null;
  attribution_text_es: string | null;
  source_name: string;
  licence_id: string;
  notes?: string | null;
}

export interface MetricDef {
  metric_id: string;
  label_en: string;
  label_es: string;
  description: string;
  granularity: Granularity;
  unit: string;
  decimals: number;
}

export interface CompiledCatalog {
  version: number;
  metrics: MetricDef[];
  coverage: CoverageCell[];
}

export interface FeasibilityResult {
  state: FeasibilityState;
  reason: string;
  attribution_asset?: string | null;
  attribution_text?: string | null;
  source_name?: string | null;
  nearest_alternative?: QueryIntent | null;
  cost_class: "cheap" | "expensive";
}

function cellKey(
  metric: string,
  entity: string,
  gran: Granularity,
  season: string,
  comp: string,
): string {
  return [metric, entity, gran, season, comp].join(" ");
}

/**
 * Feasibility for every declared metric at one (entity_type, season), in one
 * pass. Built for table pages showing several metrics as columns: checking
 * per-cell would be correct but wasteful, since coverage is keyed on
 * (metric, season) and does not vary per row. One lookup per column, never
 * per player.
 */
export function columnFeasibility(
  catalog: Catalog,
  entityType: "player" | "season",
  season: string,
  competition = "PL",
  locale: LocaleCode = "en",
): Map<string, FeasibilityResult> {
  const out = new Map<string, FeasibilityResult>();
  for (const m of catalog.metrics) {
    out.set(
      m.metric_id,
      catalog.checkFeasibility(
        {
          metric: m.metric_id,
          entity_type: entityType,
          entity_id: "all",
          season,
          competition,
          dimensions: [],
          filters: {},
          viz: "table",
          limit: 50,
        },
        locale,
      ),
    );
  }
  return out;
}

/**
 * The SEO substance gate (docs/roadmap.md M3, security/headers.ts
 * X-Robots-Tag default). A page becomes indexable only when at least
 * `threshold` metrics actually render a value for it -- the same "yes" test
 * `metricValueCells` already uses (available or computable_now_queued; a
 * dash, whether no_data/no_rights/expensive-deferred, does not count).
 * Google's scaled-content-abuse policy targets exactly the thin permutation
 * this architecture can otherwise generate at will, so this is a hard floor,
 * not a suggestion -- see the M3 "why SEO is a milestone gate" note.
 */
export function hasSubstance(feas: Map<string, FeasibilityResult>, threshold = 2): boolean {
  let populated = 0;
  for (const f of feas.values()) {
    if (f.state === "available" || f.state === "computable_now_queued") populated++;
    if (populated >= threshold) return true;
  }
  return false;
}

/** Reason-sentence templates, one function per branch of checkFeasibility, so
 *  the English and Spanish wording sit side by side and can't drift apart
 *  silently. Locale-neutral JSON API routes (/api/chat, /api/query) never
 *  pass a locale, so the "en" branch is also the default. */
const REASON = {
  cachedArtifact: { en: () => "Cached artifact exists.", es: () => "Existe un artefacto en caché." },
  hallucinatedMetric: {
    en: (metric: string) => `'${metric}' is not a metric this site defines.`,
    es: (metric: string) => `«${metric}» no es una métrica definida por este sitio.`,
  },
  noData: {
    en: (label: string, gran: string, season: string, competition: string) =>
      `No integrated source provides ${label} at ${gran} granularity for ${season} ${competition}.`,
    es: (label: string, gran: string, season: string, competition: string) =>
      `Ninguna fuente integrada ofrece ${label} con granularidad ${gran} para ${season} ${competition}.`,
  },
  noRights: {
    en: (label: string, season: string, source: string) =>
      `${label} for ${season} comes from ${source}, which grants no redistribution licence. We cannot publish it.`,
    es: (label: string, season: string, source: string) =>
      `${label} de ${season} proviene de ${source}, que no concede licencia de redistribución. No podemos publicarlo.`,
  },
  expensive: {
    en: () => "Event-level render; deferred to the nightly batch.",
    es: () => "Renderizado a nivel de evento; aplazado al proceso nocturno.",
  },
  cheapQueued: {
    en: () => "Feasible and cheap; generated on request.",
    es: () => "Viable y de bajo coste; se genera bajo demanda.",
  },
} as const;

/** Falls back to the English wording when no Spanish translation exists,
 *  rather than rendering a blank -- matches the rest of the site's rule that
 *  a missing translation must degrade, never disappear. */
function attributionFor(cell: CoverageCell, locale: LocaleCode): string | null {
  if (locale === "es" && cell.attribution_text_es) return cell.attribution_text_es;
  return cell.attribution_text;
}

export class Catalog {
  private readonly metricsById = new Map<string, MetricDef>();
  private readonly coverageIndex = new Map<string, CoverageCell>();

  constructor(private readonly compiled: CompiledCatalog) {
    for (const m of compiled.metrics) this.metricsById.set(m.metric_id, m);
    for (const c of compiled.coverage) {
      this.coverageIndex.set(
        cellKey(c.metric, c.entity_type, c.granularity, c.season, c.competition),
        c,
      );
    }
  }

  metric(id: string): MetricDef | undefined {
    return this.metricsById.get(id);
  }

  get metrics(): MetricDef[] {
    return this.compiled.metrics;
  }

  get coverage(): CoverageCell[] {
    return this.compiled.coverage;
  }

  /** Seasons we can actually serve for a metric. Drives the builder pickers,
   *  so infeasible combinations are unselectable by construction. */
  seasonsFor(metric: string, entityType: string, gran: Granularity): string[] {
    return this.compiled.coverage
      .filter(
        (c) =>
          c.metric === metric &&
          c.entity_type === entityType &&
          c.granularity === gran &&
          c.redistributable,
      )
      .map((c) => c.season)
      .sort()
      .reverse();
  }

  /**
   * A genuinely feasible neighbour, or null. Never fabricated.
   *
   * Preference order changes as little as possible about what was asked:
   *   1. same metric and viz, a season we actually cover
   *   2. same season, coarser granularity (downgrade the visualisation)
   *   3. any covered season at box-score granularity (change both)
   *
   * Rule 3 matters more than it looks: without it, asking for a pitch map in a
   * season with no coverage at all yields a bare refusal and a dead end.
   */
  private nearestAlternative(intent: QueryIntent): QueryIntent | null {
    const wanted = VIZ_GRANULARITY[intent.viz];
    const sameMetric = this.compiled.coverage.filter(
      (c) =>
        c.metric === intent.metric &&
        c.entity_type === intent.entity_type &&
        c.redistributable,
    );
    if (sameMetric.length === 0) return null;

    // 1. Same shape, a season we actually cover.
    const seasons = sameMetric
      .filter((c) => c.granularity === wanted && c.season !== intent.season)
      .map((c) => c.season)
      .sort()
      .reverse();
    if (seasons.length > 0) return { ...intent, season: seasons[0]! };

    // 2. Same season, coarser granularity -> downgrade the visualisation.
    if (sameMetric.some((c) => c.season === intent.season && c.granularity === "box_score")) {
      return { ...intent, viz: "bar" };
    }

    // 3. Most recent season we cover at all, with the viz downgraded to match.
    const boxScore = sameMetric
      .filter((c) => c.granularity === "box_score")
      .map((c) => c.season)
      .sort()
      .reverse();
    if (boxScore.length > 0) return { ...intent, season: boxScore[0]!, viz: "bar" };

    // Nothing honest to offer.
    return null;
  }

  checkFeasibility(intent: QueryIntent, locale: LocaleCode = "en", artifactExists = false): FeasibilityResult {
    if (artifactExists) {
      return { state: "available", reason: REASON.cachedArtifact[locale](), cost_class: "cheap" };
    }

    const metric = this.metric(intent.metric);
    if (!metric) {
      // A hallucinated metric is caught here, by the catalog, not by the model.
      return {
        state: "not_computable_data_missing",
        reason: REASON.hallucinatedMetric[locale](intent.metric),
        cost_class: "cheap",
      };
    }

    const label = locale === "es" ? metric.label_es : metric.label_en;
    const gran = VIZ_GRANULARITY[intent.viz];
    const cell = this.coverageIndex.get(
      cellKey(intent.metric, intent.entity_type, gran, intent.season, intent.competition),
    );

    if (!cell) {
      return {
        state: "not_computable_data_missing",
        reason: REASON.noData[locale](label, gran, intent.season, intent.competition),
        nearest_alternative: this.nearestAlternative(intent),
        cost_class: "cheap",
      };
    }

    if (!cell.redistributable) {
      // We may hold it privately. We may not publish it. Say which.
      return {
        state: "not_computable_no_rights",
        reason: REASON.noRights[locale](label, intent.season, cell.source_name),
        source_name: cell.source_name,
        nearest_alternative: this.nearestAlternative(intent),
        cost_class: "cheap",
      };
    }

    if (cell.cost_class === "expensive") {
      return {
        state: "computable_but_expensive",
        reason: REASON.expensive[locale](),
        attribution_asset: cell.attribution_asset,
        attribution_text: attributionFor(cell, locale),
        source_name: cell.source_name,
        cost_class: "expensive",
      };
    }

    return {
      state: "computable_now_queued",
      reason: REASON.cheapQueued[locale](),
      attribution_asset: cell.attribution_asset,
      attribution_text: attributionFor(cell, locale),
      source_name: cell.source_name,
      cost_class: "cheap",
    };
  }
}
