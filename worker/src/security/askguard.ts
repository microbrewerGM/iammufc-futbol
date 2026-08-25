/**
 * The Ask input gate — deterministic, offline, and always the FIRST thing a
 * question meets.
 *
 * SCOPE OF THIS FILE, STATED PLAINLY
 * ----------------------------------
 * This gate is defence in depth. It is NOT the control that stops a prompt
 * injection from doing damage. That control is architectural and already
 * exists: the model's only output is a *proposed* QueryIntent, every field of
 * which is validated against the compiled catalog before anything executes
 * (core/parser.ts -> core/feasibility.ts). A model that is fully compromised
 * can at most propose a query the catalog then refuses. There is no
 * text-to-SQL path, no tool call, and no free-form execution to hijack.
 *
 * What this gate actually buys:
 *   1. Off-topic questions get an honest refusal instead of a confident
 *      answer about something nobody asked. Before this file existed,
 *      "what's the weather in Madrid" fell through to parseRuleBased, which
 *      defaults to goals/latest-season and rendered a bar chart. That is the
 *      failure this project cares most about -- a confident wrong answer.
 *   2. Hostile text never reaches the model at all, so injection attempts
 *      cost zero inference and leave a clean audit line.
 *   3. Scope enforcement: men's first team only.
 *
 * DELIBERATELY NOT AN ALLOW-LIST OF PHRASINGS. Plain language is open-ended;
 * enumerating valid sentences would reject real questions constantly. Instead
 * a question must carry positive evidence of BOTH a subject this site covers
 * and a statistical intent -- anchored in the catalog's own vocabulary, the
 * same lookup-not-inference rule feasibility follows.
 */

import type { LocaleCode } from "../core/locale";

/** Long questions are not real questions. The longest genuine phrasing in the
 *  examples list is ~70 characters; 300 leaves generous headroom while cutting
 *  off pasted instruction blocks, which is what long input almost always is. */
export const MAX_QUESTION_LENGTH = 300;

export type RejectCode =
  | "empty"
  | "too_long"
  | "unsafe_input"
  | "injection_attempt"
  | "not_mens_first_team"
  | "off_topic"
  | "not_statistical";

export interface GateAllowed {
  allowed: true;
  /** Whitespace-collapsed, control-characters removed. This, not the raw
   *  input, is what may be shown or sent onward. */
  question: string;
}

export interface GateRejected {
  allowed: false;
  code: RejectCode;
  reason: string;
  /** What the user could ask instead. Never empty -- a refusal with no way
   *  forward is a dead end, the same reason feasibility carries
   *  nearest_alternative. */
  suggestion: string;
}

export type GateVerdict = GateAllowed | GateRejected;

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The club, as people actually type it. */
const CLUB_ALIASES = [
  "manchester united",
  "man united",
  "man utd",
  "manchester utd",
  "mufc",
  "man u",
  "united",
  "utd",
  "red devils",
  "diablos rojos",
];

/**
 * Scope violations that are still about Manchester United. These are refused
 * on scope, not topic, and the wording says so -- telling someone their
 * question is "off topic" when they asked about the women's team is both
 * wrong and rude. This site covers the men's first team; that is a data
 * decision (every integrated source is men's first-team), not an editorial one.
 */
const OUT_OF_SCOPE_SQUAD = [
  "women", "women's", "womens", "woman", "ladies", "wsl", "femenino", "femenina",
  "academy", "youth", "u18", "u-18", "u21", "u-21", "u23", "u-23",
  "under 18", "under 21", "under 23", "reserves", "reserve team", "juvenil",
  "cantera", "academia",
];

/**
 * Other clubs. Naming one WITHOUT naming United means the question is about
 * them, not us. Naming one alongside United is a legitimate opponent query
 * ("United vs Liverpool") and is allowed through.
 */
const OTHER_CLUBS = [
  "liverpool", "manchester city", "man city", "mcfc", "arsenal", "chelsea",
  "tottenham", "spurs", "everton", "newcastle", "aston villa", "west ham",
  "leeds", "barcelona", "real madrid", "bayern", "juventus", "psg",
  "paris saint", "atletico", "atlético", "inter milan", "ac milan", "napoli",
  "borussia", "dortmund", "ajax", "porto", "benfica", "sevilla", "valencia",
];

