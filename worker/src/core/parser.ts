/**
 * Natural language -> PROPOSED QueryIntent.
 *
 * This module can never execute anything. Its only output is a proposal the
 * user sees and confirms. That boundary is the whole design: the LLM sits
 * beside the executor, never in front of it.
 *
 * Two backends, same output contract:
 *   1. `parseRuleBased` -- deterministic, offline, zero cost. Always runs.
 *   2. `proposeWithAI`  -- Workers AI, used when the binding exists, and always
 *      validated against the catalog afterwards.
 *
 * The rule-based path is not a stopgap. It is the structured-builder logic that
 * M3 needs anyway, and it means the site is fully usable with no account, no
 * network call, and no inference cost.
 */

import type { Catalog } from "./feasibility";
import { withDefaults, type QueryIntent, type VizType } from "./intent";
import { ALL_PLAYERS } from "./db";

export interface Proposal {
  intent: QueryIntent;
  confidence: "high" | "low";
  /** Shown to the user so the parse is visible and correctable, never implicit. */
  notes: string[];
  source: "rules" | "ai";
}

const METRIC_SYNONYMS: Record<string, string[]> = {
  goals: ["goal", "goals", "scorer", "scorers", "scoring", "scored", "goles"],
  assists: ["assist", "assists", "assisted", "asistencias"],
  minutes: ["minute", "minutes", "mins", "playing time", "minutos"],
  points: ["point", "points", "fantasy", "fpl", "puntos"],
  xg: ["xg", "expected goals", "expected goal", "goles esperados"],
  progressive_passes: ["progressive pass", "progressive passes", "pases progresivos"],
};

const VIZ_SYNONYMS: Array<[VizType, string[]]> = [
  ["shot_map", ["shot map", "shotmap", "shot chart", "mapa de tiros"]],
  ["pass_map", ["pass map", "passmap", "mapa de pases"]],
  ["heatmap", ["heat map", "heatmap", "mapa de calor"]],
  ["line", ["over time", "trend", "line chart"]],
  ["table", ["table", "list", "tabla"]],
  ["bar", ["bar chart", "chart", "graph"]],
];

