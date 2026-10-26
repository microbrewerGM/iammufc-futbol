/**
 * iammufc Worker — M1 proof of concept.
 *
 * Route topology enforces the design's central boundary:
 *   /api/chat  proposes an intent and CANNOT execute
 *   /api/query executes a validated intent and NEVER sees natural language
 *
 * The HTML routes compose the two: /ask parses, shows the parse, then runs it.
 *
 * i18n: every HTML route is registered ONCE per locale under /en/ and /es/
 * (registerLocaleRoutes), never duplicated by hand -- the two trees must stay
 * in lockstep or they drift. Bare paths (/, /ask, /player/...) redirect to
 * their /en/ equivalent rather than serving duplicate content at two URLs,
 * which is the same duplicate-content risk starting_ideas/02 flags for the
 * two-domain case, just one level down. API routes stay locale-neutral --
 * they return data, not prose.
 */

import { Hono } from "hono";

import compiledCatalog from "./generated/catalog.json";
import {
  allPlayerNames,
  currentPublication,
  currentSnapshot,
  playerRangeFacts,
  playerRangeIdentityCatalog,
  savePlayerRangeHistory,
  enforceBudget,
  clearQuestionHistory,
  listQuestionHistory,
  logQueryAggregate,
  playerCareerRows,
  readQueryCache,
  resolvePlayerIdentity,
  runQuery,
  saveQuestionHistory,
  seasonHistoryRows,
  seasonRecordRow,
  seasonSplitFacts,
  seasonSquadRows,
  writeQueryCache,
  type CacheOutcome,
  type Env,
  type QuestionHistoryEntry,
  type PublicationState,
} from "./core/db";
import { clHistoryRows } from "./core/cl-history";
import { decodeCompiledCatalog } from "./core/catalog-contract";
import { Catalog, columnFeasibility, hasSubstance } from "./core/feasibility";
import { artifactKey, canonicalize } from "./core/intent";
import { parseIntent, validateExecutionSupport, validateQuerySemantics } from "./core/validate-intent";
import { LOCALES, type Locale, type LocaleCode } from "./core/locale";
import {
  hasAmbiguousPlayerReference,
  parseRuleBased,
  proposeWithAI,
  type Proposal,
} from "./core/parser";
import { executeComparison, parseComparison, type ComparisonRequest } from "./core/comparison";
import { buildSeasonComparison, eligibleLeagueSeasons } from "./core/season-comparison";
import { calculatePlayerRange, parsePlayerRangeRequest } from "./core/player-range";
import { parseSeasonSplitRequest, querySeasonSplits } from "./core/season-splits";
import { seasonSplitsBody, seasonSplitSelection } from "./views/season-splits";
import { championsLeagueHistoryBody } from "./views/cl-history";
import type { PlayerRangeRequest } from "./core/player-range";
import { playerRangeBody, playerRangeSelection } from "./views/player-range";
import { playerTrendsFacts } from "./core/player-trends-db";
import { calculatePlayerTrends, parsePlayerTrendsRequest } from "./core/player-trends";
import { playerTrendsBody } from "./views/player-trends";
import { APPROVED_OPPONENT_IDS, readOpponentHistory } from "./core/opponent-history";
import { opponentHistoryBody, opponentHistoryUnpublishedBody } from "./views/opponent-history";
import { withSecurityHeaders } from "./security/headers";
import { accessGate, accessIdentity, type AccessEnv, type AccessIdentity } from "./security/auth";
import { createExplorationBridgeRouter } from "./routes/exploration-bridge";
import { gateQuestion, type GateRejected } from "./security/askguard";
import { esc, html, page } from "./views/layout";
import { comparisonPage } from "./views/comparison";
import {
  chatForm,
  dataAvailabilityPage,
  homeBody,
  intentPanel,
  playerPageBody,
  rejectionPanel,
  resultPanel,
  seasonPageBody,
  type FreshnessView,
} from "./views/pages";

/** Pin site P14. Bump deliberately -- a different model parses differently. */
const AI_MODEL = "@cf/google/gemma-4-26b-a4b-it";

const decodedCatalog = decodeCompiledCatalog(compiledCatalog);
const catalog = new Catalog(decodedCatalog);
const app = new Hono<AccessEnv>();

/** Fire-and-forget the demand-aggregate write: never awaited by the response,
 * never throws, and survives the response via waitUntil when a context exists. */
function deferAggregate(
  c: { executionCtx: { waitUntil(promise: Promise<unknown>): void } },
  write: Promise<void>,
): void {
  const safe = write.catch(() => {});
  try {
    c.executionCtx.waitUntil(safe);
  } catch {
    // No execution context (unit tests): the write is already detached and error-safe.
  }
}

/** Choose a default only from metric/season pairs with executable catalog coverage. */
export function selectComparisonDefaults(
  seasonsByMetric: Readonly<Record<ComparisonRequest["metric"], readonly string[]>>,
  requestedSeason?: string,
  preferredMetric?: ComparisonRequest["metric"],
): { metric: ComparisonRequest["metric"]; season: string } | null {
  const metrics = preferredMetric ? [preferredMetric, "goals", "assists"] as const : ["goals", "assists"] as const;
  const orderedMetrics = [...new Set(metrics)];
  const matchingMetric = requestedSeason
    ? orderedMetrics.find((metric) => seasonsByMetric[metric].includes(requestedSeason))
    : undefined;
  const metric = matchingMetric ?? orderedMetrics.find((candidate) => seasonsByMetric[candidate].length > 0);
  if (!metric) return null;
  const season = requestedSeason && seasonsByMetric[metric].includes(requestedSeason)
    ? requestedSeason
    : seasonsByMetric[metric][0];
  return season ? { metric, season } : null;
}

/** Private responses never enter browser/shared caches, even on error. */
const CACHE_CONTROL = "private, no-store";

type CachedExecution =
  | { result: Awaited<ReturnType<typeof runQuery>>; cacheOutcome: CacheOutcome; overBudget: false }
  | { result: null; cacheOutcome: CacheOutcome; overBudget: boolean };

/** Cache hits are free; only a miss reaches the budget breaker and executor.
 * Cache storage is advisory, so every read/write failure degrades to compute. */
async function executeWithCache(
  env: Env,
  intent: Parameters<typeof runQuery>[1],
  key: string,
  snapshot: string | null,
  allowCompute: boolean,
): Promise<CachedExecution> {
  const cached = await readQueryCache(env, key, snapshot, intent);
  if (cached.result) {
    // Publication can change after the route's initial snapshot read even
    // when the result comes from cache rather than a new data SELECT.
    if (await currentSnapshot(env) !== snapshot) throw new Error("snapshot_changed_during_query");
    return { result: cached.result, cacheOutcome: "hit", overBudget: false };
  }
  if (!allowCompute) return { result: null, cacheOutcome: cached.outcome, overBudget: false };
  if (!(await enforceBudget(env))) {
    return { result: null, cacheOutcome: cached.outcome, overBudget: true };
  }
  const result = await runQuery(env, intent, snapshot);
  // The seed import is atomic, but it can commit between the first snapshot
  // read and the data SELECT. Re-read after execution so rows observed across
  // that boundary are never labelled or cached under the old artifact key.
  const snapshotAfterExecution = await currentSnapshot(env);
  if (snapshotAfterExecution !== snapshot) throw new Error("snapshot_changed_during_query");
  const stored = await writeQueryCache(env, key, snapshot, result, intent);
  const cacheOutcome = cached.outcome === "unavailable" || !stored ? "unavailable" : cached.outcome;
  return { result, cacheOutcome, overBudget: false };
}

