/**
 * Deterministic execution over D1.
 *
 * Every query here is parameterised and hand-written. No SQL is ever generated
 * from natural language, and no SQL string is ever assembled from user input --
 * the metric name selects a column from a fixed allowlist, it never becomes one.
 */

import type { QueryIntent } from "./intent";
import { parseIntent, validateExecutionSupport } from "./validate-intent";
import type { PlayerRangeCatalog, PlayerRangeRequest, PlayerRangeRow } from "./player-range";
import type { CoverageCell } from "./feasibility";
import type { SeasonSplitCatalog, SeasonSplitRow } from "./season-splits";

export interface Env {
  DB: D1Database;
  CFG: KVNamespace;
  ASSETS?: Fetcher;
  ACCESS_ISSUER?: string;
  ACCESS_AUD?: string;
  ACCESS_OWNER_EMAILS?: string;
  /** Optional exact service client IDs; absent disables machine identities. */
  ACCESS_SERVICE_CLIENT_IDS?: string;
  AI?: { run: (model: string, input: unknown) => Promise<unknown> };
  /** Explicit opt-in after a candidate passes evaluation; absent keeps rules-only. */
  AI_PROPOSALS_ENABLED?: string;
}

/** A successfully parsed, semantically validated website ask. The account key
 * is the verified human Access `sub`; callers must never pass email or the
 * service-token identity (whose subject is empty). */
export interface QuestionHistoryEntry {
  id: number;
  question: string;
  visualizationPath: string;
  locale: "en" | "es";
  createdAt: string;
}

export const QUESTION_HISTORY_LIMIT = 50;

function validHumanSubject(subject: string): boolean {
  return typeof subject === "string" && subject.trim().length > 0 && subject.length <= 512;
}

/** Store a validated question separately from aggregate telemetry. The
 * canonical path replays the same finite intent against the current snapshot,
 * allowing a previously unavailable answer to become visualizable later. */