/** "2024-25", "2024/25", "24-25", "2024" all mean the same season to a human. */
function parseSeason(text: string, known: string[]): { season: string | null; note?: string } {
  const explicit = text.match(/\b(20\d{2})\s*[-/]\s*(\d{2})\b/);
  if (explicit) {
    const candidate = `${explicit[1]}-${explicit[2]}`;
    if (known.includes(candidate)) return { season: candidate };
    return { season: candidate, note: `Season ${candidate} is outside our coverage.` };
  }

  const short = text.match(/\b(\d{2})\s*[-/]\s*(\d{2})\b/);
  if (short) {
    const candidate = `20${short[1]}-${short[2]}`;
    if (known.includes(candidate)) return { season: candidate };
    return { season: candidate, note: `Season ${candidate} is outside our coverage.` };
  }

  // A bare year: "2024" almost always means the season starting that year.
  const year = text.match(/\b(20\d{2})\b/);
  if (year) {
    const start = Number(year[1]);
    const candidate = `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
    return { season: candidate, note: `Read "${year[1]}" as the ${candidate} season.` };
  }

  return { season: null };
}

function detectMetric(text: string): string | null {
  // Longest synonym first, so "expected goals" is not swallowed by "goals".
  const ranked = Object.entries(METRIC_SYNONYMS)
    .flatMap(([metric, words]) => words.map((w) => ({ metric, w })))
    .sort((a, b) => b.w.length - a.w.length);
  for (const { metric, w } of ranked) if (text.includes(w)) return metric;
  return null;
}

function detectViz(text: string): VizType | null {
  for (const [viz, words] of VIZ_SYNONYMS) {
    for (const w of words) if (text.includes(w)) return viz;
  }
  return null;
}

const RANKING_HINTS = [
  "top",
  "most",
  "best",
  "leading",
  "highest",
  "who scored",
  "ranking",
  // Spanish -- METRIC_SYNONYMS and VIZ_SYNONYMS already carry es entries;
  // this was the gap that made the ES chat tree fall back to defaults on
  // every ranking question ("¿quién anotó más...?") instead of detecting one.
  "más",
  "mejor",
  "líder",
  "quién anotó",
  "clasificación",
];

export function parseRuleBased(question: string, catalog: Catalog): Proposal {
  const text = question.toLowerCase().trim();
  const notes: string[] = [];

  const metric = detectMetric(text);
  const allSeasons = [...new Set(catalog.coverage.map((c) => c.season))].sort().reverse();
  const { season, note } = parseSeason(text, allSeasons);
  if (note) notes.push(note);

  const asksForRanking = RANKING_HINTS.some((h) => text.includes(h));

  // Any quoted string, or a capitalised run in the original casing, is treated
  // as a player name. Deliberately conservative -- guessing a name wrong is
  // worse than asking.
  const quoted = question.match(/"([^"]+)"|'([^']+)'/);
  const named = quoted?.[1] ?? quoted?.[2] ?? null;

  const viz = detectViz(text);

  if (!metric) {
    notes.push("Could not identify a metric. Defaulted to goals.");
  }
  if (!season) {
    notes.push(`No season given. Defaulted to ${allSeasons[0]}.`);
  }

  const intent = withDefaults({
    metric: metric ?? "goals",
    entity_type: "player",
    entity_id: named ?? (asksForRanking || !named ? ALL_PLAYERS : named),
    season: season ?? allSeasons[0]!,
    competition: "PL",
    viz: viz ?? "bar",
    limit: 10,
  });

  return {
    intent,
    confidence: metric && season ? "high" : "low",
    notes,
    source: "rules",
  };
}

/** The prompt constrains the model to the catalog's actual vocabulary. It still
 *  does not matter if the model ignores it -- validation, not the prompt, is
 *  what stops an invented metric reaching the executor. */
function buildPrompt(question: string, catalog: Catalog): string {
  const metrics = catalog.metrics.map((m) => m.metric_id).join(", ");
  const seasons = [...new Set(catalog.coverage.map((c) => c.season))].sort().join(", ");
  return [
    "Extract a structured query from a football question about Manchester United.",
    "Respond with ONE JSON object and nothing else.",
    `Valid metric values: ${metrics}`,
    `Valid season values: ${seasons}`,
    'Valid viz values: table, bar, line, shot_map, pass_map, heatmap',
    'Use entity_id "all" to rank every player; otherwise give the player name.',
    'Shape: {"metric":"...","entity_type":"player","entity_id":"...","season":"YYYY-YY","viz":"..."}',
    "",
    `Question: ${question}`,
  ].join("\n");
}

export async function proposeWithAI(
  question: string,
  catalog: Catalog,
  ai: NonNullable<import("./db").Env["AI"]>,
  model: string,
): Promise<Proposal | null> {
  try {
    const raw = (await ai.run(model, {
      messages: [
        { role: "system", content: "You output only JSON. Never prose, never SQL." },
        { role: "user", content: buildPrompt(question, catalog) },
      ],
      max_tokens: 200,
    })) as { response?: string };

    const text = raw?.response ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const parsed = JSON.parse(match[0]) as Partial<QueryIntent>;

    // The model proposed it; the catalog decides whether it means anything.
    if (typeof parsed.metric !== "string" || typeof parsed.season !== "string") return null;

    return {
      intent: withDefaults({
        metric: parsed.metric,
        entity_type: "player",
        entity_id: parsed.entity_id ?? ALL_PLAYERS,
        season: parsed.season,
        competition: "PL",
        viz: (parsed.viz as VizType) ?? "bar",
        limit: 10,
      }),
      confidence: "high",
      notes: [],
      source: "ai",
    };
  } catch {
    // Any AI failure falls back to the rule-based path. The site never depends
    // on an inference call succeeding.
    return null;
  }
}
