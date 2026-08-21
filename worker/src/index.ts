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
  currentSnapshot,
  logDemand,
  playerCareerRows,
  resolvePlayerName,
  runQuery,
  seasonRecordRow,
  seasonSquadRows,
  type Env,
} from "./core/db";
import { Catalog, type CompiledCatalog } from "./core/feasibility";
import { artifactKey, withDefaults, type QueryIntent, type VizType } from "./core/intent";
import { LOCALES, type Locale, type LocaleCode } from "./core/locale";
import { parseRuleBased, proposeWithAI, type Proposal } from "./core/parser";
import { withSecurityHeaders } from "./security/headers";
import { html, page } from "./views/layout";
import {
  chatForm,
  homeBody,
  intentPanel,
  playerPageBody,
  resultPanel,
  seasonPageBody,
} from "./views/pages";

/** Pin site P14. Bump deliberately -- a different model parses differently. */
const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";

const catalog = new Catalog(compiledCatalog as unknown as CompiledCatalog);
const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  await next();
  c.res = withSecurityHeaders(c.res);
});

// ---------------------------------------------------------------------------
// JSON API -- locale-neutral, returns data not prose
// ---------------------------------------------------------------------------

/** Proposes. Never executes. The response has no data in it by construction. */
app.post("/api/chat", async (c) => {
  const body = await c.req.json<{ question?: string }>().catch(() => ({}) as { question?: string });
  const question = (body.question ?? "").trim();
  if (!question) return c.json({ error: "question is required" }, 400);

  const proposal = await propose(question, c.env);
  const feasibility = catalog.checkFeasibility(proposal.intent);

  return c.json({
    proposed_intent: proposal.intent,
    source: proposal.source,
    confidence: proposal.confidence,
    notes: proposal.notes,
    feasibility,
    next: "POST the proposed_intent to /api/query to execute it.",
  });
});