export async function saveQuestionHistory(
  env: Env,
  humanSubject: string,
  question: string,
  intent: QueryIntent,
  locale: "en" | "es",
): Promise<void> {
  if (!validHumanSubject(humanSubject)) throw new Error("human_access_subject_required");
  const normalizedQuestion = question.trim();
  if (!normalizedQuestion || normalizedQuestion.length > 1000) throw new Error("invalid_history_question");
  const params = new URLSearchParams({
    metric: intent.metric,
    entity_type: intent.entity_type,
    entity_id: intent.entity_id,
    season: intent.season,
    competition: intent.competition,
    viz: intent.viz,
    limit: String(intent.limit),
  });
  const path = `/${locale}/q?${params.toString()}`;
  const inserted = env.DB.prepare(
    `INSERT INTO account_question_history (account_sub, question_text, visualization_path, locale, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(humanSubject, normalizedQuestion, path, locale, new Date().toISOString());
  const trimmed = env.DB.prepare(
    `DELETE FROM account_question_history
     WHERE account_sub = ? AND id NOT IN (
       SELECT id FROM account_question_history WHERE account_sub = ? ORDER BY id DESC LIMIT ${QUESTION_HISTORY_LIMIT}
     )`,
  ).bind(humanSubject, humanSubject);
  await env.DB.batch([inserted, trimmed]);
}

export async function listQuestionHistory(env: Env, humanSubject: string): Promise<QuestionHistoryEntry[]> {
  if (!validHumanSubject(humanSubject)) throw new Error("human_access_subject_required");
  const rows = await env.DB.prepare(
    `SELECT id, question_text, visualization_path, locale, created_at
     FROM account_question_history WHERE account_sub = ? ORDER BY id DESC LIMIT ${QUESTION_HISTORY_LIMIT}`,
  ).bind(humanSubject).all<{
    id: number; question_text: string; visualization_path: string; locale: "en" | "es"; created_at: string;
  }>();
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    question: row.question_text,
    visualizationPath: row.visualization_path,
    locale: row.locale,
    createdAt: row.created_at,
  }));
}

export async function clearQuestionHistory(env: Env, humanSubject: string): Promise<void> {
  if (!validHumanSubject(humanSubject)) throw new Error("human_access_subject_required");
  await env.DB.prepare("DELETE FROM account_question_history WHERE account_sub = ?")
    .bind(humanSubject).run();
}

/** Metric id -> physical column. A fixed map is what makes the metric name
 *  un-injectable: an unknown metric has no entry and the query never runs. */
const METRIC_COLUMN: Record<string, string> = {
  goals: "s.goals",
  assists: "s.assists",
  minutes: "s.minutes",
  points: "s.points",
  xg: "s.xg",
};

export interface ResultRow {
  label: string;
  value: number | null;
  secondary?: string;
  route_key?: string;
}

export interface QueryResult {
  rows: ResultRow[];
  snapshot_id: string | null;
  unit: string;
}

export type CacheOutcome = "hit" | "miss" | "unavailable" | "not_applicable";
export type QueryLocale = "api" | "en" | "es";
export type QueryRouteFamily = "query_api" | "query_page" | "ask_page";

export interface CacheLookup {
  result: QueryResult | null;
  outcome: CacheOutcome;
}

const CACHE_JSON_LIMIT = 100_000;
const CACHE_ROW_LIMIT = 50;
export const QUERY_CACHE_SLOT_COUNT = 512;
const RESULT_KEYS = ["rows", "snapshot_id", "unit"] as const;
const RESULT_ROW_KEYS = ["label", "route_key", "secondary", "value"] as const;

/** Use the first 32 bits of the already-computed SHA-256 artifact key to pick
 * one of a fixed number of slots. Collisions only evict cache entries. */
export function queryCacheSlot(artifactKey: string): number | null {
  if (!/^[a-f0-9]{64}$/.test(artifactKey)) return null;
  return Number.parseInt(artifactKey.slice(0, 8), 16) % QUERY_CACHE_SLOT_COUNT;
}

function cachedResult(
  raw: unknown,
  expectedSnapshot: string,
  intent: QueryIntent,
): QueryResult | null {
  if (typeof raw !== "string" || raw.length > CACHE_JSON_LIMIT) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!plainRecord(value) || !hasExactKeys(value, RESULT_KEYS)) return null;
  const expectedUnit = intent.entity_type === "season" ? "goals" : intent.metric;
  if (value.snapshot_id !== expectedSnapshot || value.unit !== expectedUnit) {
    return null;
  }
  const rowLimit = Math.min(Math.max(intent.limit, 1), CACHE_ROW_LIMIT);
  if (!Array.isArray(value.rows) || value.rows.length > rowLimit) return null;
  const rows: ResultRow[] = [];
  for (const candidate of value.rows) {
    if (!plainRecord(candidate)) return null;
    const keys = Object.keys(candidate).sort();
    if (keys.some((key) => !RESULT_ROW_KEYS.includes(key as typeof RESULT_ROW_KEYS[number]))) return null;
    if (!keys.includes("label") || !keys.includes("value")) return null;
    if (
      typeof candidate.label !== "string" || candidate.label.length > 160 ||
      (candidate.value !== null && (typeof candidate.value !== "number" || !Number.isFinite(candidate.value))) ||
      (candidate.secondary !== undefined && (typeof candidate.secondary !== "string" || candidate.secondary.length > 160)) ||
      (intent.entity_type === "season" && candidate.route_key !== undefined) ||
      (intent.entity_type !== "season" &&
        (typeof candidate.route_key !== "string" || !/^fpl:code:[1-9]\d*$/.test(candidate.route_key)))
    ) return null;
    rows.push(candidate as unknown as ResultRow);
  }
  return { rows, snapshot_id: expectedSnapshot, unit: value.unit };
}

/** Read a result only for the exact artifact/snapshot pair. Malformed rows are
 * misses; storage failures are reported to telemetry but never fail a query. */
export async function readQueryCache(
  env: Env,
  artifactKey: string,
  snapshotId: string | null,
  intent: QueryIntent,
): Promise<CacheLookup> {
  const slot = queryCacheSlot(artifactKey);
  if (slot === null || !snapshotId || !SNAPSHOT_RE.test(snapshotId)) return { result: null, outcome: "not_applicable" };
  try {
    const row = await env.DB.prepare(
      "SELECT artifact_key, snapshot_id, schema_version, result_json FROM query_result_cache_slots WHERE slot = ?",
    ).bind(slot).first<{ artifact_key: unknown; snapshot_id: unknown; schema_version: unknown; result_json: unknown }>();
    if (!row || row.artifact_key !== artifactKey || row.snapshot_id !== snapshotId || row.schema_version !== 1) {
      return { result: null, outcome: "miss" };
    }
    const result = cachedResult(row.result_json, snapshotId, intent);
    return result ? { result, outcome: "hit" } : { result: null, outcome: "miss" };
  } catch {
    return { result: null, outcome: "unavailable" };
  }
}

/** Best-effort idempotent write. A cache outage never changes the answer. */
export async function writeQueryCache(
  env: Env,
  artifactKey: string,
  snapshotId: string | null,
  result: QueryResult,
  intent: QueryIntent,
): Promise<boolean> {
  const slot = queryCacheSlot(artifactKey);
  if (slot === null || !snapshotId || !SNAPSHOT_RE.test(snapshotId) || result.snapshot_id !== snapshotId) return false;
  const encoded = JSON.stringify(result);
  if (!cachedResult(encoded, snapshotId, intent)) return false;
  try {
    const stored = await env.DB.prepare(
      `INSERT INTO query_result_cache_slots (slot, artifact_key, snapshot_id, schema_version, result_json)
       SELECT ?, ?, ?, 1, ?
       WHERE ? = (SELECT snapshot_id FROM snapshots ORDER BY created_at DESC LIMIT 1)
       ON CONFLICT(slot) DO UPDATE SET
         artifact_key = excluded.artifact_key,
         snapshot_id = excluded.snapshot_id,
         schema_version = excluded.schema_version,
         result_json = excluded.result_json`,
    ).bind(slot, artifactKey, snapshotId, encoded, snapshotId).run();
    return stored.success && stored.meta.changes > 0;
  } catch {
    return false;
  }
}

type QuestionFamily = "player_ranking" | "player_lookup" | "team_season" | "match" | "opponent" | "competition";

function questionFamily(intent: QueryIntent): QuestionFamily {
  if (intent.entity_type === "season") return "team_season";
  if (intent.entity_type === "player") {
    return intent.entity_id === ALL_PLAYERS ? "player_ranking" : "player_lookup";
  }
  return intent.entity_type;
}

const DEMAND_METRICS = new Set(["goals", "assists", "minutes", "points", "xg", "progressive_passes"]);

function metricFamily(metric: string): "goals" | "assists" | "minutes" | "points" | "xg" | "progressive_passes" | "other" {
  return DEMAND_METRICS.has(metric)
    ? metric as "goals" | "assists" | "minutes" | "points" | "xg" | "progressive_passes"
    : "other";
}

/** Aggregate-only demand signal. Every bound value comes from a finite parser,
 * feasibility enum or route constant; no request-derived free text enters D1. */
export async function logQueryAggregate(
  env: Env,
  intent: QueryIntent,
  feasibilityState: string,
  cacheOutcome: CacheOutcome,
  resultOutcome: "success" | "refused" | "budget_exceeded",
  locale: QueryLocale,
  routeFamily: QueryRouteFamily,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO query_demand_aggregate
       (metric, question_family, viz, feasibility_state, cache_outcome, result_outcome, locale, route_family, request_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(metric, question_family, viz, feasibility_state, cache_outcome, result_outcome, locale, route_family)
     DO UPDATE SET request_count = request_count + 1`,
  ).bind(
    metricFamily(intent.metric),
    questionFamily(intent),
    intent.viz,
    feasibilityState,
    cacheOutcome,
    resultOutcome,
    locale,
    routeFamily,
  ).run();
}