app.use("*", async (c, next) => {
  await next();
  c.res = withSecurityHeaders(c.res);
  c.header("Cache-Control", "private, no-store");
  c.header("CDN-Cache-Control", "no-store");
  c.header("Cloudflare-CDN-Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
});
app.use("*", accessGate());
app.onError(() => new Response("Request unavailable.", { status: 503 }));
app.route("/internal/exploration-bridge", createExplorationBridgeRouter());

// ---------------------------------------------------------------------------
// JSON API -- locale-neutral, returns data not prose
// ---------------------------------------------------------------------------

/** Proposes. Never executes. The response has no data in it by construction. */
app.post("/api/chat", async (c) => {
  const body = await c.req.json<unknown>().catch(() => null);
  if (!body || typeof body !== "object" || !("question" in body) || typeof body.question !== "string") {
    return c.json({ error: "question is required" }, 400);
  }
  const question = body.question.trim();
  if (!question) return c.json({ error: "question is required" }, 400);

  // The gate runs before anything else touches the text -- including the
  // model. A rejected question costs zero inference.
  const playerNames = await allPlayerNames(c.env);
  const verdict = gateQuestion(question, "en", playerNames);
  if (!verdict.allowed) return c.json(rejectionBody(verdict), 422);

  const proposal = await propose(verdict.question, c.env, playerNames);
  const feasibility = catalog.checkFeasibility(proposal.intent);

  return c.json({
    proposed_intent: proposal.intent,
    source: proposal.source,
    model_status: proposal.model_status,
    confidence: proposal.confidence,
    notes: proposal.notes,
    feasibility,
    next: "POST the proposed_intent to /api/query to execute it.",
  });
});

/** Executes a validated intent. Rejects anything the catalog does not permit. */
app.post("/api/query", async (c) => {
  const parsed = parseIntent(await c.req.json<unknown>().catch(() => null));
  if (!parsed.ok) return c.json({ error: parsed.issue }, 400);
  const intent = parsed.intent;
  const semanticIssue = validateQuerySemantics(intent);
  if (semanticIssue) return c.json({ error: semanticIssue }, 422);
  const snapshot = await currentSnapshot(c.env);
  const key = await artifactKey(intent, snapshot ?? "no-snapshot");
  const feasibility = catalog.checkFeasibility(intent);

  if (feasibility.state === "no_data" || feasibility.state === "no_rights") {
    deferAggregate(c, logQueryAggregate(c.env, intent, feasibility.state, "not_applicable", "refused", "api", "query_api"));
    return c.json({ artifact_key: key, intent, feasibility, rows: [] }, 200);
  }
  const executionIssue = validateExecutionSupport(intent);
  if (executionIssue) return c.json({ error: executionIssue }, 422);

  const execution = await executeWithCache(
    c.env, intent, key, snapshot, feasibility.state !== "computable_but_expensive",
  );
  const responseFeasibility = execution.cacheOutcome === "hit"
    ? catalog.checkFeasibility(intent, "en", true)
    : feasibility;
  const resultOutcome = execution.overBudget
    ? "budget_exceeded"
    : execution.result ? "success" : "refused";
  deferAggregate(c, logQueryAggregate(c.env, intent, responseFeasibility.state, execution.cacheOutcome,
    resultOutcome, "api", "query_api"));
  if (execution.overBudget) {
    return c.json(
      { error: "budget_exceeded", message: "Daily compute budget spent. Try again after midnight UTC." },
      429,
    );
  }

  if (!execution.result) {
    return c.json({ artifact_key: key, intent, feasibility: responseFeasibility, rows: [] }, 200);
  }

  const result = execution.result;
  return c.json({
    artifact_key: key,
    intent,
    feasibility: responseFeasibility,
    snapshot_id: result.snapshot_id,
    rows: result.rows,
    attribution: [feasibility.attribution_text].filter(Boolean),
  });
});

app.get("/api/catalog", (c) => {
  const res = c.json({
    metrics: catalog.metrics,
    coverage: catalog.coverage.map((cell) => ({
      metric: cell.metric,
      season: cell.season,
      granularity: cell.granularity,
      redistributable: cell.redistributable,
      source: cell.source_name,
    })),
  });
  res.headers.set("Cache-Control", CACHE_CONTROL);
  return res;
});

type DataState = "current" | "degraded" | "inconsistent" | "unavailable";
const SHA256_RE = /^[a-f0-9]{64}$/;

function publicationHealth(
  snapshot: string | null,
  publication: PublicationState | null,
): DataState {
  if (!snapshot) return "unavailable";
  if (!SHA256_RE.test(snapshot) || !publication || publication.snapshotId !== snapshot) {
    return "inconsistent";
  }
  const sources = new Map(publication.sources.map((source) => [source.id, source]));
  if (
    sources.get("fpl")?.status !== "observed" ||
    sources.get("football_data_couk")?.status !== "observed"
  ) {
    return "inconsistent";
  }
  return sources.get("openfootball_cl")?.status === "unavailable" ? "degraded" : "current";
}

function freshnessView(
  snapshot: string | null,
  publication: PublicationState | null,
): FreshnessView {
  const state = publicationHealth(snapshot, publication);
  if (state === "inconsistent" || state === "unavailable") return { state };
  if (!publication) return { state: "inconsistent" };
  const coverageThrough = (["fpl", "football_data_couk"] as const)
    .map((id) => publication.sources.find((source) => source.id === id)!.coverageThrough as string)
    .sort()[0]!;
  return {
    state,
    coverageThrough,
    lastSuccessfulLoadAt: publication.loadedAt,
    sources: publication.sources.map(
      ({ id, status, coverageThrough, retrievedAt, sourceAsOf }) => ({
        id,
        status,
        coverageThrough,
        retrievedAt,
        sourceAsOf,
      }),
    ),
  };
}

app.get("/api/health", async (c) => {
  const [snapshot, publication] = await Promise.all([
    currentSnapshot(c.env).catch(() => null),
    currentPublication(c.env),
  ]);
  const dataState = publicationHealth(snapshot, publication);
  const usable = dataState === "current" || dataState === "degraded";
  const current = usable ? publication : null;
  const coreCoverage = current
    ? (["fpl", "football_data_couk"] as const)
        .map((id) => current.sources.find((source) => source.id === id)!.coverageThrough as string)
        .sort()[0]
    : null;
  const res = c.json({
    ok: usable,
    data_state: dataState,
    snapshot_id: snapshot && SHA256_RE.test(snapshot) ? snapshot : null,
    snapshot_prepared_at: current?.preparedAt ?? null,
    last_successful_refresh_at: current?.loadedAt ?? null,
    coverage_through: coreCoverage,
    sources:
      current?.sources.map((source) => ({
        id: source.id,
        status: source.status,
        coverage_through: source.coverageThrough,
        source_as_of: source.sourceAsOf,
        retrieved_at: source.retrievedAt,
      })) ?? [],
    metrics: catalog.metrics.length,
    coverage_cells: catalog.coverage.length,
    ai_bound: Boolean(c.env.AI),
  });
  // Deliberately never cached -- this is a liveness probe. A cached "ok:true"
  // would keep reporting the site healthy for up to an hour after it wasn't,
  // defeating the one thing this route exists for.
  res.headers.set("Cache-Control", "no-store");
  return res;
});

// ---------------------------------------------------------------------------
// HTML -- registered once per locale, below
// ---------------------------------------------------------------------------

function registerLocaleRoutes(code: LocaleCode) {
  const locale = LOCALES[code];
  const p = `/${code}`;

  async function playerTrendsIdentityLabels(env: Env, people: readonly string[]): Promise<{ person_id: string; label: string }[]> {
    const result = await env.DB.prepare(`SELECT i.person_id, p.web_name AS label FROM player_identities i JOIN players p ON p.player_id = i.player_id WHERE i.person_id IN (${people.map(() => "?").join(",")}) ORDER BY i.person_id, i.season DESC`).bind(...people).all<{ person_id: string; label: string }>();
    const labels = new Map<string, string>();
    for (const row of result.results ?? []) if (!labels.has(row.person_id)) labels.set(row.person_id, row.label);
    return people.filter(id => labels.has(id)).map(person_id => ({ person_id, label: labels.get(person_id)! }));
  }

  app.get(`${p}/data`, () => {
    const res = html(
      page(dataAvailabilityPage(catalog, locale), {
        title: locale.strings.dataCatalogTitle,
        locale,
        unprefixedPath: "/data",
      }),
    );
    res.headers.set("Cache-Control", CACHE_CONTROL);
    return res;
  });

  app.get(`${p}/seasons/explore`, async (c) => {
    const url = new URL(c.req.url);
    const rawQuery = url.search;
    if (new TextEncoder().encode(rawQuery).byteLength > 2048) return html("Invalid season selection.", 400);
    const params = url.searchParams;
    let seasonCount = 0;
    for (const [key] of params) {
      if (key === "seasons" && ++seasonCount > 16) return html("Invalid season selection.", 400);
    }
    const allowed = new Set(["schema_version", "competition", "seasons", "group_by", "venue", "opponent_id"]);
    if ([...params.keys()].some((key) => !allowed.has(key)) ||
        [...params.keys()].some((key) => key !== "seasons" && params.getAll(key).length !== 1)) {
      return html(locale.code === "es" ? "Selección de temporada no válida." : "Invalid season selection.", 400);
    }
    const raw = { schema_version: params.has("schema_version") ? Number(params.get("schema_version")) : 1,
      competition: params.get("competition") ?? "PL", seasons: params.getAll("seasons"),
      group_by: params.get("group_by") ?? "venue", venue: params.get("venue") || null,
      opponent_id: params.get("opponent_id") || null };
    const availableSeasons = [...new Set(catalog.coverage.filter((cell) => cell.competition === "PL").map((cell) => cell.season))].sort();
    let request;
    let result;
    let error: string | undefined;
    let status = 200;
    let snapshot: string | null = null;
    let opponents: { opponent_id: string; label: string }[] = [];
    // Season facts carry plain source IDs. Preserve every distinct localized
    // asset credit for each source instead of overwriting one with another.
    const sourceCredits = new Map<string, Set<string>>();
    for (const cell of catalog.coverage) {
      const credit = (locale.code === "es" ? cell.attribution_text_es ?? cell.attribution_text : cell.attribution_text) ?? cell.source_name;
      if (!credit?.trim()) continue;
      if (!sourceCredits.has(cell.source_id)) sourceCredits.set(cell.source_id, new Set());
      sourceCredits.get(cell.source_id)!.add(credit);
    }
    const credits = Object.fromEntries([...sourceCredits].map(([id, texts]) => [id, [...texts].join(" · ")]));
    try {
      request = parseSeasonSplitRequest(raw, availableSeasons);
      if (catalog.outputCapability("season_splits") !== "clear") {
        error = locale.code === "es" ? "La capacidad de desgloses por temporada no está publicada." : "Season splits capability is not published.";
      } else {
        if (!(await enforceBudget(c.env, { failClosed: true }))) {
          error = locale.code === "es" ? "La exploración no está disponible." : "Season exploration is unavailable.";
          status = 503;
        } else {
          const publication = await currentPublication(c.env);
          snapshot = publication?.snapshotId ?? null;
          if (!snapshot) throw new Error("snapshot unavailable");
          const facts = await seasonSplitFacts(c.env, snapshot, request.seasons, {
            venue: request.venue, opponent_id: request.opponent_id,
          });
          result = querySeasonSplits(request, facts.catalog, facts.rows);
          opponents = [...new Set(facts.rows.map((row) => row.opponent_id))].sort().map((opponent_id) => ({ opponent_id, label: opponent_id }));
        }
      }
    } catch {
      if (request) {
        error = locale.code === "es" ? "Los datos de desgloses no están disponibles para esta selección." : "Season split data is unavailable for this selection.";
        status = 503;
      } else {
        error = locale.code === "es" ? "Selección de temporada no válida." : "Invalid season selection.";
        status = 400;
      }
    }
    const selection = request ? seasonSplitSelection(request) : { seasons: raw.seasons, group_by: String(raw.group_by), venue: String(raw.venue ?? ""), opponent_id: String(raw.opponent_id ?? "") };
    const canonical = request ? new URLSearchParams() : null;
    if (canonical && request) {
      canonical.set("schema_version", "1"); canonical.set("competition", "PL");
      request.seasons.forEach((season) => canonical.append("seasons", season));
      canonical.set("group_by", request.group_by);
      if (request.venue) canonical.set("venue", request.venue);
      if (request.opponent_id) canonical.set("opponent_id", request.opponent_id);
    }
    const body = seasonSplitsBody({ selection, seasons: availableSeasons, opponents, result, error, credits }, locale);
    const canonicalPath = canonical ? `/seasons/explore?${canonical.toString()}` : "/seasons/explore";
    const res = html(page(body, { title: locale.code === "es" ? "Explorar temporadas" : "Explore seasons", locale, unprefixedPath: canonicalPath, snapshotId: snapshot }), status);
    res.headers.set("Cache-Control", CACHE_CONTROL);
    return res;
  });

  app.get(`${p}/compare`, async (c) => {
    const comparisonHasCoverage = (metric: "goals" | "assists", season: string) =>
      ([metric, "minutes"] as const).every((coveredMetric) => {
        const cell = catalog.coverage.find(
          (candidate) =>
            candidate.metric === coveredMetric &&
            candidate.entity_type === "player" &&
            candidate.granularity === "box_score" &&
            candidate.season === season &&
            candidate.competition === "PL",
        );
        if (cell?.source_id !== "fpl" || !cell.redistributable) return false;
        const feasibility = catalog.checkFeasibility(
          {
            metric: coveredMetric,
            entity_type: "player",
            entity_id: "all",
            season,
            competition: "PL",
            dimensions: [],
            filters: {},
            viz: "table",
            limit: 50,
          },
          locale.code,
        );
        return feasibility.state === "available" || feasibility.state === "computable_now_queued";
      });
    const comparisonSeasons = (metric: "goals" | "assists") =>
      catalog
        .seasonsFor(metric, "player", "box_score")
        .filter((season) => comparisonHasCoverage(metric, season));
    const params = new URL(c.req.url).searchParams;
    const seasonsByMetric = {
      goals: comparisonSeasons("goals"),
      assists: comparisonSeasons("assists"),
    };
    const requestedMetric = params.get("metric");
    const defaults = selectComparisonDefaults(
      seasonsByMetric,
      params.get("season") ?? undefined,
      requestedMetric === "goals" || requestedMetric === "assists" ? requestedMetric : undefined,
    );
    if (!defaults) {
      return c.text(
        locale.code === "es" ? "Parámetros de comparación no válidos." : "Invalid comparison parameters.",
        400,
      );
    }
    if (!params.has("season")) params.set("season", defaults.season);
    if (!params.has("metric")) params.set("metric", defaults.metric);
    const request = parseComparison(params, defaults.season);
    if (!request) {
      return c.text(
        locale.code === "es" ? "Parámetros de comparación no válidos." : "Invalid comparison parameters.",
        400,
      );
    }
    const availableMetrics = (["goals", "assists"] as const).filter((metric) =>
      comparisonHasCoverage(metric, request.season),
    );
    const availableSeasons = comparisonSeasons(request.metric);
    if (!availableMetrics.includes(request.metric) || !availableSeasons.includes(request.season)) {
      return c.text(
        locale.code === "es" ? "Parámetros de comparación no válidos." : "Invalid comparison parameters.",
        400,
      );
    }
    return comparisonPage(
      request,
      await executeComparison(c.env, catalog, request, locale.code),
      availableSeasons,
      availableMetrics,
      locale,
    );
  });

  app.get(`${p}/players/compare`, async (c) => {
    const query = new URL(c.req.url).search;
    const MAX_COMPARE_QUERY_BYTES = 2048;
    if (new TextEncoder().encode(query).byteLength > MAX_COMPARE_QUERY_BYTES) {
      return html(locale.code === "es" ? "Selección de comparación no válida." : "Invalid comparison selection.", 400);
    }
    const params = new URLSearchParams(query);
    let personParamCount = 0;
    let seasonParamCount = 0;
    for (const [key] of params) {
      if (key === "person_ids" && ++personParamCount > 5 || key === "seasons" && ++seasonParamCount > 8) {
        return html(locale.code === "es" ? "Selección de comparación no válida." : "Invalid comparison selection.", 400);
      }
    }
    const allowed = new Set(["person_ids", "seasons", "schema_version", "competition", "metric", "normalization", "min_minutes", "viz"]);
    if ([...params.keys()].some((key) => !allowed.has(key)) ||
        [...new Set(params.keys())].some((key) => !["person_ids", "seasons"].includes(key) && params.getAll(key).length !== 1)) {
      return html(locale.code === "es" ? "Selección de comparación no válida." : "Invalid comparison selection.", 400);
    }
    const raw = {
      schema_version: params.has("schema_version") ? Number(params.get("schema_version")) : 1,
      competition: params.get("competition") ?? "PL",
      person_ids: params.getAll("person_ids"), seasons: params.getAll("seasons"),
      metric: params.get("metric") ?? "goals", normalization: params.get("normalization") ?? "total",
      ...(params.has("min_minutes") ? { min_minutes: /^\d+$/.test(params.get("min_minutes")!) ? Number(params.get("min_minutes")) : NaN } : {}),
      viz: params.get("viz") ?? "table",
    };
    let candidate: PlayerRangeRequest;
    try {
      candidate = parsePlayerRangeRequest(raw, { snapshot_id: "preflight", person_ids: raw.person_ids, seasons: raw.seasons });
    } catch {
      return html(locale.code === "es" ? "Selección de comparación no válida." : "Invalid comparison selection.", 400);
    }
    const covered = (metric: string, season: string) => {
      const cell = catalog.coverage.find((candidate) => candidate.metric === metric && candidate.entity_type === "player" && candidate.granularity === "box_score" && candidate.competition === "PL" && candidate.season === season);
      return cell?.source_id === "fpl" && cell.redistributable && cell.cost_class === "cheap";
    };
    const coverageSeasons = [...new Set(catalog.coverage.filter((cell) => cell.entity_type === "player" && cell.granularity === "box_score" && cell.competition === "PL" && ["goals", "assists"].some((metric) => covered(metric, cell.season) && covered("minutes", cell.season))).map((cell) => cell.season))].sort();
    const emptySelection = { person_ids: raw.person_ids, seasons: raw.seasons, metric: String(raw.metric), normalization: String(raw.normalization), min_minutes: params.get("min_minutes") ?? (raw.normalization === "per90" ? "450" : "0"), viz: String(raw.viz) };
    let request: PlayerRangeRequest | undefined;
    let labels: { person_id: string; label: string }[] = [];
    let result;
    let error: string | undefined;
    let status = 200;
    let snapshot: string | null = null;
    let validationStage: "input" | "metadata" | "coverage" | "compute" = "input";
    try {
      if (!(await enforceBudget(c.env, { failClosed: true }))) {
        error = locale.code === "es" ? "La comparación no está disponible." : "Comparison unavailable.";
        status = 503;
      } else {
        snapshot = await currentSnapshot(c.env);
        if (!snapshot) {
          error = locale.code === "es" ? "La comparación no está disponible." : "Comparison unavailable.";
          status = 503;
        } else {
        validationStage = "metadata";
        const identityCatalog = await playerRangeIdentityCatalog(c.env, candidate.person_ids, candidate.seasons, snapshot);
        if (identityCatalog.person_ids.length !== candidate.person_ids.length) {
          error = locale.code === "es" ? "Uno o más identificadores de jugador no están disponibles." : "One or more player IDs are unknown.";
          status = 400;
        } else {
        const validatedRequest = parsePlayerRangeRequest(raw, identityCatalog);
        request = validatedRequest;
        validationStage = "coverage";
        const coverageOk = validatedRequest.seasons.every((season) => [validatedRequest.metric, "minutes"].every((metric) => {
          const cell = catalog.coverage.find((candidate) => candidate.metric === metric && candidate.entity_type === "player" && candidate.granularity === "box_score" && candidate.competition === "PL" && candidate.season === season);
          return cell?.source_id === "fpl" && cell.redistributable && cell.cost_class === "cheap" && ["available", "computable_now_queued"].includes(catalog.checkFeasibility({ metric, entity_type: "player", entity_id: "all", season, competition: "PL", dimensions: [], filters: {}, viz: "table", limit: 50 }, locale.code).state);
        }));
        if (!coverageOk) throw new Error("selection");
        validationStage = "compute";
        {
          const facts = await playerRangeFacts(c.env, validatedRequest, snapshot, catalog.coverage);
          labels = facts.labels;
          request = validatedRequest;
          result = calculatePlayerRange(request, facts.catalog, facts.rows);
          if (await currentSnapshot(c.env) !== snapshot) { error = locale.code === "es" ? "La comparación no está disponible." : "Comparison unavailable."; result = undefined; status = 503; }
        }
        }
      }
      }
    } catch (caught) {
      error = locale.code === "es" ? "Selección de comparación no válida." : "Invalid comparison selection.";
      status = caught instanceof Error && ((validationStage === "input" && /^Invalid player range:/.test(caught.message)) ||
        (validationStage === "coverage" && caught.message === "selection")) ? 400 : 503;
    }
    const selection = request ? playerRangeSelection(request) : emptySelection;
    const canonical = request ? new URLSearchParams() : null;
    if (canonical && request) {
      canonical.set("schema_version", "1"); canonical.set("competition", "PL");
      request.person_ids.forEach((id) => canonical.append("person_ids", id));
      request.seasons.forEach((season) => canonical.append("seasons", season));
      canonical.set("metric", request.metric); canonical.set("normalization", request.normalization);
      canonical.set("min_minutes", String(request.min_minutes)); canonical.set("viz", request.viz);
    }
    if (result && accessIdentity(c)?.sub && canonical) await savePlayerRangeHistory(c.env, accessIdentity(c)!.sub, `${p}/players/compare?${canonical.toString()}`, locale.code).catch(() => {});
    const body = playerRangeBody({ selection, people: labels, seasons: coverageSeasons, result, error, credits: Object.fromEntries(catalog.coverage.map((cell) => [`${cell.source_id}:${cell.attribution_asset ?? cell.source_name}`, locale.code === "es" ? cell.attribution_text_es ?? cell.attribution_text ?? "" : cell.attribution_text ?? ""])) }, locale);
    const canonicalPath = canonical ? `/players/compare?${canonical.toString()}` : "/players/compare";
    return html(page(body, { title: locale.strings.playerRangeLink, locale, unprefixedPath: canonicalPath, snapshotId: snapshot }), status);
  });

  app.get(`${p}/players/trends`, async (c) => {
    const t = locale.strings;
    const invalid = t.playerTrendsInvalid;
    const unavailable = t.playerTrendsUnavailable;
    const unknown = t.playerTrendsUnknown;
    const renderError = (message: string, status: number) => html(page(`<main><h1>${status === 404 ? t.notFoundHeading : t.playerTrendsLink}</h1><p>${esc(message)}</p></main>`, { title: status === 404 ? t.notFoundHeading : t.playerTrendsLink, locale, unprefixedPath: "/players/trends" }), status);
    const url = new URL(c.req.url);
    if (new TextEncoder().encode(url.search).byteLength > 2048) return renderError(invalid, 400);
    const params = url.searchParams;
    let peopleCount = 0, seasonCount = 0;
    for (const [key] of params) {
      if (key === "person_ids" && ++peopleCount > 5 || key === "seasons" && ++seasonCount > 8) return renderError(invalid, 400);
    }
    const allowed = new Set(["schema_version", "competition", "person_ids", "seasons", "start_season", "end_season", "metric", "normalization", "min_minutes", "viz"]);
    if ([...params.keys()].some(key => !allowed.has(key)) ||
        [...new Set(params.keys())].some(key => !["person_ids", "seasons"].includes(key) && params.getAll(key).length !== 1) ||
        (params.has("seasons") && (params.has("start_season") || params.has("end_season"))) || params.has("start_season") !== params.has("end_season")) return renderError(invalid, 400);

    const raw = {
      schema_version: params.has("schema_version") ? Number(params.get("schema_version")) : 1,
      competition: params.get("competition") ?? "PL",
      person_ids: params.getAll("person_ids"), seasons: params.has("seasons") ? params.getAll("seasons") : [],
      metric: params.get("metric") ?? "goals", normalization: params.get("normalization") ?? "total",
      min_minutes: params.has("min_minutes") && /^\d+$/.test(params.get("min_minutes")!) ? Number(params.get("min_minutes")) : params.has("min_minutes") ? NaN : (params.get("normalization") === "per90" ? 450 : 0),
      viz: params.get("viz") ?? "line",
    };
    if (params.has("start_season") && params.has("end_season")) {
      const allSeasons = [...new Set(catalog.coverage.filter(cell => cell.entity_type === "player" && cell.granularity === "box_score" && cell.competition === "PL" && cell.source_id === "fpl" && cell.redistributable && cell.cost_class === "cheap").map(cell => cell.season))].sort();
      const start = allSeasons.indexOf(params.get("start_season")!), end = allSeasons.indexOf(params.get("end_season")!);
      if (start < 0 || end < 0 || end < start) return renderError(invalid, 400);
      raw.seasons = allSeasons.slice(start, end + 1);
    }
    const coverageFor = (metric: string, season: string) => catalog.coverage.find(cell => cell.metric === metric && cell.entity_type === "player" && cell.granularity === "box_score" && cell.competition === "PL" && cell.season === season);
    const eligibleSeasons = [...new Set(catalog.coverage.filter(cell => cell.entity_type === "player" && cell.granularity === "box_score" && cell.competition === "PL" && ["goals", "assists"].every(metric => {
      const covered = coverageFor(metric, cell.season), minutes = coverageFor("minutes", cell.season);
      return [covered, minutes].every(item => item?.source_id === "fpl" && item.redistributable && item.cost_class === "cheap");
    })).map(cell => cell.season))].sort();
    let request;
    try {
      const preflight = parsePlayerTrendsRequest(raw, { snapshot_id: "preflight", person_ids: raw.person_ids, seasons: raw.seasons });
      if (preflight.seasons.some((season, i) => i > 0 && Number(preflight.seasons[i - 1]!.slice(0, 4)) + 1 !== Number(season.slice(0, 4))) || preflight.seasons.some(season => !eligibleSeasons.includes(season))) return renderError(invalid, 400);
      request = preflight;
    } catch {
      return renderError(invalid, 400);
    }
    if (!(await enforceBudget(c.env, { failClosed: true }))) return renderError(unavailable, 503);
    try {
      const snapshot = await currentSnapshot(c.env);
      if (!snapshot) return renderError(unavailable, 503);
      const identity = await playerRangeIdentityCatalog(c.env, request.person_ids, request.seasons, snapshot);
      if (identity.person_ids.length !== request.person_ids.length) return renderError(unknown, 404);
      request = parsePlayerTrendsRequest(raw, identity);
      const rows = await playerTrendsFacts(c.env.DB, request, snapshot, identity.person_ids, identity.seasons, catalog.coverage.map(cell => ({ ...cell, feasibility: catalog.checkFeasibility({ metric: cell.metric, entity_type: "player", entity_id: "all", season: cell.season, competition: "PL", dimensions: [], filters: {}, viz: "table", limit: 50 }, locale.code).state })));
      const result = calculatePlayerTrends(request, identity, rows);
      if (await currentSnapshot(c.env) !== snapshot) return renderError(unavailable, 503);
      const facts = await playerTrendsIdentityLabels(c.env, request.person_ids);
      if (facts.length !== request.person_ids.length || facts.some(person => !person.label?.trim())) return renderError(unknown, 404);
      const credits = Object.fromEntries(catalog.coverage.map(cell => [`${cell.source_id}:${cell.attribution_asset ?? cell.source_name}`, locale.code === "es" ? cell.attribution_text_es ?? cell.attribution_text ?? "" : cell.attribution_text ?? ""]));
      const form = `<form method="get" action="/${locale.code}/players/trends"><input type="hidden" name="schema_version" value="1"><input type="hidden" name="competition" value="PL"><label>${esc(t.playerTrendsPlayerLabel)}<select name="person_ids">${facts.map(person => `<option value="${esc(person.person_id)}"${person.person_id === request!.person_ids[0] ? " selected" : ""}>${esc(person.label)}</option>`).join("")}</select></label><label>${esc(t.playerTrendsFromLabel)}<select name="start_season">${eligibleSeasons.map(season => `<option value="${esc(season)}"${season === request!.seasons[0] ? " selected" : ""}>${esc(season)}</option>`).join("")}</select></label><label>${esc(t.playerTrendsThroughLabel)}<select name="end_season">${eligibleSeasons.map(season => `<option value="${esc(season)}"${season === request!.seasons[request!.seasons.length - 1] ? " selected" : ""}>${esc(season)}</option>`).join("")}</select></label><button type="submit">${esc(t.playerTrendsSubmit)}</button></form>`;
      const body = form + playerTrendsBody({ ...result, people: facts, credits }, {}, locale);
      const canonical = new URLSearchParams(); canonical.set("schema_version", "1"); canonical.set("competition", "PL"); request.person_ids.forEach(id => canonical.append("person_ids", id)); request.seasons.forEach(season => canonical.append("seasons", season)); canonical.set("metric", request.metric); canonical.set("normalization", request.normalization); canonical.set("min_minutes", String(request.min_minutes)); canonical.set("viz", request.viz);
      const res = html(page(body, { title: locale.strings.playerTrendsLink, locale, unprefixedPath: `/players/trends?${canonical}`, snapshotId: snapshot }));
      res.headers.set("Cache-Control", CACHE_CONTROL);
      return res;
    } catch {
      return renderError(unavailable, 503);
    }
  });

  app.get(`${p}/opponents/history`, async (c) => {
    const t = locale.strings;
    const invalid = t.opponentHistoryInvalid;
    const unavailable = t.opponentHistoryUnavailable;
    const renderError = (message: string, status: number) => html(page(`<h1>${esc(t.opponentHistoryTitle)}</h1><p>${esc(message)}</p>`, { title: t.opponentHistoryTitle, locale, unprefixedPath: "/opponents/history" }), status);
    const url = new URL(c.req.url);
    if (new TextEncoder().encode(url.search).byteLength > 2048) return renderError(invalid, 400);
    const params = url.searchParams;
    let seasonCount = 0;
    const seenSeasons = new Set<string>();
    for (const [key, value] of params) {
      if (key === "seasons") {
        if (++seasonCount > 16 || seenSeasons.has(value)) return renderError(invalid, 400);
        seenSeasons.add(value);
      }
    }
    const allowed = new Set(["schema_version", "competition", "seasons", "opponent_id"]);
    if ([...params.keys()].some(key => !allowed.has(key)) ||
        [...params.keys()].some(key => key !== "seasons" && params.getAll(key).length !== 1)) return renderError(invalid, 400);
    const opponent = params.get("opponent_id");
    const seasons = params.getAll("seasons");
    if (!opponent || !APPROVED_OPPONENT_IDS.has(opponent) || seasons.length !== seasonCount) return renderError(invalid, 400);
    if (new TextEncoder().encode(params.get("schema_version") ?? "").byteLength > 64 ||
        new TextEncoder().encode(params.get("competition") ?? "").byteLength > 64 ||
        new TextEncoder().encode(opponent).byteLength > 64) return renderError(invalid, 400);
    const availableSeasons = [...new Set(catalog.coverage.filter(cell => cell.competition === "PL").map(cell => cell.season))].sort();
    const raw = { schema_version: params.has("schema_version") ? Number(params.get("schema_version")) : 1,
      competition: params.get("competition") ?? "PL", seasons, group_by: "opponent", venue: null, opponent_id: opponent };
    let request;
    try { request = parseSeasonSplitRequest(raw, availableSeasons); }
    catch { return renderError(invalid, 400); }
    if (catalog.outputCapability("season_splits") !== "clear") {
      const res = html(page(opponentHistoryUnpublishedBody(locale.code), { title: t.opponentHistoryTitle, locale, unprefixedPath: "/opponents/history" }));
      res.headers.set("Cache-Control", CACHE_CONTROL);
      return res;
    }
    if (!(await enforceBudget(c.env, { failClosed: true }))) return renderError(unavailable, 503);
    let snapshot: string | null = null;
    try {
      const publication = await currentPublication(c.env);
      snapshot = publication?.snapshotId ?? null;
      if (!snapshot) throw new Error("snapshot unavailable");
      const facts = await seasonSplitFacts(c.env, snapshot, request.seasons, { venue: null, opponent_id: opponent });
      const result = await readOpponentHistory(c.env, request, facts.catalog);
      if (await currentSnapshot(c.env) !== snapshot) throw new Error("snapshot changed");
      // season_splits lineage_json contains bare catalog source IDs.
      const sourceCredits = new Map<string, Set<string>>();
      for (const cell of catalog.coverage) {
        const credit = (locale.code === "es" ? cell.attribution_text_es ?? cell.attribution_text : cell.attribution_text) ?? cell.source_name;
        if (!credit?.trim()) continue;
        if (!sourceCredits.has(cell.source_id)) sourceCredits.set(cell.source_id, new Set());
        sourceCredits.get(cell.source_id)!.add(credit);
      }
      const credits = Object.fromEntries([...sourceCredits].map(([id, texts]) => [id, [...texts].join(" · ")]));
      const body = opponentHistoryBody({ result, credits }, locale.code);
      const res = html(page(body, { title: t.opponentHistoryTitle, locale, unprefixedPath: `/opponents/history?${new URLSearchParams(params)}`, snapshotId: snapshot }));
      res.headers.set("Cache-Control", CACHE_CONTROL);
      return res;
    } catch { return renderError(unavailable, 503); }
  });

  app.get(p, async (c) => {
    const careerSeason = catalog.seasonsFor("goals", "player", "box_score").find((season) =>
      (["goals", "minutes"] as const).every((metric) => {
        const source = catalog.coverage.find((cell) =>
          cell.metric === metric && cell.entity_type === "player" &&
          cell.granularity === "box_score" && cell.season === season &&
          cell.competition === "PL",
        );
        if (source?.source_id !== "fpl") return false;
        const result = catalog.checkFeasibility({
          metric,
          entity_type: "player",
          entity_id: "all",
          season,
          competition: "PL",
          dimensions: [],
          filters: {},
          viz: "table",
          limit: 50,
        });
        return result.state === "available" || result.state === "computable_now_queued";
      }),
    );
    const [snapshot, publication, career] = await Promise.all([
      currentSnapshot(c.env).catch(() => null),
      currentPublication(c.env),
      (async () => {
        if (!careerSeason) return null;
        try {
          const squad = await seasonSquadRows(c.env, careerSeason);
          const personId = squad.find((row) => row.route_key?.trim())?.route_key.trim();
          if (!personId) return null;
          const rows = await playerCareerRows(c.env, personId);
          if (rows.some((candidate) => candidate.season === careerSeason)) {
            return { personId, season: careerSeason };
          }
        } catch {
          // A homepage suggestion is optional; a database hiccup must not take
          // down the localized coverage landing page.
        }
        return null;
      })(),
    ]);
    // Always indexable -- the coverage matrix hub, never a thin permutation.
    const res = html(
      page(homeBody(catalog, locale, freshnessView(snapshot, publication), career), {
        title: code === "es" ? "Estadísticas del Manchester United" : "Manchester United statistics",
        locale,
        unprefixedPath: "/",
      }),
    );
    res.headers.set("X-Robots-Tag", "index");
    res.headers.set("Cache-Control", CACHE_CONTROL);
    return res;
  });

  app.post(`${p}/ask`, async (c) => {
    const form = await c.req.formData();
    const question = String(form.get("q") ?? "").trim();
    if (!question) return c.redirect(p, 303);

    const playerNames = await allPlayerNames(c.env);
    const verdict = gateQuestion(question, locale.code, playerNames);
    if (!verdict.allowed) return renderRejection(locale, verdict, question);

    return renderChat(
      c,
      locale,
      await propose(verdict.question, c.env, playerNames),
      verdict.question,
      accessIdentity(c),
    );
  });

  app.get(`${p}/history`, async (c) => {
    const identity = accessIdentity(c);
    const entries = identity?.sub ? await listQuestionHistory(c.env, identity.sub) : [];
    return questionHistoryPage(locale, entries, Boolean(identity?.sub));
  });

  app.post(`${p}/history/clear`, async (c) => {
    const identity = accessIdentity(c);
    if (identity?.sub) await clearQuestionHistory(c.env, identity.sub);
    return c.redirect(`${p}/history`, 303);
  });

  /** Direct intent entry -- the "show this instead" path from a refusal. */
  app.get(`${p}/q`, async (c) => {
    const parameters = new URL(c.req.url).searchParams;
    const allowed = new Set([
      "metric",
      "entity_type",
      "entity_id",
      "season",
      "competition",
      "viz",
      "limit",
    ]);
    if ([...parameters.keys()].some((key) => !allowed.has(key) || parameters.getAll(key).length !== 1)) {
      return c.text("Unsupported or duplicate query parameter.", 400);
    }
    const q = c.req.query();
    const parsed = parseIntent({
      metric: q.metric ?? "goals",
      entity_type: q.entity_type ?? "player",
      entity_id: q.entity_id ?? "all",
      season: q.season ?? "2024-25",
      competition: q.competition ?? "PL",
      viz: q.viz ?? "bar",
      limit: q.limit === undefined ? 10 : /^\d+$/.test(q.limit) ? Number(q.limit) : Number.NaN,
    });
    if (!parsed.ok) return c.json({ error: parsed.issue }, 400);
    const intent = parsed.intent;
    // Unlike /ask, this route is GET, so the language toggle CAN replay it --
    // reconstruct the query string so switching locale lands on the same
    // result, not just the home page.
    const qs = new URL(c.req.url).search;
    return renderChat(
      c,
      locale,
      {
        intent,
        confidence: "high",
        notes: [],
        source: "rules",
        model_status: "not_configured",
      },
      null,
      accessIdentity(c),
      `/q${qs}`,
    );
  });

  app.get(`${p}/player/:name/:season?`, async (c) => {
    const nameParam = decodeURIComponent(c.req.param("name"));
    const seasonParam = c.req.param("season");

    const identity = await resolvePlayerIdentity(c.env, nameParam);
    const displayName = identity?.web_name ?? nameParam;
    const personKey = identity?.person_id ?? nameParam;
    const career = identity ? await playerCareerRows(c.env, identity.person_id) : [];
    const season = seasonParam ?? career[career.length - 1]?.season ?? "2024-25";

    const body = playerPageBody(displayName, season, career, catalog, locale, personKey);
    const res = html(
      page(body, {
        title: `${displayName}`,
        locale,
        unprefixedPath: `/player/${encodeURIComponent(personKey)}/${season}`,
        snapshotId: await currentSnapshot(c.env),
      }),
    );
    // SEO substance gate (docs/roadmap.md M3): a "not found" page (career
    // empty) never qualifies. hasSubstance mirrors the exact "yes" test the
    // page's own metric columns use, so the indexed set can never claim more
    // than what a visitor actually sees rendered.
    if (career.length > 0 && hasSubstance(columnFeasibility(catalog, "player", season, "PL", code))) {
      res.headers.set("X-Robots-Tag", "index");
    }
    // No enforceBudget() call on this route -- career/squad lookups are plain
    // reads, not the compute path the breaker guards -- so it is always safe
    // to cache, unlike /q below.
    res.headers.set("Cache-Control", CACHE_CONTROL);
    return res;
  });

  app.get(`${p}/season/:season`, async (c) => {
    const season = c.req.param("season");
    const eligibleSeasons = eligibleLeagueSeasons(catalog, season);
    // Champions League record fetched alongside the league one. Returns null
    // for every season United did not enter it, which is the common case and
    // not an error -- seasonPageBody simply renders no European line.
    const [squad, record, europeanRecord, history] = await Promise.all([
      seasonSquadRows(c.env, season),
      seasonRecordRow(c.env, season),
      seasonRecordRow(c.env, season, "CL"),
      seasonHistoryRows(c.env, eligibleSeasons),
    ]);
    const comparison = buildSeasonComparison(history, eligibleSeasons, catalog, code);
    const seasonBody = seasonPageBody(season, squad, record, catalog, locale, europeanRecord, comparison);
    const historyLink = `<p><a href="/${code}/seasons/champions-league">${locale.code === "es" ? "Historial de la Liga de Campeones" : "Champions League history"}</a></p>`;
    const body = `${seasonBody}${historyLink}`;
    const res = html(
      page(body, {
        title: `${season}`,
        locale,
        unprefixedPath: `/season/${season}`,
        snapshotId: await currentSnapshot(c.env),
      }),
    );
    // Coverage is keyed on (metric, season), not per player (pages.ts's own
    // comment on metricValueCells), so every player in a substantive season
    // shares the same feasibility -- no per-player loop needed here.
    if (squad.length > 0 && hasSubstance(columnFeasibility(catalog, "player", season, "PL", code))) {
      res.headers.set("X-Robots-Tag", "index");
    }
    // No enforceBudget() call on this route either -- same reasoning as
    // /player above.
    res.headers.set("Cache-Control", CACHE_CONTROL);
    return res;
  });

  app.get(`${p}/seasons/champions-league`, async (c) => {
    const url = new URL(c.req.url);
    if (url.search || url.pathname.endsWith("/")) return c.redirect(`/${code}/seasons/champions-league`, 301);
    const cells = catalog.coverage.filter((cell) => cell.metric === "goals" && cell.entity_type === "season" &&
      cell.granularity === "box_score" && cell.competition === "CL" && cell.source_id === "openfootball");
    const seasons = [...new Set(cells.map((cell) => cell.season))];
    seasons.sort((a, b) => Number(b.slice(0, 4)) - Number(a.slice(0, 4)));
    let snapshot: string | null = null;
    let body: string;
    let credits: (string | null | undefined)[] = [];
    try {
      const [publication, snapshotMetadata] = await Promise.all([
        currentPublication(c.env),
        c.env.DB.prepare("SELECT snapshot_id, sources_json FROM snapshots ORDER BY created_at DESC LIMIT 1")
          .first<{ snapshot_id: unknown; sources_json: unknown }>(),
      ]);
      if (!snapshotMetadata || typeof snapshotMetadata.snapshot_id !== "string") throw new Error("CL history publication unavailable");
      const result = await clHistoryRows(c.env, decodedCatalog, snapshotMetadata.snapshot_id);
      snapshot = result.snapshot_id;
      if (!publication || publication.snapshotId !== result.snapshot_id || !snapshot ||
          snapshotMetadata.snapshot_id !== snapshot || typeof snapshotMetadata.sources_json !== "string") {
        throw new Error("CL history publication unavailable");
      }
      let sourceHashes: unknown;
      try { sourceHashes = JSON.parse(snapshotMetadata.sources_json); } catch { throw new Error("Invalid snapshot lineage"); }
      if (!sourceHashes || typeof sourceHashes !== "object" || Array.isArray(sourceHashes)) throw new Error("Invalid snapshot lineage");
      const hashKeys = sourceHashes as Record<string, unknown>;
      for (const [key, value] of Object.entries(hashKeys)) {
        if (!/^[a-z0-9_]+(?::[A-Z]+)?(?::\d{4}-\d{2})?$/.test(key) || typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
          throw new Error("Invalid snapshot lineage");
        }
      }
      const source = publication.sources.find((item) => item.id === "openfootball_cl");
      if (source?.status === "unavailable" && result.entries.some((entry) => entry.status === "observed")) throw new Error("CL source unavailable");
      if (seasons.length === 0) {
        body = championsLeagueHistoryBody({ entries: [{ state: "out_of_coverage", season: "2026-27" }], credits: {} }, locale.strings.clHistory);
      } else {
        const mapped = result.entries.map((entry) => {
          if (entry.status === "gap") return { state: "gap" as const, season: entry.season };
          const cell = cells.find((candidate) => candidate.season === entry.row.season);
          const state = catalog.checkFeasibility({ metric: "goals", entity_type: "season", entity_id: "all", season: entry.row.season,
            competition: "CL", dimensions: [], filters: {}, viz: "table", limit: 1 }, code).state;
          if (!cell || !["available", "computable_now_queued"].includes(state)) return { state: "gap" as const, season: entry.row.season };
          if (hashKeys[`openfootball:CL:${entry.row.season}`] === undefined) {
            return { state: "observed" as const, row: { ...entry.row, lineage: [] } };
          }
          const ref = `${cell.source_id}:${cell.attribution_asset ?? cell.source_name}`;
          const credit = (code === "es" ? cell.attribution_text_es ?? cell.attribution_text : cell.attribution_text) ?? cell.source_name;
          if (credit.trim()) credits.push(credit);
          return { state: "partial" as const, row: { ...entry.row, lineage: [ref] } };
        });
        body = championsLeagueHistoryBody({ entries: mapped, credits: Object.fromEntries(cells.map((cell) => [
          `${cell.source_id}:${cell.attribution_asset ?? cell.source_name}`,
          (code === "es" ? cell.attribution_text_es ?? cell.attribution_text : cell.attribution_text) ?? cell.source_name,
        ])), snapshotDate: publication.loadedAt.slice(0, 10) }, locale.strings.clHistory);
      }
    } catch {
      body = championsLeagueHistoryBody({ entries: [], credits: {}, unavailable: true }, locale.strings.clHistory);
      snapshot = null;
    }
    const res = html(page(body, { title: locale.strings.clHistory.heading, locale, unprefixedPath: "/seasons/champions-league", snapshotId: snapshot, attribution: credits }));
    res.headers.set("Cache-Control", CACHE_CONTROL);
    return res;
  });
}

registerLocaleRoutes("en");
registerLocaleRoutes("es");

// Keep the locale landing pages on their canonical slashless URLs. Hono's
// default strict routing leaves /en/ and /es/ distinct from /en and /es; a
// fixed local destination also prevents query parameters from becoming an
// open redirect. GET handlers also service HEAD requests with an empty body.
for (const code of ["en", "es"] as const) {
  app.get(`/${code}/`, (c) => {
    const url = new URL(c.req.url);
    return c.redirect(`/${code}${url.search}`, 301);
  });
}

app.get("/robots.txt", () => {
  const body = `User-agent: *\nDisallow: /\n`;
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8", "Cache-Control": CACHE_CONTROL },
  });
});