/** Executes a validated intent. Rejects anything the catalog does not permit. */
app.post("/api/query", async (c) => {
  const raw = await c.req.json<Partial<QueryIntent>>().catch(() => null);
  if (!raw || typeof raw.metric !== "string" || typeof raw.season !== "string") {
    return c.json({ error: "metric and season are required" }, 400);
  }

  const intent = withDefaults(raw);
  const snapshot = await currentSnapshot(c.env);
  const key = await artifactKey(intent, snapshot ?? "no-snapshot");
  const feasibility = catalog.checkFeasibility(intent);

  // Logged before the branch, so refusals are recorded too -- infeasible
  // requests are the most valuable demand signal we have.
  await logDemand(c.env, key, intent, feasibility.state).catch(() => {});

  if (
    feasibility.state === "not_computable_data_missing" ||
    feasibility.state === "not_computable_no_rights"
  ) {
    return c.json({ artifact_key: key, intent, feasibility, rows: [] }, 200);
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

app.get("/api/catalog", (c) =>
  c.json({
    metrics: catalog.metrics,
    coverage: catalog.coverage.map((cell) => ({
      metric: cell.metric,
      season: cell.season,
      granularity: cell.granularity,
      redistributable: cell.redistributable,
      source: cell.source_name,
    })),
  }),
);

app.get("/api/health", async (c) => {
  const snapshot = await currentSnapshot(c.env).catch(() => null);
  return c.json({
    ok: snapshot !== null,
    snapshot_id: snapshot,
    metrics: catalog.metrics.length,
    coverage_cells: catalog.coverage.length,
    ai_bound: Boolean(c.env.AI),
  });
});

// ---------------------------------------------------------------------------
// HTML -- registered once per locale, below
// ---------------------------------------------------------------------------

function registerLocaleRoutes(code: LocaleCode) {
  const locale = LOCALES[code];
  const p = `/${code}`;

  app.get(p, () =>
    html(
      page(homeBody(catalog, locale), {
        title: code === "es" ? "Estadísticas del Manchester United" : "Manchester United statistics",
        locale,
        unprefixedPath: "/",
      }),
    ),
  );

  app.post(`${p}/ask`, async (c) => {
    const form = await c.req.formData();
    const question = String(form.get("q") ?? "").trim();
    if (!question) return c.redirect(p, 303);
    return renderChat(c, locale, await propose(question, c.env), question);
  });

  /** Direct intent entry -- the "show this instead" path from a refusal. */
  app.get(`${p}/q`, async (c) => {
    const q = c.req.query();
    const intent = withDefaults({
      metric: q.metric ?? "goals",
      entity_type: "player",
      entity_id: q.entity_id ?? "all",
      season: q.season ?? "2024-25",
      viz: (q.viz as VizType) ?? "bar",
    });
    // Unlike /ask, this route is GET, so the language toggle CAN replay it --
    // reconstruct the query string so switching locale lands on the same
    // result, not just the home page.
    const qs = new URL(c.req.url).search;
    return renderChat(
      c,
      locale,
      { intent, confidence: "high", notes: [], source: "rules" },
      null,
      `/q${qs}`,
    );
  });

  app.get(`${p}/player/:name/:season?`, async (c) => {
    const nameParam = decodeURIComponent(c.req.param("name"));
    const seasonParam = c.req.param("season");

    const displayName = (await resolvePlayerName(c.env, nameParam)) ?? nameParam;
    const career = await playerCareerRows(c.env, nameParam);
    const season = seasonParam ?? career[career.length - 1]?.season ?? "2024-25";

    const body = playerPageBody(displayName, season, career, catalog, locale);
    return html(
      page(body, {
        title: `${displayName}`,
        locale,
        unprefixedPath: `/player/${encodeURIComponent(nameParam)}/${season}`,
        snapshotId: await currentSnapshot(c.env),
      }),
    );
  });

  app.get(`${p}/season/:season`, async (c) => {
    const season = c.req.param("season");
    const [squad, record] = await Promise.all([
      seasonSquadRows(c.env, season),
      seasonRecordRow(c.env, season),
    ]);
    const body = seasonPageBody(season, squad, record, catalog, locale);
    return html(
      page(body, {
        title: `${season}`,
        locale,
        unprefixedPath: `/season/${season}`,
        snapshotId: await currentSnapshot(c.env),
      }),
    );
  });
}

registerLocaleRoutes("en");
registerLocaleRoutes("es");

// Bare paths redirect to /en/ rather than serving duplicate content at a
// second URL. 301 (not 302): this is a permanent structural decision, not a
// temporary redirect -- search engines should consolidate ranking signal onto
// the canonical /en/ URL rather than treating the two as separate pages.
app.get("/", (c) => c.redirect("/en", 301));
app.get("/q", (c) => c.redirect(`/en/q?${new URL(c.req.url).searchParams.toString()}`, 301));
app.get("/player/:name/:season?", (c) => c.redirect(`/en${new URL(c.req.url).pathname}`, 301));
app.get("/season/:season", (c) => c.redirect(`/en${new URL(c.req.url).pathname}`, 301));

app.notFound((c) => {
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

async function propose(question: string, env: Env): Promise<Proposal> {
  // Rule-based always runs: it is the floor, and it makes the site fully usable
  // with no account, no network call, and no inference cost.
  const rules = parseRuleBased(question, catalog);
  if (!env.AI) return rules;

  const ai = await proposeWithAI(question, catalog, env.AI, AI_MODEL);
  if (!ai) return rules;

  // Whatever the model returned is still only a proposal, and the catalog is
  // what decides whether it means anything.
  return catalog.metric(ai.intent.metric) ? ai : rules;
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
  const snapshot = await currentSnapshot(c.env);
  const key = await artifactKey(proposal.intent, snapshot ?? "no-snapshot");
  const feasibility = catalog.checkFeasibility(proposal.intent, locale.code);

  await logDemand(c.env, key, proposal.intent, feasibility.state).catch(() => {});

  const feasible =
    feasibility.state !== "not_computable_data_missing" &&
    feasibility.state !== "not_computable_no_rights";
  const rows = feasible ? (await runQuery(c.env, proposal.intent)).rows : [];

  const body = `<h1>iammufc</h1>
<div class="card">${chatForm(locale, question ?? "")}</div>
${intentPanel(proposal, locale)}
${resultPanel(proposal.intent, feasibility, rows, catalog, key, locale)}
<p><a href="/${locale.code}">${locale.strings.backToMatrix}</a></p>`;

  return html(
    page(body, {
      title: `${proposal.intent.metric} ${proposal.intent.season}`,
      locale,
      unprefixedPath,
      attribution: [feasibility.attribution_text],
      snapshotId: snapshot,
    }),
  );
}

export default app;