const BUDGET_FAST_LIMIT = 800; // KV pre-filter -- leaves headroom under KV's 1,000 writes/day free-tier ceiling for the rest of the app
const BUDGET_HARD_LIMIT = 1000; // D1 authoritative cap -- D1's own free tier (100k writes/day) is nowhere close to this

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Budget breaker for the compute path (/api/query, /ask, /q). Guards the
 * ~$5/month hosting budget against a traffic spike, not against a
 * sophisticated attacker -- it is a circuit breaker, not a security control.
 *
 * KV is a same-day pre-filter: eventually consistent and has no atomic
 * increment, so two concurrent requests can both read "under budget" and
 * both write, undercounting. That race is exactly why KV is never the source
 * of truth here. D1's upsert is atomic and strongly consistent, so it is the
 * real gate; KV only exists to skip the D1 round-trip once the day is
 * obviously over budget.
 *
 * Returns false if D1 cannot confirm the authoritative count. KV remains an
 * advisory pre-filter; callers can choose route-specific failure handling.
 */
export async function enforceBudget(
  env: Env,
  options: { failClosed?: boolean; denial?: { reason?: "over_limit" | "unavailable" } } = {},
): Promise<boolean> {
  // `denial` is an optional out-param: on false it says whether the budget is
  // really spent ("over_limit") or storage could not confirm ("unavailable").
  // A non-finite stored count is always denied as "unavailable".
  if (options.denial) options.denial.reason = undefined;
  // Fail closed unless the caller explicitly passes failClosed: false.
  const failClosed = options.failClosed !== false;
  const deny = (reason: "over_limit" | "unavailable") => {
    if (options.denial) options.denial.reason = reason;
    return false;
  };
  const day = utcDay();

  try {
    const kvKey = `budget:${day}`;
    const raw = await env.CFG.get(kvKey);
    const kvCount = raw ? Number(raw) : 0;
    if (Number.isFinite(kvCount) && kvCount >= BUDGET_FAST_LIMIT) return deny("over_limit");
    // Best-effort increment. KV's eventual consistency means this can race --
    // deliberately not the enforcement point, see the D1 check below.
    await env.CFG.put(kvKey, String(kvCount + 1), { expirationTtl: 172800 }); // 2 days, covers UTC-boundary clock skew
  } catch {
    // KV unavailable: fall through to D1, which is the real gate anyway.
  }

  try {
    // One statement: atomic upsert that returns the post-increment count.
    const row = await env.DB.prepare(
      `INSERT INTO budget_counter (day, count) VALUES (?, 1)
         ON CONFLICT(day) DO UPDATE SET count = count + 1
         RETURNING count`,
    )
      .bind(day)
      .first<{ count: number }>();
    if (!row || !Number.isFinite(row.count)) return deny("unavailable");
    return row.count <= BUDGET_HARD_LIMIT ? true : deny("over_limit");
  } catch {
    return failClosed ? deny("unavailable") : true;
  }
}

export async function currentSnapshot(env: Env): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT snapshot_id FROM snapshots ORDER BY created_at DESC LIMIT 1",
  ).first<{ snapshot_id: string }>();
  return row?.snapshot_id ?? null;
}

/** Read only the bounded aggregate projection for one current snapshot. The
 * catalog capability is passed in by the caller and must already be validated. */