/**
 * Same substance gate as the page routes, applied before a URL is even
 * offered -- the M3 exit criterion "no thin permutation page reaches the
 * sitemap" fails if this list is built any other way (e.g. from raw coverage
 * cells, which is what actually caused the noindex/sitemap mismatch this
 * design deliberately avoids: coverage > 0 is not the same test as
 * hasSubstance, and a page that fails the page's own indexability check must
 * never appear here either).
 */
app.get("/sitemap.xml", async (c) => {
  const seasons = [...new Set(catalog.coverage.map((cell) => cell.season))].sort();
  const urls: string[] = ["/en", "/es"];

  for (const season of seasons) {
    const feas = columnFeasibility(catalog, "player", season);
    if (!hasSubstance(feas)) continue;

    const squad = await seasonSquadRows(c.env, season);
    if (squad.length === 0) continue;

    urls.push(`/en/season/${season}`, `/es/season/${season}`);
    for (const p of squad) {
      const path = `/player/${encodeURIComponent(p.label)}/${season}`;
      urls.push(`/en${path}`, `/es${path}`);
    }
  }

  // lastmod is optional per the sitemap protocol -- currentSnapshot() returns
  // a content hash, not a date, and misusing it as one would be worse than
  // omitting the field.
  //
  // Absolute URLs are required by the sitemap protocol, but the real domain
  // (O-5, docs/roadmap.md blockers) isn't registered yet -- derive the origin
  // from the actual request instead of hard-coding one, so this is correct on
  // dev/prod *.workers.dev today and needs no change once a real domain lands.
  const origin = new URL(c.req.url).origin;
  const entries = urls.map((u) => `<url><loc>${origin}${u}</loc></url>`).join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`;
  return new Response(xml, {
    headers: { "content-type": "application/xml; charset=utf-8", "Cache-Control": CACHE_CONTROL },
  });
});

// Bare paths redirect to /en/ rather than serving duplicate content at a
// second URL. 301 (not 302): this is a permanent structural decision, not a
// temporary redirect -- search engines should consolidate ranking signal onto
// the canonical /en/ URL rather than treating the two as separate pages.
app.get("/", (c) => c.redirect("/en", 301));
app.get("/q", (c) => c.redirect(`/en/q?${new URL(c.req.url).searchParams.toString()}`, 301));
app.get("/data", (c) => c.redirect("/en/data", 301));
app.get("/player/:name/:season?", (c) => c.redirect(`/en${new URL(c.req.url).pathname}`, 301));
app.get("/season/:season", (c) => c.redirect(`/en${new URL(c.req.url).pathname}`, 301));

app.notFound(async (c) => {
  // Worker-first routing ensures every asset passes authorization above.
  if (["GET", "HEAD"].includes(c.req.method) && c.env.ASSETS) {
    const asset = await c.env.ASSETS.fetch(c.req.raw);
    if (asset.status !== 404) return asset;
    await asset.body?.cancel();
  }
  const locale = LOCALES[new URL(c.req.url).pathname.startsWith("/es") ? "es" : "en"];
  const t = locale.strings;
  return html(
    page(
      `<h1>${t.notFoundHeading}</h1><p>${t.notFoundBody}</p><p><a href="/${locale.code}">${t.startAgain}</a></p>`,
      { title: t.notFoundHeading, locale, unprefixedPath: "/" },
    ),
    404,
  );
});

// ---------------------------------------------------------------------------

/**
 * Observability for the gate.
 *
 * Logs the REJECT CODE ONLY, never the text. Rejected input is by definition
 * untrusted -- it may carry an injection payload, someone's personal detail,
 * or abuse -- and none of that belongs in a log line that a person will later
 * read in a dashboard. The code is what makes the gate tunable; the text is
 * not needed to tune it.
 */
function noteRejection(verdict: GateRejected): void {
  console.warn(`ask_gate_reject code=${verdict.code}`);
}

/**
 * A rejection is not an error, so it is not a 4xx-with-`error`. 422 says the
 * request was well-formed and understood, and deliberately not acted on --
 * which is exactly what happened.
 *
 * Demand for rejected questions is genuinely valuable signal and is NOT
 * recorded here: demand_log is keyed on an artifact key over a QueryIntent,
 * and a rejected question has no intent. Forcing one in would mean inventing
 * an intent nobody asked for, which corrupts the one table that tells us what
 * people actually want. A separate rejection log is the right shape and is
 * deferred rather than bodged in.
 */
function rejectionBody(verdict: GateRejected) {
  noteRejection(verdict);
  return {
    rejected: true,
    code: verdict.code,
    reason: verdict.reason,
    suggestion: verdict.suggestion,
    // Both null so a client can branch on presence without special-casing
    // the rejected shape -- same envelope, no proposal, no feasibility.
    proposed_intent: null,
    feasibility: null,
  };
}

/** The HTML twin of rejectionResponse. Never cached: the copy is stable, but
 *  caching a refusal keyed only on URL would serve it for a different POST
 *  body, and /ask is a POST route with no cacheable identity anyway. */
function renderRejection(locale: Locale, verdict: GateRejected, question: string): Response {
  noteRejection(verdict);
  const body = `<h1>iammufc</h1>
<div class="card">${chatForm(locale, question)}</div>
${rejectionPanel(verdict, locale)}
<p><a href="/${locale.code}">${esc(locale.strings.backToMatrix)}</a></p>`;
  return html(page(body, { title: verdict.code, locale, unprefixedPath: "/" }));
}

function questionHistoryPage(locale: Locale, entries: QuestionHistoryEntry[], signedIn: boolean): Response {
  const spanish = locale.code === "es";
  const title = spanish ? "Preguntas anteriores" : "Past questions";
  const list = entries.length
    ? `<ol>${entries.map((entry) => {
      const linkLabel = spanish ? "Ver visualización" : "View visualization";
      return `<li><p>${esc(entry.question)}</p><p><a href="${esc(entry.visualizationPath)}">${linkLabel}</a></p></li>`;
    }).join("")}</ol>`
    : `<p>${spanish ? "Aún no hay preguntas guardadas." : "No saved questions yet."}</p>`;
  const clear = signedIn && entries.length
    ? `<form method="post" action="/${locale.code}/history/clear"><button type="submit">${spanish ? "Borrar historial" : "Clear history"}</button></form>`
    : "";
  return html(page(
    `<h1>${title}</h1>
<p>${spanish
      ? "Tus preguntas se guardan en esta cuenta y se pueden volver a abrir cuando haya datos nuevos."
      : "Your questions are saved to this account and can be reopened when new data becomes available."}</p>
${list}${clear}
<p><a href="/${locale.code}">${esc(locale.strings.backToMatrix)}</a></p>`,
    { title, locale, unprefixedPath: "/history" },
  ));
}

async function propose(
  question: string,
  env: Env,
  knownPlayerNames: readonly string[] = [],
): Promise<Proposal> {
  // Rule-based always runs: it is the floor, and it makes the site fully usable
  // with no account, no network call, and no inference cost.
  const rules = parseRuleBased(question, catalog);
  const identityAmbiguous = hasAmbiguousPlayerReference(question, knownPlayerNames);
  if (!env.AI) {
    return identityAmbiguous
      ? {
          ...rules,
          confidence: "low",
          notes: [...rules.notes, "Player identity is ambiguous."],
          model_status: "not_attempted_ambiguous",
        }
      : rules;
  }

  if (env.AI_PROPOSALS_ENABLED !== "true") {
    return {
      ...rules,
      confidence: identityAmbiguous ? "low" : rules.confidence,
      notes: [
        ...rules.notes,
        ...(identityAmbiguous ? ["Player identity is ambiguous."] : []),
        "AI proposal unavailable (disabled); using rules.",
      ],
      model_status: "disabled",
    };
  }

  // The model may extract fields, but it must not invent a missing metric or
  // season. Keep ambiguous input visible and require the user to correct it.
  if (rules.confidence === "low" || identityAmbiguous) {
    return {
      ...rules,
      confidence: "low",
      notes: identityAmbiguous
        ? [...rules.notes, "Player identity is ambiguous."]
        : rules.notes,
      model_status: "not_attempted_ambiguous",
    };
  }

  const ai = await proposeWithAI(question, catalog, env.AI, AI_MODEL);
  if (!ai.proposal) {
    return {
      ...rules,
      model_status: ai.failure,
      notes: [...rules.notes, `AI proposal unavailable (${ai.failure}); using rules.`],
    };
  }

  // Whatever the model returned is still only a proposal, and the catalog is
  // what decides whether it means anything.
  const preservesDeterministicIntent = canonicalize(ai.proposal.intent) === canonicalize(rules.intent);
  return catalog.metric(ai.proposal.intent.metric) && preservesDeterministicIntent
    ? ai.proposal
    : {
        ...rules,
        model_status: "unsupported_intent",
        notes: [...rules.notes, "AI proposal unavailable (unsupported_intent); using rules."],
      };
}

async function renderChat(
  c: { env: Env; executionCtx: { waitUntil(promise: Promise<unknown>): void } },
  locale: Locale,
  proposal: Proposal,
  question: string | null,
  identity: AccessIdentity,
  /** The GET-reachable equivalent of this result, if one exists. /q results
   *  have one (the query string reconstructs the same intent); /ask POST
   *  results do not -- a language toggle cannot replay a POST, so it falls
   *  back to home rather than link somewhere false. */
  unprefixedPath: string = "/",
): Promise<Response> {
  const parsed = parseIntent(proposal.intent);
  if (!parsed.ok) return html("Invalid query.", 400);
  const semanticIssue = validateQuerySemantics(parsed.intent);
  if (semanticIssue) return html(`Unsupported query field: ${semanticIssue.field}.`, 422);
  proposal = { ...proposal, intent: parsed.intent };
  if (question !== null && proposal.confidence === "low") {
    const body = `<h1>iammufc</h1>
<div class="card">${chatForm(locale, question)}</div>
${intentPanel(proposal, locale)}
<div class="stop"><p><strong>${esc(locale.strings.clarificationRequired)}</strong></p></div>
<p><a href="/${locale.code}">${esc(locale.strings.backToMatrix)}</a></p>`;
    return html(
      page(body, {
        title: proposal.intent.metric,
        locale,
        unprefixedPath,
      }),
    );
  }
  const snapshot = await currentSnapshot(c.env);
  const key = await artifactKey(proposal.intent, snapshot ?? "no-snapshot");
  const feasibility = catalog.checkFeasibility(proposal.intent, locale.code);

  const cacheEligible =
    feasibility.state === "available" ||
    feasibility.state === "computable_now_queued" ||
    feasibility.state === "computable_but_expensive";
  const executionIssue = cacheEligible ? validateExecutionSupport(proposal.intent) : null;
  if (executionIssue) return html(`Unsupported query field: ${executionIssue.field}.`, 422);

  const routeFamily = question === null ? "query_page" : "ask_page";
  const execution = cacheEligible
    ? await executeWithCache(
        c.env,
        proposal.intent,
        key,
        snapshot,
        feasibility.state !== "computable_but_expensive",
      )
    : { result: null, cacheOutcome: "not_applicable" as const, overBudget: false as const };
  const responseFeasibility = execution.cacheOutcome === "hit"
    ? catalog.checkFeasibility(proposal.intent, locale.code, true)
    : feasibility;
  deferAggregate(c, logQueryAggregate(
    c.env,
    proposal.intent,
    responseFeasibility.state,
    execution.cacheOutcome,
    execution.overBudget ? "budget_exceeded" : execution.result ? "success" : "refused",
    locale.code,
    routeFamily,
  ));
  const overBudget = execution.overBudget;
  if (question !== null && identity?.sub && !overBudget && responseFeasibility.state !== "no_rights") {
    await saveQuestionHistory(c.env, identity.sub, question, proposal.intent, locale.code).catch(() => {});
  }
  const rows = execution.result?.rows ?? [];

  const resultBlock = overBudget
    ? `<div class="stop">
<p class="state">budget_exceeded</p>
<p><strong>${esc(locale.strings.budgetExceeded)}</strong></p>
</div>`
    : resultPanel(proposal.intent, responseFeasibility, rows, catalog, key, locale);

  const body = `<h1>iammufc</h1>
<div class="card">${chatForm(locale, question ?? "")}</div>
${intentPanel(proposal, locale)}
${resultBlock}
${identity?.sub ? `<p><a href="/${locale.code}/history">${locale.code === "es" ? "Preguntas anteriores" : "Past questions"}</a></p>` : ""}
<p><a href="/${locale.code}">${locale.strings.backToMatrix}</a></p>`;

  const res = html(
    page(body, {
      title: `${proposal.intent.metric} ${proposal.intent.season}`,
      locale,
      unprefixedPath,
      attribution: [responseFeasibility.attribution_text],
      snapshotId: snapshot,
    }),
  );
  // budget_exceeded must never be cached: it is a same-day, time-varying
  // state that resets at midnight UTC, unlike every other branch here (which
  // stays correct until the next deploy). Caching it would trap users behind
  // a stale refusal for up to an hour after the real budget already reset.
  if (!overBudget) res.headers.set("Cache-Control", CACHE_CONTROL);
  return res;
}

export default app;
