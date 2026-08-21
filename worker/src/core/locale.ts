/**
 * Path-based locale support (starting_ideas/02: `/en/` + `/es/`, one canonical
 * host, reciprocal hreflang -- not subdomains, which index worse).
 *
 * Design principle in play (docs/design-principles.md, bilingual note):
 * hierarchy built on SIZE and POSITION survives translation; hierarchy built
 * on a phrase fitting one line does not. Spanish runs longer than English, so
 * this file keeps strings short and lets layout carry the hierarchy instead
 * of word count.
 *
 * Attribution text (catalog/rights/manifest.yml `attribution_text_es`) and the
 * feasibility layer's computed `reason` strings are localized on HTML routes
 * (worker/src/core/feasibility.ts REASON table). The two JSON API routes
 * (/api/chat, /api/query) deliberately stay English-only -- they return data,
 * not prose, per this file's own routing comment in index.ts -- so their
 * `checkFeasibility` calls omit the locale argument rather than threading one
 * through for no reader.
 */

import type { Catalog } from "./feasibility";

export type LocaleCode = "en" | "es";
export const LOCALE_CODES: LocaleCode[] = ["en", "es"];

/** Controlled vocabulary, not ad-hoc translation (starting_ideas/01 §E:
 *  position conventions differ materially between languages and must be a
 *  mapping from codes, never a string translated on the fly). */
const POSITION_LABELS: Record<string, Record<LocaleCode, string>> = {
  GK: { en: "GK", es: "POR" },
  DF: { en: "DF", es: "DEF" },
  MF: { en: "MF", es: "CEN" },
  FW: { en: "FW", es: "DEL" },
};

export interface Locale {
  code: LocaleCode;
  htmlLang: string; // full BCP-47 for <html lang="">
  numberLocale: string; // for Intl.NumberFormat -- es-ES gives decimal comma
  strings: {
    siteTagline: string;
    askPlaceholder: string;
    askButton: string;
    examplesHeading: string;
    coverageHeading: string;
    legendAvailable: string;
    legendNoRights: string;
    legendNoSource: string;
    parsedAsRules: string;
    parsedAsAi: string;
    assumptions: string;
    dataHeading: string;
    metricCol: string;
    seasonCol: string;
    playerCol: string;
    posCol: string;
    backToMatrix: string;
    fullSquadFor: (season: string) => string;
    artifactNote: string;
    careerRecordFor: (season: string) => string;
    dashExplainer: string;
    squadHeading: (season: string) => string;
    leagueRecord: (p: number, w: number, d: number, l: number, gf: number, ga: number) => string;
    seeTopScorers: string;
    noSeasonRecord: (season: string) => string;
    noPlayerMatched: (name: string) => string;
    checkMatrix: string;
    noSquadData: (season: string) => string;
    disclaimer: string;
    resultsAttribution: string;
    snapshotNote: (id: string) => string;
    notFoundHeading: string;
    notFoundBody: string;
    startAgain: string;
  };
}

const EN: Locale = {
  code: "en",
  htmlLang: "en",
  numberLocale: "en-GB",
  strings: {
    siteTagline: "Manchester United statistics. Unofficial, non-commercial, and honest about what it does not have.",
    askPlaceholder: "Ask about Manchester United…",
    askButton: "Ask",
    examplesHeading: "Try asking",
    coverageHeading: "What we can actually show",
    legendAvailable: "available",
    legendNoRights: "we have a source but no right to publish",
    legendNoSource: "no source integrated",
    parsedAsRules: "Parsed as (rule-based)",
    parsedAsAi: "Parsed as (AI-assisted)",
    assumptions: "Assumptions:",
    dataHeading: "Data",
    metricCol: "Metric",
    seasonCol: "Season",
    playerCol: "Player",
    posCol: "Pos",
    backToMatrix: "Back to the coverage matrix",
    fullSquadFor: (s) => `Full squad for ${s}`,
    artifactNote: "identical questions produce this same key.",
    careerRecordFor: (s) => `Career record across every season we hold. Current: ${s}.`,
    dashExplainer:
      "– means no source for that season, or (for xG/progressive passes) a source we hold but may not republish. Hover a dash for the reason.",
    squadHeading: (s) => `Squad — ${s}`,
    leagueRecord: (p, w, d, l, gf, ga) =>
      `League record: ${p} played, ${w}W ${d}D ${l}L, ${gf}–${ga} goals.`,
    seeTopScorers: "See top scorers",
    noSeasonRecord: (s) => `No season-level results integrated for ${s} yet.`,
    noPlayerMatched: (n) => `No player matched "${n}" in our data.`,
    checkMatrix: "Try a surname, or check the coverage matrix for what seasons we hold.",
    noSquadData: (s) => `No squad data integrated for ${s}.`,
    disclaimer:
      "This is an unofficial fan site. Not affiliated with, endorsed by, or associated with Manchester United Football Club. All club trademarks are the property of their owners.",
    resultsAttribution: "Match results via Football-Data.co.uk and openfootball, under ODC-PDDL and public domain.",
    snapshotNote: (id) =>
      `Data snapshot ${id} — every figure on this page can be regenerated from it.`,
    notFoundHeading: "Not found",
    notFoundBody: "Nothing lives at this address.",
    startAgain: "Start again",
  },
};