export async function seasonSplitFacts(
  env: Env,
  snapshotId: string,
  seasons: readonly string[],
  dimensions: { venue: "home" | "away" | null; opponent_id: string | null } = { venue: null, opponent_id: null },
): Promise<{ catalog: SeasonSplitCatalog; rows: SeasonSplitRow[] }> {
  if (!/^[0-9a-f]{64}$/.test(snapshotId) || seasons.length < 1 || seasons.length > 16 ||
      seasons.some((value) => !/^\d{4}-\d{2}$/.test(value)) ||
      (dimensions.venue !== null && dimensions.venue !== "home" && dimensions.venue !== "away") ||
      (dimensions.opponent_id !== null && !/^club:[1-9][0-9]{0,17}$/.test(dimensions.opponent_id))) {
    throw new Error("invalid season split read");
  }
  const publication = await env.DB.prepare(
    `SELECT r.snapshot_id FROM publication_runs r
      JOIN snapshots s ON s.snapshot_id = r.snapshot_id
     ORDER BY r.run_id DESC LIMIT 1`,
  ).first<{ snapshot_id: unknown }>();
  if (publication?.snapshot_id !== snapshotId) throw new Error("stale season split publication");
  const marks = seasons.map(() => "?").join(",");
  const venueClause = dimensions.venue === null ? "" : " AND venue = ?";
  const opponentClause = dimensions.opponent_id === null ? "" : " AND opponent_id = ?";
  const dimensionBindings = [
    ...(dimensions.venue === null ? [] : [dimensions.venue]),
    ...(dimensions.opponent_id === null ? [] : [dimensions.opponent_id]),
  ];
  // The seed producer at data-platform/pipeline/aggregates/season_splits_seed.py
  // emits season/venue/opponent grains; the aggregate contract caps
  // MAX_SEASONS=16 and MAX_OPPONENTS=128 in season_splits.py, so 16 × 2 venues
  // × 128 opponents = 4,096 rows.
  // Fetch one extra row as an overflow sentinel; keep LIMIT inside D1.
  const producerMaxRows = 16 * 2 * 128;
  const { results } = await env.DB.prepare(
    `SELECT snapshot_id, season, competition, venue, opponent_id, played, won, drawn, lost,
            goals_for, goals_against, lineage_json
       FROM season_splits WHERE snapshot_id = ? AND season IN (${marks})${venueClause}${opponentClause}
       ORDER BY season, venue, opponent_id LIMIT ${producerMaxRows + 1}`,
  ).bind(snapshotId, ...seasons, ...dimensionBindings).all<{
    snapshot_id: string; season: string; competition: "PL"; venue: "home" | "away";
    opponent_id: string; played: number; won: number; drawn: number; lost: number;
    goals_for: number; goals_against: number; lineage_json: string;
  }>();
  if ((results ?? []).length > producerMaxRows) throw new Error("season split read bound reached");
  const { results: lineageResults } = await env.DB.prepare(
    `SELECT season, lineage_json FROM season_splits
      WHERE snapshot_id = ? AND competition = 'PL' AND season IN (${marks})
      ORDER BY season, venue, opponent_id LIMIT ${producerMaxRows + 1}`,
  ).bind(snapshotId, ...seasons).all<{ season: string; lineage_json: string }>();
  if ((lineageResults ?? []).length > producerMaxRows) throw new Error("season split lineage bound reached");
  const totals = await env.DB.prepare(
    `SELECT season, played FROM season_stats
      WHERE snapshot_id = ? AND competition = 'PL' AND season IN (${marks})`,
  ).bind(snapshotId, ...seasons).all<{ season: string; played: number }>();
  const aggregateTotals = await env.DB.prepare(
    `SELECT season, SUM(played) AS played, COUNT(*) AS row_count FROM season_splits
      WHERE snapshot_id = ? AND competition = 'PL' AND season IN (${marks})
      GROUP BY season`,
  ).bind(snapshotId, ...seasons).all<{ season: string; played: number; row_count: number }>();
  const allowedSources = new Set(["football_data_couk", "fpl"]);
  const validLineage = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= 32 &&
    value.every((source) => typeof source === "string" && allowedSources.has(source)) && new Set(value).size === value.length;
  const rows: SeasonSplitRow[] = [];
  const malformedSeasons = new Set<string>();
  for (const row of lineageResults ?? []) {
    let lineage: unknown;
    try { lineage = JSON.parse(row.lineage_json); } catch { malformedSeasons.add(row.season); continue; }
    if (!validLineage(lineage)) malformedSeasons.add(row.season);
  }
  for (const row of results ?? []) {
    let lineage: unknown;
    try { lineage = JSON.parse(row.lineage_json); } catch { malformedSeasons.add(row.season); continue; }
    if (!validLineage(lineage)) { malformedSeasons.add(row.season); continue; }
    rows.push({ snapshot_id: row.snapshot_id, season: row.season, competition: row.competition,
      venue: row.venue, opponent_id: row.opponent_id, played: row.played, won: row.won,
      drawn: row.drawn, lost: row.lost, goals_for: row.goals_for, goals_against: row.goals_against,
      lineage });
  }
  const totalsBySeason = new Map((totals.results ?? []).map((entry) => [entry.season, entry.played]));
  const aggregatesBySeason = new Map((aggregateTotals.results ?? []).map((entry) => [entry.season, entry]));
  const publicationAfterReads = await env.DB.prepare(
    `SELECT r.snapshot_id FROM publication_runs r
      JOIN snapshots s ON s.snapshot_id = r.snapshot_id
     ORDER BY r.run_id DESC LIMIT 1`,
  ).first<{ snapshot_id: unknown }>();
  if (publicationAfterReads?.snapshot_id !== snapshotId) throw new Error("season split publication changed during read");
  const seasonCoverage: SeasonSplitCatalog["seasons"] = seasons.map((season) => ({
    season,
    coverage: (aggregatesBySeason.get(season)?.row_count ?? 0) > 0 &&
      !malformedSeasons.has(season) && totalsBySeason.has(season) &&
      aggregatesBySeason.get(season)?.played === totalsBySeason.get(season)
        ? "complete" : "missing",
  }));
  const completeSeasons = new Set(seasonCoverage.filter((entry) => entry.coverage === "complete").map((entry) => entry.season));
  return { catalog: { snapshot_id: snapshotId, seasons: seasonCoverage },
    rows: rows.filter((row) => completeSeasons.has(row.season)) };
}

