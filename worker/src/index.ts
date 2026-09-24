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
  enforceBudget,
  logDemand,
  playerCareerRows,
  resolvePlayerIdentity,
  runQuery,
  seasonHistoryRows,
  seasonRecordRow,
  seasonSquadRows,
  type Env,
  type PublicationState,
} from "./core/db";
import { Catalog, columnFeasibility, hasSubstance, type CompiledCatalog } from "./core/feasibility";
import { artifactKey } from "./core/intent";
import { parseIntent, validateExecutionSupport, validateQuerySemantics } from "./core/validate-intent";
import { LOCALES, type Locale, type LocaleCode } from "./core/locale";
import {
  hasAmbiguousPlayerReference,
  parseRuleBased,
  proposeWithAI,
  type Proposal,
} from "./core/parser";
import { executeComparison, parseComparison } from "./core/comparison";
import { buildSeasonComparison, eligibleLeagueSeasons } from "./core/season-comparison";
import { withSecurityHeaders } from "./security/headers";
import { accessGate } from "./security/auth";
import { gateQuestion, type GateRejected } from "./security/askguard";
import { esc, html, page } from "./views/layout";
import { comparisonPage } from "./views/comparison";
import {
  chatForm,
  homeBody,
  intentPanel,
  playerPageBody,
  rejectionPanel,
  resultPanel,
  seasonPageBody,
  type FreshnessView,
} from "./views/pages";

/** Pin site P14. Bump deliberately -- a different model parses differently. */
const AI_MODEL = "@cf/meta/llama-3.2-1b-instruct";

const catalog = new Catalog(compiledCatalog as unknown as CompiledCatalog);
const app = new Hono<{ Bindings: Env }>();

/** Private responses never enter browser/shared caches, even on error. */
const CACHE_CONTROL = "private, no-store";

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

  // Logged before the branch, so refusals are recorded too -- infeasible
  // requests are the most valuable demand signal we have.
  await logDemand(c.env, key, intent, feasibility.state).catch(() => {});

  if (
    feasibility.state !== "available" &&
    feasibility.state !== "computable_now_queued"
  ) {
    return c.json({ artifact_key: key, intent, feasibility, rows: [] }, 200);
  }
  const executionIssue = validateExecutionSupport(intent);
  if (executionIssue) return c.json({ error: executionIssue }, 422);

  // Budget breaker (docs/roadmap.md M3): checked only here, right before the
  // actual compute, not earlier -- a refusal above never touches the budget.
  if (!(await enforceBudget(c.env))) {
    return c.json(
      { error: "budget_exceeded", message: "Daily compute budget spent. Try again after midnight UTC." },
      429,
    );
  }

  const result = await runQuery(c.env, intent);
  return c.json({
    artifact_key: key,
    intent,
    feasibility,
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

  app.get(`${p}/compare`, async (c) => {
    const seasons = catalog.seasonsFor("goals", "player", "box_score");
    const request = parseComparison(
      new URL(c.req.url).searchParams,
      seasons[0] ?? "2025-26",
    );
    if (!request) {
      return c.text(
        locale.code === "es" ? "Parámetros de comparación no válidos." : "Invalid comparison parameters.",
        400,
      );
    }
    return comparisonPage(
      request,
      await executeComparison(c.env, catalog, request, locale.code),
      seasons,
      locale,
    );
  });

  app.get(p, async (c) => {
    const [snapshot, publication] = await Promise.all([
      currentSnapshot(c.env).catch(() => null),
      currentPublication(c.env),
    ]);
    // Always indexable -- the coverage matrix hub, never a thin permutation.
    const res = html(
      page(homeBody(catalog, locale, freshnessView(snapshot, publication)), {
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
    );
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
    const body = seasonPageBody(season, squad, record, catalog, locale, europeanRecord, comparison);
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
}

registerLocaleRoutes("en");
registerLocaleRoutes("es");

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
  const quotedIdentity = /"([^"]+)"|'([^']+)'/.exec(question);
  const preservesDeterministicFields =
    ai.proposal.intent.metric === rules.intent.metric
    && ai.proposal.intent.season === rules.intent.season
    && ai.proposal.intent.competition === rules.intent.competition
    && ai.proposal.intent.viz === rules.intent.viz
    && (!quotedIdentity || ai.proposal.intent.entity_id === rules.intent.entity_id);
  return catalog.metric(ai.proposal.intent.metric) && preservesDeterministicFields
    ? ai.proposal
    : {
        ...rules,
        model_status: "unsupported_intent",
        notes: [...rules.notes, "AI proposal unavailable (unsupported_intent); using rules."],
      };
}

async function renderChat(
  c: { env: Env },
  locale: Locale,
  proposal: Proposal,
  question: string | null,
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

  await logDemand(c.env, key, proposal.intent, feasibility.state).catch(() => {});

  const feasible =
    feasibility.state === "available" ||
    feasibility.state === "computable_now_queued";
  const executionIssue = feasible ? validateExecutionSupport(proposal.intent) : null;
  if (executionIssue) return html(`Unsupported query field: ${executionIssue.field}.`, 422);

  // Budget breaker (docs/roadmap.md M3): checked only when a query would
  // actually run, same scope as the JSON API's check above.
  const overBudget = feasible && !(await enforceBudget(c.env));
  const rows = feasible && !overBudget ? (await runQuery(c.env, proposal.intent)).rows : [];

  const resultBlock = overBudget
    ? `<div class="stop">
<p class="state">budget_exceeded</p>
<p><strong>${esc(locale.strings.budgetExceeded)}</strong></p>
</div>`
    : resultPanel(proposal.intent, feasibility, rows, catalog, key, locale);

  const body = `<h1>iammufc</h1>
<div class="card">${chatForm(locale, question ?? "")}</div>
${intentPanel(proposal, locale)}
${resultBlock}
<p><a href="/${locale.code}">${locale.strings.backToMatrix}</a></p>`;

  const res = html(
    page(body, {
      title: `${proposal.intent.metric} ${proposal.intent.season}`,
      locale,
      unprefixedPath,
      attribution: [feasibility.attribution_text],
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
