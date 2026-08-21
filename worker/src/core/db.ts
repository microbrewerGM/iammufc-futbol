/**
 * Deterministic execution over D1.
 *
 * Every query here is parameterised and hand-written. No SQL is ever generated
 * from natural language, and no SQL string is ever assembled from user input --
 * the metric name selects a column from a fixed allowlist, it never becomes one.
 */

import type { QueryIntent } from "./intent";

export interface Env {
  DB: D1Database;
  CFG: KVNamespace;
  AI?: { run: (model: string, input: unknown) => Promise<unknown> };
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
}

export interface QueryResult {
  rows: ResultRow[];
  snapshot_id: string | null;
  unit: string;
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
 * Fails open on any storage error. A broken breaker must never become a
 * site-wide outage over a KV/D1 hiccup -- the free-tier ceilings above
 * already leave wide margin before a real cost overrun.
 */
export async function enforceBudget(env: Env): Promise<boolean> {
  const day = utcDay();

  try {
    const kvKey = `budget:${day}`;
    const raw = await env.CFG.get(kvKey);
    const kvCount = raw ? Number(raw) : 0;
    if (Number.isFinite(kvCount) && kvCount >= BUDGET_FAST_LIMIT) return false;
    // Best-effort increment. KV's eventual consistency means this can race --
    // deliberately not the enforcement point, see the D1 check below.
    await env.CFG.put(kvKey, String(kvCount + 1), { expirationTtl: 172800 }); // 2 days, covers UTC-boundary clock skew
  } catch {
    // KV unavailable: fall through to D1, which is the real gate anyway.
  }

  try {
    await env.DB.prepare(
      `INSERT INTO budget_counter (day, count) VALUES (?, 1)
         ON CONFLICT(day) DO UPDATE SET count = count + 1`,
    )
      .bind(day)
      .run();
    const row = await env.DB.prepare("SELECT count FROM budget_counter WHERE day = ?")
      .bind(day)
      .first<{ count: number }>();
    return (row?.count ?? 0) <= BUDGET_HARD_LIMIT;
  } catch {
    return true; // D1 unavailable: a storage outage should not also take down every query on the site.
  }
}

export async function currentSnapshot(env: Env): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT snapshot_id FROM snapshots ORDER BY created_at DESC LIMIT 1",
  ).first<{ snapshot_id: string }>();
  return row?.snapshot_id ?? null;
}

/** `entity_id: "all"` means "rank every player"; anything else names one. */
export const ALL_PLAYERS = "all";

export async function runQuery(env: Env, intent: QueryIntent): Promise<QueryResult> {
  const column = METRIC_COLUMN[intent.metric];
  if (!column) {
    // Unreachable if feasibility ran first. Kept as a hard stop rather than a
    // fallback, because a silent default here would be a wrong answer.
    throw new Error(`no column mapping for metric '${intent.metric}'`);
  }

  const snapshot = await currentSnapshot(env);

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
      `SELECT p.web_name AS label, ${column} AS value, p.position AS secondary
         FROM player_season_stats s
         JOIN players p ON p.player_id = s.player_id
        WHERE p.season = ? AND s.competition = ? AND ${column} IS NOT NULL
        ORDER BY value DESC, s.minutes DESC
        LIMIT ?`,
    ).bind(intent.season, intent.competition, limit);
    const { results } = await stmt.all<ResultRow>();
    return { rows: results ?? [], snapshot_id: snapshot, unit: intent.metric };
  }

  // Named player. Loose match to an exact identity first (see resolveIdentity
  // for why: web_name changes format across seasons -- "Fernandes" one year,
  // "B.Fernandes" the next -- and second_name can carry more than a surname),
  // then an exact join so a broad substring can never merge two people.
  const identity = await resolveIdentity(env, intent.entity_id, intent.competition);
  if (!identity) return { rows: [], snapshot_id: snapshot, unit: intent.metric };

  const { results } = await env.DB.prepare(
    `SELECT p.web_name AS label, ${column} AS value, p.position AS secondary
       FROM player_season_stats s
       JOIN players p ON p.player_id = s.player_id
      WHERE p.season = ? AND s.competition = ?
        AND p.first_name = ? AND p.second_name = ?
      LIMIT ?`,
  )
    .bind(intent.season, intent.competition, identity.first_name, identity.second_name, limit)
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

interface Identity {
  first_name: string;
  second_name: string;
  web_name: string; // most recent, for display
}

/**
 * Resolve a loose name typed by a user to ONE exact (first_name, second_name)
 * identity, or null.
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
 * The fix is two queries, not one broad LIKE: first find loose matches (LIKE,
 * which can over-match), then collapse to the single most-recent identity and
 * use ITS exact (first_name, second_name) for the real query. This is what
 * stops two different people who happen to share a substring from being
 * merged onto one page -- a correctness bug worse than a missed match.
 */
async function resolveIdentity(env: Env, needle: string, competition: string): Promise<Identity | null> {
  const n = needle.toLowerCase().trim();
  if (n.length < 3) return null; // avoid pathological short-substring collisions

  const row = await env.DB.prepare(
    `SELECT p.first_name, p.second_name, p.web_name
       FROM players p
       JOIN player_season_stats s ON s.player_id = p.player_id
      WHERE s.competition = ?
        AND (
          LOWER(replace(p.web_name, '.', '')) LIKE '%' || ? || '%'
          OR LOWER(p.second_name) LIKE '%' || ? || '%'
          OR LOWER(p.first_name || ' ' || p.second_name) LIKE '%' || ? || '%'
        )
      ORDER BY p.season DESC
      LIMIT 1`,
  )
    .bind(competition, n, n, n)
    .first<Identity>();

  return row ?? null;
}

/** One identity, every season it appears under. Exact join on
 *  (first_name, second_name) -- the loose matching already happened in
 *  resolveIdentity, so this cannot mix two different people. */
export async function playerCareerRows(
  env: Env,
  needle: string,
  competition = "PL",
): Promise<SeasonRow[]> {
  const identity = await resolveIdentity(env, needle, competition);
  if (!identity) return [];

  const { results } = await env.DB.prepare(
    `SELECT p.season AS season, s.goals, s.assists, s.minutes, s.points, s.xg,
            p.position AS position
       FROM player_season_stats s
       JOIN players p ON p.player_id = s.player_id
      WHERE s.competition = ? AND p.first_name = ? AND p.second_name = ?
      ORDER BY p.season`,
  )
    .bind(competition, identity.first_name, identity.second_name)
    .all<SeasonRow>();
  return results ?? [];
}

/** Resolved display name (most recent web_name) for a matched player. */
export async function resolvePlayerName(
  env: Env,
  needle: string,
  competition = "PL",
): Promise<string | null> {
  const identity = await resolveIdentity(env, needle, competition);
  return identity?.web_name ?? null;
}

export interface SquadRow {
  label: string;
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
    `SELECT p.web_name AS label, p.position AS secondary,
            s.goals, s.assists, s.minutes, s.points, s.xg
       FROM player_season_stats s
       JOIN players p ON p.player_id = s.player_id
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

/** Demand signal. Infeasible requests are the most valuable rows in this table
 *  -- they say what to integrate next. Intent hash only: no PII, no accounts. */
export async function logDemand(
  env: Env,
  intentHash: string,
  intent: QueryIntent,
  state: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO demand_log (intent_hash, metric, season, viz, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(intentHash, intent.metric, intent.season, intent.viz, state, new Date().toISOString())
    .run();
}