/** Bounded, stable-ID-only facts for the selected-player comparison. */
export async function playerRangeFacts(
  env: Env, request: PlayerRangeRequest, snapshotId: string, coverage: readonly CoverageCell[],
): Promise<{ catalog: PlayerRangeCatalog; rows: PlayerRangeRow[]; labels: { person_id: string; label: string }[] }> {
  const seasons = request.seasons;
  const people = request.person_ids;
  const placeholders = people.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT i.person_id, p.web_name AS label
       FROM player_identities i JOIN players p ON p.player_id = i.player_id
      WHERE i.person_id IN (${placeholders})
      ORDER BY i.person_id, i.season DESC`,
  ).bind(...people).all<{ person_id: string; label: string }>();
  const labels = new Map<string, string>();
  for (const row of results ?? []) if (!labels.has(row.person_id)) labels.set(row.person_id, row.label);
  const catalog: PlayerRangeCatalog = { snapshot_id: snapshotId, person_ids: [...labels.keys()].sort(), seasons: [...seasons].sort() };
  const cells = request.seasons.flatMap((season) => [request.metric, "minutes"].map((metric) => {
    const cell = coverage.find((item) => item.metric === metric && item.entity_type === "player" &&
      item.granularity === "box_score" && item.competition === "PL" && item.season === season);
    return { season, metric, cell };
  }));
  const supported = cells.filter(({ cell }) => cell?.source_id === "fpl" && cell.redistributable && cell.cost_class === "cheap");
  const supportedSeasons = new Set(request.seasons.filter((season) => [request.metric, "minutes"].every((metric) => supported.some((cell) => cell.season === season && cell.metric === metric))));
  const seasonsForRead = [...supportedSeasons];
  const rows: PlayerRangeRow[] = [];
  if (labels.size && seasonsForRead.length) {
    const { results: facts } = await env.DB.prepare(
      `SELECT i.person_id, s.season, s.competition, s.goals, s.assists, s.minutes, s.snapshot_id
         FROM player_season_stats s JOIN player_identities i ON i.player_id = s.player_id
        WHERE i.person_id IN (${placeholders}) AND s.season IN (${seasonsForRead.map(() => "?").join(",")})
          AND s.competition = 'PL' AND s.snapshot_id = ?`,
    ).bind(...people, ...seasonsForRead, snapshotId).all<{ person_id: string; season: string; competition: "PL"; goals: number | null; assists: number | null; minutes: number | null; snapshot_id: string }>();
    const lineageFor = (season: string, metric: string) => {
      const cell = coverage.find((item) => item.metric === metric && item.entity_type === "player" && item.granularity === "box_score" && item.competition === "PL" && item.season === season)!;
      return `${cell.source_id}:${cell.attribution_asset ?? cell.source_name}`;
    };
    for (const row of facts ?? []) {
      if (!supportedSeasons.has(row.season)) continue;
      const metric = request.metric;
      rows.push({ person_id: row.person_id, season: row.season, competition: "PL",
        metric, definition: metric === "goals" ? "goals" : "fpl_assists", total: row[metric],
        minutes: row.minutes, snapshot_id: row.snapshot_id, lineage: [...new Set([lineageFor(row.season, metric), lineageFor(row.season, "minutes")])] });
    }
  }
  return { catalog, rows, labels: people.filter((id) => labels.has(id)).map((id) => ({ person_id: id, label: labels.get(id)! })) };
}

export async function playerRangeIdentityCatalog(env: Env, people: readonly string[], seasons: readonly string[], snapshotId: string): Promise<PlayerRangeCatalog> {
  void seasons;
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT i.person_id FROM player_identities i JOIN players p ON p.player_id = i.player_id
      WHERE i.person_id IN (${people.map(() => "?").join(",")})`,
  ).bind(...people).all<{ person_id: string }>();
  return { snapshot_id: snapshotId, person_ids: (results ?? []).map((row) => row.person_id), seasons: [...seasons] };
}