/**
 * Concrete metrics and stat nouns. These do double duty: they establish
 * statistical intent AND they establish subject.
 *
 * Subject, because this site holds Manchester United data and nothing else.
 * "most assists" names no club, but on a United-only site it cannot mean
 * anyone else -- and a question naming a DIFFERENT club has already been
 * refused by the OTHER_CLUBS check that runs first. Requiring the club to be
 * named explicitly rejected "most assists", which is a perfectly good question
 * and exactly the false-rejection this gate must not produce.
 */
const METRIC_WORDS = [
  "goal", "goals", "scored", "scorer", "scorers", "scoring", "assist", "assists",
  "minute", "minutes", "mins", "appearance", "appearances", "played", "points",
  "xg", "expected goals", "clean sheet", "clean sheets", "conceded",
  "shot map", "pass map", "heatmap", "heat map", "possession", "passes",
  "progressive passes", "won", "win", "wins", "lost", "loss", "losses",
  "draw", "drawn", "defeats", "results", "record", "form", "squad",
  // Spanish
  "goles", "goleador", "goleadores", "anotó", "anotados", "asistencias",
  "minutos", "puntos", "partidos", "ganados", "perdidos", "empatados",
  "pases", "tiros", "temporada", "plantilla",
];

/** Words that signal a question is asking for an aggregate, a ranking or a
 *  comparison. These establish INTENT only -- "top" or "most" alone says
 *  nothing about who or what, so they never anchor the subject. */
const INTENT_WORDS = [
  "stat", "stats", "statistic", "statistics", "average", "total", "tally",
  "per game", "per 90", "compare", "comparison", "versus", "vs", "trend",
  "over time", "top", "most", "best", "highest", "worst", "fewest", "least",
  "leading", "how many", "how much", "ranking", "rank", "table", "chart",
  "graph",
  // Spanish
  "promedio", "comparar", "comparación", "tendencia", "más", "mejor", "peor",
  "cuántos", "cuántas", "clasificación", "tabla", "gráfico", "estadística",
  "estadísticas",
];

/**
 * Prompt-injection and instruction-hijack markers.
 *
 * Every entry here is a phrase that has no place in a football statistics
 * question. That is the whole selection criterion -- these are not "suspicious"
 * strings, they are strings a genuine user of this site will never type. That
 * keeps the false-positive rate near zero without needing a model to judge.
 */