const ES: Locale = {
  code: "es",
  htmlLang: "es",
  numberLocale: "es-ES",
  strings: {
    siteTagline: "Estadísticas del Manchester United. No oficial, sin ánimo de lucro, y honesto sobre lo que no tiene.",
    askPlaceholder: "Pregunta sobre el Manchester United…",
    askButton: "Preguntar",
    examplesHeading: "Prueba preguntando",
    coverageHeading: "Lo que realmente podemos mostrar",
    legendAvailable: "disponible",
    legendNoRights: "tenemos la fuente pero no el derecho de publicarla",
    legendNoSource: "ninguna fuente integrada",
    parsedAsRules: "Interpretado como (basado en reglas)",
    parsedAsAi: "Interpretado como (asistido por IA)",
    assumptions: "Suposiciones:",
    dataHeading: "Datos",
    metricCol: "Métrica",
    seasonCol: "Temporada",
    playerCol: "Jugador",
    posCol: "Pos",
    backToMatrix: "Volver a la matriz de cobertura",
    fullSquadFor: (s) => `Plantilla completa de ${s}`,
    artifactNote: "preguntas idénticas producen esta misma clave.",
    careerRecordFor: (s) => `Trayectoria en cada temporada disponible. Actual: ${s}.`,
    dashExplainer:
      "– significa que no hay fuente para esa temporada, o (para xG/pases progresivos) una fuente que tenemos pero no podemos republicar. Pasa el cursor sobre el guion para ver el motivo.",
    squadHeading: (s) => `Plantilla — ${s}`,
    leagueRecord: (p, w, d, l, gf, ga) =>
      `Récord en liga: ${p} jugados, ${w}G ${d}E ${l}P, ${gf}–${ga} goles.`,
    seeTopScorers: "Ver máximos goleadores",
    noSeasonRecord: (s) => `Aún no hay resultados de temporada integrados para ${s}.`,
    noPlayerMatched: (n) => `Ningún jugador coincide con "${n}" en nuestros datos.`,
    checkMatrix: "Prueba con un apellido, o revisa la matriz de cobertura para ver qué temporadas tenemos.",
    noSquadData: (s) => `No hay datos de plantilla integrados para ${s}.`,
    disclaimer:
      "Este es un sitio de aficionados no oficial. No está afiliado, respaldado ni asociado con el Manchester United Football Club. Todas las marcas registradas del club son propiedad de sus respectivos dueños.",
    resultsAttribution: "Resultados vía Football-Data.co.uk y openfootball, bajo ODC-PDDL y dominio público.",
    snapshotNote: (id) =>
      `Instantánea de datos ${id} — cada cifra de esta página puede regenerarse a partir de ella.`,
    notFoundHeading: "No encontrado",
    notFoundBody: "No hay nada en esta dirección.",
    startAgain: "Empezar de nuevo",
  },
};

export const LOCALES: Record<LocaleCode, Locale> = { en: EN, es: ES };

export function localeFromPath(pathname: string): LocaleCode {
  if (pathname.startsWith("/es/") || pathname === "/es") return "es";
  return "en";
}

export function positionLabel(code: string, locale: LocaleCode): string {
  return POSITION_LABELS[code]?.[locale] ?? code;
}

export function metricLabel(catalog: Catalog, metricId: string, locale: LocaleCode): string {
  const m = catalog.metric(metricId);
  if (!m) return metricId;
  return locale === "es" ? m.label_es : m.label_en;
}

/** Decimal COMMA in Spanish, decimal POINT in English -- starting_ideas/01
 *  §E is explicit that this is a formatting concern, not a data concern:
 *  store canonical numeric values, format at render. Full ICU is available in
 *  the Workers runtime, so Intl.NumberFormat needs no polyfill. */
export function formatNumber(value: number | null, decimals: number, locale: LocaleCode): string {
  if (value === null || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat(LOCALES[locale].numberLocale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}