export async function savePlayerRangeHistory(env: Env, subject: string, replayPath: string, locale: "en" | "es"): Promise<void> {
  if (!validHumanSubject(subject) || !replayPath.startsWith(`/${locale}/players/compare?`) || replayPath.length > 2000) throw new Error("invalid_player_range_history");
  const inserted = env.DB.prepare(
    `INSERT INTO account_question_history (account_sub, question_text, visualization_path, locale, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(subject, locale === "es" ? "Comparación de jugadores" : "Player comparison", replayPath, locale, new Date().toISOString());
  const trimmed = env.DB.prepare(
    `DELETE FROM account_question_history WHERE account_sub = ? AND id NOT IN (
      SELECT id FROM account_question_history WHERE account_sub = ? ORDER BY id DESC LIMIT ${QUESTION_HISTORY_LIMIT})`,
  ).bind(subject, subject);
  await env.DB.batch([inserted, trimmed]);
}

export type SourceObservationStatus = "observed" | "unavailable";
export type SourceId = "fpl" | "football_data_couk" | "openfootball_cl";

export interface SourceObservation {
  id: SourceId;
  status: SourceObservationStatus;
  coverageThrough: string | null;
  retrievedAt: string | null;
  sourceAsOf: null;
}

export interface PublicationState {
  snapshotId: string;
  preparedAt: string;
  loadedAt: string;
  sources: readonly SourceObservation[];
}

type PublicationRow = {
  snapshot_id: unknown;
  prepared_at: unknown;
  loaded_at: unknown;
  source_status_json: unknown;
};

const SOURCE_IDS = ["fpl", "football_data_couk", "openfootball_cl"] as const;
const SOURCE_KEYS = ["coverage_through", "retrieved_at", "status"] as const;
const SNAPSHOT_RE = /^[a-f0-9]{64}$/;
const SEASON_RE = /^\d{4}-\d{2}$/;

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 10 || value.length > 40) return null;
  const candidate = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const millis = Date.parse(candidate);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

/** Strictly parses the latest completed seed-import record. Malformed or
 * missing metadata becomes null; raw D1/JSON errors never reach a response. */
export async function currentPublication(env: Env): Promise<PublicationState | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT snapshot_id, prepared_at, loaded_at, source_status_json
         FROM publication_runs ORDER BY run_id DESC LIMIT 1`,
    ).first<PublicationRow>();
    if (!row || typeof row.snapshot_id !== "string" || !SNAPSHOT_RE.test(row.snapshot_id)) {
      return null;
    }
    const preparedAt = isoTimestamp(row.prepared_at);
    const loadedAt = isoTimestamp(row.loaded_at);
    if (
      !preparedAt ||
      !loadedAt ||
      Date.parse(loadedAt) < Date.parse(preparedAt) ||
      typeof row.source_status_json !== "string" ||
      row.source_status_json.length > 10_000
    ) {
      return null;
    }
    const raw: unknown = JSON.parse(row.source_status_json);
    if (!plainRecord(raw) || !hasExactKeys(raw, SOURCE_IDS)) return null;

    const sources: SourceObservation[] = [];
    for (const id of SOURCE_IDS) {
      const value = raw[id];
      if (!plainRecord(value) || !hasExactKeys(value, SOURCE_KEYS)) return null;
      const status = value.status;
      if (status !== "observed" && status !== "unavailable") return null;
      const coverageThrough = value.coverage_through;
      const retrievedAt = value.retrieved_at === null ? null : isoTimestamp(value.retrieved_at);
      if (
        (status === "observed" &&
          (typeof coverageThrough !== "string" ||
            !SEASON_RE.test(coverageThrough) ||
            !retrievedAt)) ||
        (status === "unavailable" &&
          (coverageThrough !== null || value.retrieved_at !== null))
      ) {
        return null;
      }
      sources.push({
        id,
        status,
        coverageThrough: coverageThrough as string | null,
        retrievedAt,
        sourceAsOf: null,
      });
    }
    return { snapshotId: row.snapshot_id, preparedAt, loadedAt, sources };
  } catch {
    return null;
  }
}

/** `entity_id: "all"` means "rank every player"; anything else names one. */
export const ALL_PLAYERS = "all";

export async function runQuery(
  env: Env,
  intent: QueryIntent,
  knownSnapshot?: string | null,
): Promise<QueryResult> {
  const parsed = parseIntent(intent);
  if (!parsed.ok || validateExecutionSupport(parsed.intent)) throw new Error("unsupported_query");
  intent = parsed.intent;
  const column = METRIC_COLUMN[intent.metric];
  if (!column) {
    // Unreachable if feasibility ran first. Kept as a hard stop rather than a
    // fallback, because a silent default here would be a wrong answer.
    throw new Error(`no column mapping for metric '${intent.metric}'`);
  }

  const snapshot = knownSnapshot === undefined ? await currentSnapshot(env) : knownSnapshot;

  if (intent.entity_type === "season") {
    const stmt = env.DB.prepare(
      `SELECT season AS label, goals AS value,
              (won || 'W ' || drawn || 'D ' || lost || 'L') AS secondary
         FROM season_stats
        WHERE season = ? AND competition = ?`,
    ).bind(intent.season, intent.competition);
    const { results } = await stmt.all<ResultRow>();
    return { rows: results ?? [], snapshot_id: snapshot, unit: "goals" };
  }

  const limit = Math.min(Math.max(intent.limit, 1), 50);

  if (intent.entity_id === ALL_PLAYERS) {
    const stmt = env.DB.prepare(
      `SELECT p.web_name AS label, ${column} AS value, p.position AS secondary,
              i.person_id AS route_key
         FROM player_season_stats s
         JOIN players p ON p.player_id = s.player_id
         JOIN player_identities i ON i.player_id = p.player_id
        WHERE p.season = ? AND s.competition = ? AND ${column} IS NOT NULL
        ORDER BY value DESC, s.minutes DESC
        LIMIT ?`,
    ).bind(intent.season, intent.competition, limit);
    const { results } = await stmt.all<ResultRow>();
    return { rows: results ?? [], snapshot_id: snapshot, unit: intent.metric };
  }

  // Named player. Resolve aliases to one stable source identity first; broad
  // matches that identify more than one person fail closed.
  const identity = await resolvePlayerIdentity(env, intent.entity_id, intent.competition);
  if (!identity) return { rows: [], snapshot_id: snapshot, unit: intent.metric };

  const { results } = await env.DB.prepare(
    `SELECT p.web_name AS label, ${column} AS value, p.position AS secondary,
            i.person_id AS route_key
       FROM player_season_stats s
       JOIN players p ON p.player_id = s.player_id
       JOIN player_identities i ON i.player_id = p.player_id
      WHERE p.season = ? AND s.competition = ?
        AND i.person_id = ?
      LIMIT ?`,
  )
    .bind(intent.season, intent.competition, identity.person_id, limit)
    .all<ResultRow>();
  return { rows: results ?? [], snapshot_id: snapshot, unit: intent.metric };
}