const INJECTION_PATTERNS: RegExp[] = [
  // Instruction override
  /\b(ignore|disregard|forget|override)\b[^.]{0,30}\b(previous|prior|above|earlier|all|your)\b[^.]{0,20}\b(instruction|prompt|rule|direction|context)/i,
  /\b(ignora|olvida|descarta)\b[^.]{0,30}\b(instruccion|instrucción|indicacion|indicación|regla|anterior)/i,
  // Persona hijack
  /\byou are now\b|\bfrom now on you\b|\bact as (an?|the)\b|\bpretend (to be|you)\b|\broleplay\b|\bsimulate (being|an?)\b/i,
  /\bact(ú|u)a como\b|\bhaz de cuenta\b|\ba partir de ahora eres\b/i,
  // Prompt/config exfiltration
  /\b(reveal|show|print|repeat|output|display|dump|leak)\b[^.]{0,30}\b(system|initial|original|your)\b[^.]{0,20}\b(prompt|instruction|message|rule|config)/i,
  /\bsystem prompt\b|\bprompt injection\b|\bjailbreak\b|\bDAN mode\b/i,
  // Chat-role markers pasted into a single-line question
  /(^|\n)\s*(system|assistant|user|developer)\s*:/i,
  /<\|[^|]*\|>|\[INST\]|\[\/INST\]|<<SYS>>/i,
  // Code / query execution attempts
  /```|\bexecute\b[^.]{0,20}\b(sql|query|code|script|command)\b/i,
  /\b(select\s+.*\bfrom\b|drop\s+table|union\s+select|insert\s+into|delete\s+from|update\s+\w+\s+set)\b/i,
  /<\s*script|\bjavascript\s*:|\beval\s*\(|\bon(error|load|click)\s*=|\bdocument\s*\.\s*cookie/i,
  // Exfiltration channels. A URL in a football question is never the question.
  /https?:\/\/|\bwww\.|\bfetch\(|\bcurl\b|\bwebhook\b/i,
  // Output-format hijack ("answer only in JSON with the key...") aimed at the
  // proposal contract itself.
  /\b(respond|reply|answer|output)\b[^.]{0,25}\b(only in|exclusively|instead)\b/i,
];

/**
 * C0/C1 control characters plus the Unicode bidirectional-override and
 * invisible-formatting characters. The bidi set matters specifically because
 * it can visually reorder a string so that what a human reviewer reads is not
 * what the parser sees -- the Trojan Source class of attack. None of these
 * can be produced by typing a football question.
 */
const UNSAFE_CHARS =
  /[ ---­᠎​-‏‪-‮⁠-⁤⁦-⁯﻿]/;

// ---------------------------------------------------------------------------
// Refusal copy
// ---------------------------------------------------------------------------

const COPY: Record<RejectCode, Record<LocaleCode, { reason: string; suggestion: string }>> = {
  empty: {
    en: { reason: "No question was given.", suggestion: "Try: top scorers 2024-25" },
    es: { reason: "No se recibió ninguna pregunta.", suggestion: "Prueba: máximos goleadores 2024-25" },
  },
  too_long: {
    en: {
      reason: `Questions are limited to ${MAX_QUESTION_LENGTH} characters.`,
      suggestion: "Ask one thing at a time: most assists 2023-24",
    },
    es: {
      reason: `Las preguntas están limitadas a ${MAX_QUESTION_LENGTH} caracteres.`,
      suggestion: "Pregunta una cosa a la vez: más asistencias 2023-24",
    },
  },
  unsafe_input: {
    en: {
      reason: "That question contained characters this site does not accept.",
      suggestion: "Type the question as plain text: goals per season",
    },
    es: {
      reason: "Esa pregunta contenía caracteres que este sitio no acepta.",
      suggestion: "Escribe la pregunta como texto simple: goles por temporada",
    },
  },
  injection_attempt: {
    en: {
      reason:
        "That reads as an instruction to the system rather than a question about football, so it was not run.",
      suggestion: "Ask a statistics question instead: who scored most in 2021-22",
    },
    es: {
      reason:
        "Eso se lee como una instrucción al sistema y no como una pregunta de fútbol, así que no se ejecutó.",
      suggestion: "Haz una pregunta estadística: quién anotó más en 2021-22",
    },
  },
  not_mens_first_team: {
    en: {
      reason:
        "This site covers the Manchester United men's first team only. Every data source integrated here is men's first-team, so there is nothing behind a women's, academy or youth question to answer it with.",
      suggestion: "Ask about the first team: minutes played 2024-25",
    },
    es: {
      reason:
        "Este sitio cubre únicamente el primer equipo masculino del Manchester United. Todas las fuentes integradas son del primer equipo masculino, así que no hay datos detrás de una pregunta sobre el femenino, la academia o la cantera.",
      suggestion: "Pregunta sobre el primer equipo: minutos jugados 2024-25",
    },
  },
  off_topic: {
    en: {
      reason: "This site only answers questions about Manchester United.",
      suggestion: "Try: United's top scorers 2024-25",
    },
    es: {
      reason: "Este sitio solo responde preguntas sobre el Manchester United.",
      suggestion: "Prueba: máximos goleadores del United 2024-25",
    },
  },
  not_statistical: {
    en: {
      reason:
        "That is a Manchester United question, but not a statistical one. This site holds match and player statistics — not news, transfers, fixtures or opinion.",
      suggestion: "Try a statistic: goals by season, or most assists 2023-24",
    },
    es: {
      reason:
        "Esa es una pregunta sobre el Manchester United, pero no estadística. Este sitio contiene estadísticas de partidos y jugadores, no noticias, fichajes, calendario ni opinión.",
      suggestion: "Prueba una estadística: goles por temporada, o más asistencias 2023-24",
    },
  },
};

function reject(code: RejectCode, locale: LocaleCode): GateRejected {
  const copy = COPY[code][locale] ?? COPY[code].en;
  return { allowed: false, code, reason: copy.reason, suggestion: copy.suggestion };
}

/** Word-ish containment for short tokens that would otherwise match inside
 *  longer words -- "utd" is fine anywhere, but "united" must not fire on
 *  "reunited", and "won" must not fire on "wonder". */
function containsWord(haystack: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, "iu").test(haystack);
}

function containsAnyWord(haystack: string, words: readonly string[]): boolean {
  return words.some((w) => (w.includes(" ") ? haystack.includes(w) : containsWord(haystack, w)));
}

/** A season in any of the spellings parseSeason accepts, or a bare 4-digit
 *  year in the range this site could ever cover. */
function mentionsSeason(text: string): boolean {
  return /\b(20\d{2}\s*[-/]\s*\d{2}|\d{2}\s*[-/]\s*\d{2}|(19|20)\d{2})\b/.test(text);
}

function mentionsCompetition(text: string): boolean {
  return containsAnyWord(text, [
    "premier league", "pl", "epl", "league", "liga", "champions league",
    "champions", "ucl", "cl", "european", "europe", "europa", "fa cup",
    "cup", "copa", "domestic", "competition", "competición",
  ]);
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Checks run cheapest-and-most-objective first, so a rejection reason is
 * always the most specific true statement about the input rather than
 * whichever rule happened to fire.
 *
 * `knownPlayerNames` lets a bare name ("Rashford goals") anchor the subject
 * without naming the club. Optional: the gate is fully functional without it,
 * just slightly stricter, so a D1 outage degrades this to "must mention the
 * club, a season or a competition" rather than failing the route.
 */
export function gateQuestion(
  raw: string,
  locale: LocaleCode = "en",
  knownPlayerNames: readonly string[] = [],
): GateVerdict {
  if (UNSAFE_CHARS.test(raw)) return reject("unsafe_input", locale);

  const question = raw.replace(/\s+/g, " ").trim();
  if (!question) return reject("empty", locale);
  if (question.length > MAX_QUESTION_LENGTH) return reject("too_long", locale);

  // Hostile text stops here and never reaches the model.
  if (INJECTION_PATTERNS.some((re) => re.test(question))) {
    return reject("injection_attempt", locale);
  }

  const text = question.toLowerCase();

  // Scope before topic: a women's-team question is on-topic and out of scope,
  // and deserves the accurate refusal rather than "not about United".
  if (containsAnyWord(text, OUT_OF_SCOPE_SQUAD)) {
    return reject("not_mens_first_team", locale);
  }

  const namesUnited = containsAnyWord(text, CLUB_ALIASES);

  // Another club named alone -> the question is about them.
  if (!namesUnited && containsAnyWord(text, OTHER_CLUBS)) {
    return reject("off_topic", locale);
  }

  const namesPlayer =
    knownPlayerNames.length > 0 &&
    knownPlayerNames.some((n) => {
      const lower = n.toLowerCase();
      if (lower.length < 4) return false; // too short to be evidence on its own
      if (text.includes(lower)) return true;
      return lower.split(" ").some((part) => part.length >= 4 && containsWord(text, part));
    });

  // A metric noun anchors the subject on its own -- see METRIC_WORDS. Any
  // question about a different club was already refused above, so what is
  // left can only be about United.
  const namesMetric = containsAnyWord(text, METRIC_WORDS);

  const hasSubject =
    namesUnited || namesPlayer || namesMetric || mentionsSeason(text) || mentionsCompetition(text);
  if (!hasSubject) return reject("off_topic", locale);

  // On-topic but not a statistics question ("who is the manager?").
  const hasStatIntent = namesMetric || containsAnyWord(text, INTENT_WORDS) || mentionsSeason(text);
  if (!hasStatIntent) return reject("not_statistical", locale);

  return { allowed: true, question };
}

/**
 * Wraps user text for the model prompt.
 *
 * The delimiter is a fixed sentinel rather than a random nonce ON PURPOSE:
 * gateQuestion has already rejected every string containing chat-role markers,
 * fences, and instruction-override phrasing, so the text arriving here cannot
 * contain a closing delimiter of any form the model would honour. A random
 * nonce would imply the boundary is the security control. It is not -- catalog
 * validation of the model's output is. This is legibility, not a barrier.
 */
export function delimitForPrompt(question: string): string {
  return `<user_question>\n${question}\n</user_question>`;
}