export interface SeasonRow {
  season: string;
  goals: number | null;
  assists: number | null;
  minutes: number | null;
  points: number | null;
  xg: number | null;
  position: string;
}

export interface PlayerIdentity {
  person_id: string;
  web_name: string; // most recent, for display
}

const PERSON_ID_SHAPE = /^[a-z][a-z0-9_]*:[a-z0-9_]+:[a-z0-9_-]+$/;

interface IdentityCandidate extends PlayerIdentity {
  exact_match: number;
}

const D1_LIKE_PATTERN_MAX_BYTES = 50;

/**
 * Resolve a source-namespaced person id or loose historical alias to one
 * stable identity. Exact aliases win only when they identify one person;
 * ambiguous exact or substring matches fail closed rather than guessing.
 *
 * Two real problems this works around, found by testing against actual data
 * rather than assumed:
 *   - `second_name` can carry more than a surname. Bruno Fernandes is stored
 *     as second_name "Borges Fernandes" -- an exact match on "fernandes"
 *     finds nothing.
 *   - `web_name` is NOT stable across seasons for the same person: "Fernandes"
 *     one year, "B.Fernandes" the next (FPL disambiguates on the fly). An
 *     exact match on one season's web_name misses others.
 *
 * Names remain display/search aliases only. Careers join through the stable
 * source identity populated by the ingest pipeline.
 */
export async function resolvePlayerIdentity(
  env: Env,
  needle: string,
  competition = "PL",
): Promise<PlayerIdentity | null> {
  // SQLite LIKE truncates at NUL, which can turn a literal alias into a wildcard.
  if (needle.includes("\0")) return null;
  const n = needle.toLowerCase().replaceAll(".", "").trim();
  if (n.length < 3) return null; // avoid pathological short-substring collisions

  // Source-namespaced person id (e.g. fpl:code:141746): exact indexed lookup
  // on player_identities.person_id, no substring scan.
  if (PERSON_ID_SHAPE.test(n)) {
    const { results } = await env.DB.prepare(
      `SELECT i.person_id, p.web_name
         FROM player_identities i
         JOIN players p ON p.player_id = i.player_id
        WHERE i.person_id = ?
          AND EXISTS (
            SELECT 1 FROM player_season_stats s
             WHERE s.player_id = p.player_id AND s.competition = ?
          )
        ORDER BY p.season DESC
        LIMIT 1`,
    )
      .bind(n, competition)
      .all<PlayerIdentity>();
    const row = (results ?? [])[0];
    return row ? { person_id: row.person_id, web_name: row.web_name } : null;
  }

  // Keep user punctuation literal in LIKE; exact comparisons still use n.
  const aliasPattern = n.replace(/[!%_]/g, "!$&");
  // D1 caps a LIKE pattern at 50 bytes (developers.cloudflare.com/d1/platform/limits);
  // longer ones throw "LIKE or GLOB pattern too complex". Count the bound
  // pattern, escapes and both % wildcards included, and treat overflow as not found.
  if (new TextEncoder().encode(aliasPattern).length + 2 > D1_LIKE_PATTERN_MAX_BYTES) return null;
  const { results } = await env.DB.prepare(
    `SELECT i.person_id, p.web_name,
            CASE WHEN i.person_id = ?
                   OR LOWER(replace(p.web_name, '.', '')) = ?
                   OR LOWER(p.second_name) = ?
                   OR LOWER(p.first_name || ' ' || p.second_name) = ?
                 THEN 1 ELSE 0 END AS exact_match
       FROM players p
       JOIN player_identities i ON i.player_id = p.player_id
       JOIN player_season_stats s ON s.player_id = p.player_id
      WHERE s.competition = ?
        AND (
          i.person_id = ?
          OR LOWER(replace(p.web_name, '.', '')) LIKE '%' || ? || '%' ESCAPE '!'
          OR LOWER(p.second_name) LIKE '%' || ? || '%' ESCAPE '!'
          OR LOWER(p.first_name || ' ' || p.second_name) LIKE '%' || ? || '%' ESCAPE '!'
        )
      ORDER BY p.season DESC`,
  )
    .bind(n, n, n, n, competition, n, aliasPattern, aliasPattern, aliasPattern)
    .all<IdentityCandidate>();

  const rows = results ?? [];
  const distinct = (candidates: IdentityCandidate[]) => {
    const identities = new Map<string, PlayerIdentity>();
    for (const candidate of candidates) {
      if (!identities.has(candidate.person_id)) {
        identities.set(candidate.person_id, {
          person_id: candidate.person_id,
          web_name: candidate.web_name,
        });
      }
    }
    return [...identities.values()];
  };
  const loose = distinct(rows);
  const exactIds = new Set(
    rows.filter((row) => Number(row.exact_match) === 1).map((row) => row.person_id),
  );
  if (exactIds.size > 0) {
    if (exactIds.size !== 1) return null;
    const [personId] = exactIds;
    return loose.find((identity) => identity.person_id === personId) ?? null;
  }
  return loose.length === 1 ? loose[0]! : null;
}

/** One stable identity, every season it appears under. */
export async function playerCareerRows(
  env: Env,
  needle: string,
  competition = "PL",
): Promise<SeasonRow[]> {
  const identity = await resolvePlayerIdentity(env, needle, competition);
  if (!identity) return [];

  const { results } = await env.DB.prepare(
    `SELECT p.season AS season, s.goals, s.assists, s.minutes, s.points, s.xg,
            p.position AS position
       FROM player_season_stats s
       JOIN players p ON p.player_id = s.player_id
       JOIN player_identities i ON i.player_id = p.player_id
      WHERE s.competition = ? AND i.person_id = ?
      ORDER BY p.season`,
  )
    .bind(competition, identity.person_id)
    .all<SeasonRow>();
  return results ?? [];
}

/** Resolved display name (most recent web_name) for a matched player. */
export async function resolvePlayerName(
  env: Env,
  needle: string,
  competition = "PL",
): Promise<string | null> {
  const identity = await resolvePlayerIdentity(env, needle, competition);
  return identity?.web_name ?? null;
}

export interface SquadRow {
  label: string;
  route_key: string;
  secondary: string; // position
  goals: number;
  assists: number;
  minutes: number;
  points: number;
  xg: number | null;
}

export async function seasonSquadRows(
  env: Env,
  season: string,
  competition = "PL",
): Promise<SquadRow[]> {
  const stmt = env.DB.prepare(
    `SELECT p.web_name AS label, i.person_id AS route_key, p.position AS secondary,
            s.goals, s.assists, s.minutes, s.points, s.xg
       FROM player_season_stats s
       JOIN players p ON p.player_id = s.player_id
       JOIN player_identities i ON i.player_id = p.player_id
      WHERE p.season = ? AND s.competition = ?
      ORDER BY s.minutes DESC`,
  ).bind(season, competition);
  const { results } = await stmt.all<SquadRow>();
  return results ?? [];
}

export interface SeasonRecord {
  season: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goals: number;
  goals_against: number;
}

export interface SeasonHistoryRecord extends SeasonRecord {
  snapshot_id: string;
}

export async function seasonHistoryRows(
  env: Env,
  seasons: readonly string[],
  competition = "PL",
): Promise<SeasonHistoryRecord[]> {
  if (seasons.length === 0) return [];
  const placeholders = seasons.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    `SELECT season, played, won, drawn, lost, goals, goals_against, snapshot_id
       FROM season_stats
      WHERE competition = ? AND season IN (${placeholders})
      ORDER BY season DESC`,
  ).bind(competition, ...seasons).all<SeasonHistoryRecord>();
  return results ?? [];
}

export async function seasonRecordRow(
  env: Env,
  season: string,
  competition = "PL",
): Promise<SeasonRecord | null> {
  return env.DB.prepare(
    `SELECT season, played, won, drawn, lost, goals, goals_against
       FROM season_stats WHERE season = ? AND competition = ?`,
  )
    .bind(season, competition)
    .first<SeasonRecord>();
}

/**
 * Every player name we hold, for the Ask gate's subject check ("Rashford
 * goals" names no club but is unambiguously about us).
 *
 * Cached for the life of the isolate rather than given a TTL: D1 content only
 * changes when a migration runs during a fresh deploy, and a deploy replaces
 * the isolate. The same reasoning already justifies CACHE_CONTROL in index.ts.
 *
 * Failure is non-fatal by design. The gate degrades to requiring a club,
 * season or competition mention -- stricter, still correct -- rather than
 * taking the Ask route down because a name-list read failed.
 */
let playerNameCache: string[] | null = null;

export async function allPlayerNames(env: Env): Promise<string[]> {
  if (playerNameCache) return playerNameCache;
  try {
    // Both columns: `web_name` is the display form and is often already the
    // surname, but not always ("B.Fernandes"), and people type the surname.
    // `second_name` covers that without a second round trip.
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT web_name AS n FROM players
       UNION SELECT DISTINCT second_name AS n FROM players`,
    ).all<{ n: string }>();
    playerNameCache = (results ?? []).map((r) => r.n).filter((n) => n && n.length >= 4);
    return playerNameCache;
  } catch {
    return [];
  }
}
