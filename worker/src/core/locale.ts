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
import type { ChampionsLeagueHistoryStrings } from "../views/cl-history";

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
    seasonSplits: {
      decadeLabel: (decade: number) => string;
      seasonSelection: (count: number) => string;
      coverageSummary: (selected: number, complete: number, partial: number, missing: number) => string;
      unavailableSeasons: (seasons: string) => string;
      exploreSeasonPerformance: string;
      home: string;
      away: string;
      otherSeasons: string;
      groupBy: string;
      homeAndAway: string;
      opponent: string;
      venue: string;
      allVenues: string;
      allOpponents: string;
      exploreSeasons: string;
      rowsCombineTheSelectedSeasons: string;
      manchesterUnitedPremierLeagueCompletedMatches: string;
      missingData: string;
      complete: string;
      partialSchedule: string;
      missingSplitCoverage: string;
      partialScheduleTheseArePartialSubtotals: string;
      seasonCoverage: string;
      played: string;
      wins: string;
      draws: string;
      losses: string;
      goalsFor: string;
      goalsAgainst: string;
      goalDifference: string;
      points: string;
      pointsMatch: string;
      goalsForMatch: string;
      goalsAgainstMatch: string;
      winRate: string;
      contributingSeasons: string;
      allMatches: string;
      partialSubtotals: string;
      splitCoverageIsUnavailableForThis: string;
      seasonPerformance: string;
      noCompletedMatchesMatchThisSelection: string;
      sourcesAndSnapshot: string;
      sourceAttributionUnavailableForSomeData: string;
      snapshot: string;
    };
    clHistory: ChampionsLeagueHistoryStrings;
    siteTagline: string;
    askPlaceholder: string;
    askButton: string;
    examplesHeading: string;
    exampleQuestionsHeading: string;
    exampleGoals: string;
    exampleAssistsTable: string;
    exampleMinutesDots: string;
    examplePointsTable: string;
    exampleXg: string;
    historyLink: string;
    playerRangeLink: string;
    playerTrendsLink: string;
    playerTrendsInvalid: string;
    playerTrendsUnknown: string;
    playerTrendsUnavailable: string;
    playerTrendsPlayerLabel: string;
    playerTrendsFromLabel: string;
    playerTrendsThroughLabel: string;
    playerTrendsSubmit: string;
    opponentHistoryTitle: string;
    opponentHistoryChoose: string;
    opponentHistoryOpponentLabel: string;
    opponentHistorySeasons: string;
    opponentHistoryVenue: string;
    opponentHistoryVenueAll: string;
    opponentHistoryVenueHome: string;
    opponentHistoryVenueAway: string;
    opponentHistorySubmit: string;
    opponentHistoryChangeSelection: string;
    opponentHistoryInvalid: string;
    opponentHistoryNoSeasons: string;
    opponentHistoryUnavailable: string;
    opponentHistoryLink: string;
    freshnessHeading: string;
    coverageThrough: (season: string) => string;
    lastSuccessfulLoad: string;
    sourceCoverageThrough: (season: string) => string;
    sourceRetrieved: string;
    sourceAsOf: string;
    sourceAsOfUnavailable: string;
    sourceObserved: string;
    sourceUnavailable: string;
    sourceNotRetrieved: string;
    freshnessDegraded: string;
    freshnessInconsistent: string;
    freshnessUnavailable: string;
    coverageHeading: string;
    dataCatalogTitle: string;
    dataCatalogIntro: string;
    dataCatalogEmpty: string;
    dataCatalogTableLabel: string;
    definitionCol: string;
    entityCol: string;
    competitionCol: string;
    granularityCol: string;
    sourceCol: string;
    availabilityCol: string;
    feasibilityCol: string;
    attributionHeading: string;
    availableForPublication: string;
    unavailableForPublication: string;
    feasibilityQueued: string;
    feasibilityExpensive: string;
    feasibilityNoRights: string;
    legendAvailable: string;
    legendNoRights: string;
    legendNoSource: string;
    parsedAsRules: string;
    parsedAsAi: string;
    assumptions: string;
    clarificationRequired: string;
    dataHeading: string;
    metricCol: string;
    seasonCol: string;
    playerCol: string;
    posCol: string;
    rankCol: string;
    resultCount: (returned: number, requested: number) => string;
    backToMatrix: string;
    fullSquadFor: (season: string) => string;
    artifactNote: string;
    careerRecordFor: (season: string) => string;
    goalsPer90Col: string;
    assistsPer90Col: string;
    careerRateExplainer: string;
    careerTableLabel: string;
    dashExplainer: string;
    squadHeading: (season: string) => string;
    squadTableLabel: (season: string) => string;
    teamSeasonsHeading: string;
    teamSeasonsIntro: string;
    teamSeasonsTableLabel: string;
    playedCol: string;
    leaguePointsCol: string;
    pointsPerMatchCol: string;
    goalsForCol: string;
    goalsPerMatchCol: string;
    partialLabel: string;
    teamSeasonsExplainer: string;
    teamSeasonsSource: (source: string) => string;
    teamSeasonsUnavailable: string;
    leagueRecord: (p: number, w: number, d: number, l: number, gf: number, ga: number) => string;
    /** Champions League season record. Separate string from leagueRecord, not a
     *  parameterised competition name: "played/won/drawn/lost" reads naturally
     *  in a league table and awkwardly for a knockout competition, and Spanish
     *  needs its own phrasing rather than a substituted noun. */
    europeanRecord: (p: number, w: number, d: number, l: number, gf: number, ga: number) => string;
    seeTopScorers: string;
    noSeasonRecord: (season: string) => string;
    noPlayerMatched: (name: string) => string;
    noPlayerSeasonData: (name: string, season: string) => string;
    checkMatrix: string;
    noSquadData: (season: string) => string;
    disclaimer: string;
    resultsAttribution: string;
    snapshotNote: (id: string) => string;
    notFoundHeading: string;
    notFoundBody: string;
    startAgain: string;
    budgetExceeded: string;
  };
}

const EN: Locale = {
  code: "en",
  htmlLang: "en",
  numberLocale: "en-GB",
  strings: {
    seasonSplits: {
      decadeLabel: (decade) => `${decade}s`,
      seasonSelection: (count) => `Seasons (${count} selected; choose 1–16)`,
      coverageSummary: (selected, complete, partial, missing) => `Coverage across ${selected} selected ${selected === 1 ? "season" : "seasons"}: ${complete} complete, ${partial} ${partial === 1 ? "partial schedule" : "partial schedules"}, ${missing} missing split coverage.`,
      unavailableSeasons: (seasons) => `Split coverage is unavailable for ${seasons}. Revise season selection using the controls above. No zero-match total is implied.`,
      exploreSeasonPerformance: "Explore season performance",
      home: "Home",
      away: "Away",
      otherSeasons: "Other seasons",
      groupBy: "Group by",
      homeAndAway: "Home and away",
      opponent: "Opponent",
      venue: "Venue",
      allVenues: "All venues",
      allOpponents: "All opponents",
      exploreSeasons: "Explore seasons",
      rowsCombineTheSelectedSeasons: "Rows combine the selected seasons. ",
      manchesterUnitedPremierLeagueCompletedMatches: "Manchester United · Premier League. Completed matches only. Points = 3 × wins + draws. Rates divide totals by the same played matches; they are not schedule-adjusted.",
      missingData: "Missing data",
      complete: "Complete",
      partialSchedule: "Partial schedule",
      missingSplitCoverage: "Missing split coverage",
      partialScheduleTheseArePartialSubtotals: "Partial schedule: these are partial subtotals. Missing matches are not zero; rates describe only the matches available.",
      seasonCoverage: "Season coverage",
      played: "Played",
      wins: "Wins",
      draws: "Draws",
      losses: "Losses",
      goalsFor: "Goals for",
      goalsAgainst: "Goals against",
      goalDifference: "Goal difference",
      points: "Points",
      pointsMatch: "Points / match",
      goalsForMatch: "Goals for / match",
      goalsAgainstMatch: "Goals against / match",
      winRate: "Win rate (%)",
      contributingSeasons: "Contributing seasons",
      allMatches: "All matches",
      partialSubtotals: "partial subtotals",
      splitCoverageIsUnavailableForThis: "Split coverage is unavailable for this selection. No zero-match total is implied.",
      seasonPerformance: "Season performance",
      noCompletedMatchesMatchThisSelection: "No completed matches match this selection.",
      sourcesAndSnapshot: "Sources and snapshot",
      sourceAttributionUnavailableForSomeData: "Source attribution unavailable for some data.",
      snapshot: "Snapshot",
    },
    clHistory: {
      heading: "Champions League history", caption: "Recorded matches; records may be incomplete",
      season: "Season", played: "Played", won: "Won", drawn: "Drawn", lost: "Lost",
      stage: "Stage reached", stages: { group_stage: "Group stage", league_phase: "League phase", knockout_playoff: "Knockout play-off", round_of_16: "Round of 16", quarter_final: "Quarter-final", semi_final: "Semi-final", final: "Final", winner: "Winner" },
      goalsFor: "Goals for", goalsAgainst: "Goals against",
      gap: "No recorded matches available; this does not establish non-participation",
      partial: "Partial", outsideCoverage: "Champions League history is outside current coverage",
      noResults: "No recorded Champions League results are available",
      unavailable: "History is temporarily unavailable", snapshotDate: "Data snapshot",
      sources: "Sources and snapshot", attributionUnavailable: "Source attribution unavailable for some data.",
      observedSeasons: "Recorded seasons ({n})",
      seasonsExcluded: "Not totalled: {n} (no data or without attribution)",
    },
    siteTagline: "Manchester United statistics. Unofficial, non-commercial, and honest about what it does not have.",
    askPlaceholder: "Ask about Manchester United…",
    askButton: "Ask",
    examplesHeading: "Try asking",
    exampleQuestionsHeading: "Example questions",
    exampleGoals: "Top goals",
    exampleAssistsTable: "Top assists table",
    exampleMinutesDots: "Top minutes dot plot",
    examplePointsTable: "Top FPL points table",
    exampleXg: "Expected goals",
    historyLink: "Past questions",
    playerRangeLink: "Compare players across seasons",
    playerTrendsLink: "Player trends",
    playerTrendsInvalid: "Invalid trend selection.",
    playerTrendsUnknown: "Player not found.",
    playerTrendsUnavailable: "Trend unavailable.",
    playerTrendsPlayerLabel: "Player",
    playerTrendsFromLabel: "From",
    playerTrendsThroughLabel: "Through",
    playerTrendsSubmit: "View trend",
    opponentHistoryTitle: "Opponent history",
    opponentHistoryChoose: "Choose an opponent and scope",
    opponentHistoryOpponentLabel: "Opponent",
    opponentHistorySeasons: "Seasons",
    opponentHistoryVenue: "Venue",
    opponentHistoryVenueAll: "All venues",
    opponentHistoryVenueHome: "Home",
    opponentHistoryVenueAway: "Away",
    opponentHistorySubmit: "View history",
    opponentHistoryChangeSelection: "Change selection",
    opponentHistoryInvalid: "Invalid opponent history selection.",
    opponentHistoryNoSeasons: "Select at least one season.",
    opponentHistoryUnavailable: "Opponent history is temporarily unavailable.",
    opponentHistoryLink: "Opponent history",
    freshnessHeading: "Data freshness",
    coverageThrough: (s) => `Coverage through ${s}.`,
    lastSuccessfulLoad: "Last successful load:",
    sourceCoverageThrough: (s) => `Coverage through ${s}.`,
    sourceRetrieved: "Retrieved:",
    sourceAsOf: "Source as of:",
    sourceAsOfUnavailable: "Source as-of date not provided.",
    sourceObserved: "Observed in the last load.",
    sourceUnavailable: "Unavailable during the last load; its data is absent, not zero.",
    sourceNotRetrieved: "Not retrieved in the last load.",
    freshnessDegraded: "The core data loaded, but an optional source was unavailable.",
    freshnessInconsistent: "Freshness metadata does not match the current data, so this page does not describe it as current.",
    freshnessUnavailable: "No successful data load is recorded.",
    coverageHeading: "What we can actually show",
    dataCatalogTitle: "Data and sources",
    dataCatalogIntro: "Declared Manchester United men's first-team coverage and sources. A permitted coverage cell does not guarantee that a matching database row exists; missing combinations are never treated as zero.",
    dataCatalogEmpty: "No data coverage is currently published.",
    dataCatalogTableLabel: "Declared data coverage by metric, season, competition and source",
    definitionCol: "Definition",
    entityCol: "Entity",
    competitionCol: "Competition",
    granularityCol: "Detail",
    sourceCol: "Source",
    availabilityCol: "Publishing status",
    feasibilityCol: "Capability",
    attributionHeading: "Source attribution",
    availableForPublication: "Permitted when present",
    unavailableForPublication: "Not permitted",
    feasibilityQueued: "Computable now (queued)",
    feasibilityExpensive: "Computable but expensive",
    feasibilityNoRights: "No publication rights",
    legendAvailable: "available",
    legendNoRights: "we have a source but no right to publish",
    legendNoSource: "no source integrated",
    parsedAsRules: "Parsed as (rule-based)",
    parsedAsAi: "Parsed as (AI-assisted)",
    assumptions: "Assumptions:",
    clarificationRequired:
      "This proposal is ambiguous and has not been run. Add the missing metric or season, then ask again.",
    dataHeading: "Data",
    metricCol: "Metric",
    seasonCol: "Season",
    playerCol: "Player",
    posCol: "Pos",
    rankCol: "Rank",
    resultCount: (returned, requested) => `Results shown: ${returned}; requested: ${requested}.`,
    backToMatrix: "Back to the coverage matrix",
    fullSquadFor: (s) => `Full squad for ${s}`,
    artifactNote: "identical questions produce this same key.",
    careerRecordFor: (s) => `Manchester United output by season. Selected: ${s}.`,
    goalsPer90Col: "Goals / 90",
    assistsPer90Col: "Assists / 90",
    careerRateExplainer:
      "Per 90 = 90 × total ÷ minutes. A dash means a value is unavailable; missing data is not zero.",
    careerTableLabel: "Manchester United player output by season",
    dashExplainer:
      "A dash means no source for that season, or a source value that is unavailable for publication.",
    squadHeading: (s) => `Squad — ${s}`,
    squadTableLabel: (s) => `Manchester United squad output for ${s}`,
    teamSeasonsHeading: "League season comparison",
    teamSeasonsIntro: "The selected season and earlier covered Premier League seasons.",
    teamSeasonsTableLabel: "Manchester United Premier League seasons",
    playedCol: "Played",
    leaguePointsCol: "League points",
    pointsPerMatchCol: "Points / match",
    goalsForCol: "Goals for",
    goalsPerMatchCol: "Goals for / match",
    partialLabel: "Partial",
    teamSeasonsExplainer: "League points = 3 × wins + draws. Per-match rates divide by games played. Fewer than 38 recorded matches is partial; rates are not forecasts or performance verdicts.",
    teamSeasonsSource: (source) => `Source: ${source}.`,
    teamSeasonsUnavailable: "The league-season comparison is unavailable because its coverage or publication snapshot is incomplete.",
    leagueRecord: (p, w, d, l, gf, ga) =>
      `League record: ${p} played, ${w}W ${d}D ${l}L, ${gf}–${ga} goals.`,
    europeanRecord: (p, w, d, l, gf, ga) =>
      `Champions League: ${p} played, ${w}W ${d}D ${l}L, ${gf}–${ga} goals.`,
    seeTopScorers: "See top scorers",
    noSeasonRecord: (s) => `No season-level results integrated for ${s} yet.`,
    noPlayerMatched: (n) => `No player matched "${n}" in our data.`,
    noPlayerSeasonData: (n, s) => `No verified Manchester United player data for ${n} in ${s}.`,
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
    budgetExceeded:
      "This site has hit its compute budget for today. Nothing was computed -- try again after midnight UTC.",
  },
};

const ES: Locale = {
  code: "es",
  htmlLang: "es",
  numberLocale: "es-ES",
  strings: {
    seasonSplits: {
      decadeLabel: (decade) => `Década de ${decade}`,
      seasonSelection: (count) => `Temporadas (${count} ${count === 1 ? "seleccionada" : "seleccionadas"}; elige 1–16)`,
      coverageSummary: (selected, complete, partial, missing) => `Cobertura de ${selected} ${selected === 1 ? "temporada seleccionada" : "temporadas seleccionadas"}: ${complete} ${complete === 1 ? "completa" : "completas"}, ${partial} ${partial === 1 ? "parcial" : "parciales"}, ${missing} sin cobertura.`,
      unavailableSeasons: (seasons) => `La cobertura de desgloses no está disponible para ${seasons}. Cambie la selección de temporada con los controles anteriores. No se afirma un total de cero partidos.`,
      exploreSeasonPerformance: "Explorar el rendimiento por temporada",
      home: "Local",
      away: "Visitante",
      otherSeasons: "Otras temporadas",
      groupBy: "Agrupar por",
      homeAndAway: "Local y visitante",
      opponent: "Rival",
      venue: "Localía",
      allVenues: "Todas las localías",
      allOpponents: "Todos los rivales",
      exploreSeasons: "Explorar temporadas",
      rowsCombineTheSelectedSeasons: "Las filas combinan las temporadas seleccionadas. ",
      manchesterUnitedPremierLeagueCompletedMatches: "Manchester United · Premier League. Solo partidos finalizados. Puntos = 3 × victorias + empates. Las tasas dividen los totales entre los mismos partidos jugados; no se ajustan al calendario.",
      missingData: "Datos ausentes",
      complete: "Completa",
      partialSchedule: "Calendario parcial",
      missingSplitCoverage: "Sin cobertura de desgloses",
      partialScheduleTheseArePartialSubtotals: "Calendario parcial: son subtotales parciales. Los partidos ausentes no equivalen a cero; las tasas describen solo los partidos disponibles.",
      seasonCoverage: "Cobertura por temporada",
      played: "Jugados",
      wins: "Victorias",
      draws: "Empates",
      losses: "Derrotas",
      goalsFor: "Goles a favor",
      goalsAgainst: "Goles en contra",
      goalDifference: "Diferencia de goles",
      points: "Puntos",
      pointsMatch: "Puntos / partido",
      goalsForMatch: "Goles a favor / partido",
      goalsAgainstMatch: "Goles en contra / partido",
      winRate: "Victorias (%)",
      contributingSeasons: "Temporadas con datos",
      allMatches: "Todos los partidos",
      partialSubtotals: "subtotales parciales",
      splitCoverageIsUnavailableForThis: "La cobertura de desgloses no está disponible para esta selección. No se afirma un total de cero partidos.",
      seasonPerformance: "Rendimiento por temporada",
      noCompletedMatchesMatchThisSelection: "Ningún partido finalizado coincide con esta selección.",
      sourcesAndSnapshot: "Fuentes y versión de datos",
      sourceAttributionUnavailableForSomeData: "Atribución de fuente no disponible para algunos datos.",
      snapshot: "Versión de datos",
    },
    clHistory: {
      heading: "Historial de la Liga de Campeones", caption: "Partidos registrados; los datos pueden estar incompletos",
      season: "Temporada", played: "Jugados", won: "Ganados", drawn: "Empatados", lost: "Perdidos",
      stage: "Fase alcanzada", stages: { group_stage: "Fase de grupos", league_phase: "Fase liga", knockout_playoff: "Eliminatoria previa", round_of_16: "Octavos de final", quarter_final: "Cuartos de final", semi_final: "Semifinal", final: "Final", winner: "Campeón" },
      goalsFor: "Goles a favor", goalsAgainst: "Goles en contra",
      gap: "No hay partidos registrados disponibles; esto no demuestra que el equipo no participara",
      partial: "Parcial", outsideCoverage: "El historial de la Liga de Campeones está fuera de la cobertura actual",
      noResults: "No hay resultados registrados de la Liga de Campeones disponibles",
      unavailable: "El historial no está disponible temporalmente", snapshotDate: "Fecha de los datos",
      sources: "Fuentes y versión de datos", attributionUnavailable: "Atribución de fuente no disponible para algunos datos.",
      observedSeasons: "Temporadas registradas ({n})",
      seasonsExcluded: "No sumadas: {n} (sin datos o sin atribución)",
    },
    siteTagline: "Estadísticas del Manchester United. No oficial, sin ánimo de lucro, y honesto sobre lo que no tiene.",
    askPlaceholder: "Pregunta sobre el Manchester United…",
    askButton: "Preguntar",
    examplesHeading: "Prueba preguntando",
    exampleQuestionsHeading: "Preguntas de ejemplo",
    exampleGoals: "Máximos goles",
    exampleAssistsTable: "Máximas asistencias tabla",
    exampleMinutesDots: "Más minutos gráfico de puntos",
    examplePointsTable: "Más puntos FPL tabla",
    exampleXg: "Goles esperados",
    historyLink: "Preguntas anteriores",
    playerRangeLink: "Comparar jugadores entre temporadas",
    playerTrendsLink: "Evolución de jugadores",
    playerTrendsInvalid: "Selección de evolución no válida.",
    playerTrendsUnknown: "No se encontró el jugador.",
    playerTrendsUnavailable: "La evolución no está disponible.",
    playerTrendsPlayerLabel: "Jugador",
    playerTrendsFromLabel: "Desde",
    playerTrendsThroughLabel: "Hasta",
    playerTrendsSubmit: "Ver evolución",
    opponentHistoryTitle: "Historial contra rivales",
    opponentHistoryChoose: "Elige un rival y el alcance",
    opponentHistoryOpponentLabel: "Rival",
    opponentHistorySeasons: "Temporadas",
    opponentHistoryVenue: "Localía",
    opponentHistoryVenueAll: "Todas las localías",
    opponentHistoryVenueHome: "Local",
    opponentHistoryVenueAway: "Visitante",
    opponentHistorySubmit: "Ver historial",
    opponentHistoryChangeSelection: "Cambiar selección",
    opponentHistoryInvalid: "Selección de historial de rival no válida.",
    opponentHistoryNoSeasons: "Selecciona al menos una temporada.",
    opponentHistoryUnavailable: "El historial del rival no está disponible temporalmente.",
    opponentHistoryLink: "Historial contra rivales",
    freshnessHeading: "Actualización de los datos",
    coverageThrough: (s) => `Cobertura hasta ${s}.`,
    lastSuccessfulLoad: "Última carga correcta:",
    sourceCoverageThrough: (s) => `Cobertura hasta ${s}.`,
    sourceRetrieved: "Recuperado:",
    sourceAsOf: "Datos de origen a fecha de:",
    sourceAsOfUnavailable: "La fuente no proporciona una fecha de vigencia.",
    sourceObserved: "Observada en la última carga.",
    sourceUnavailable: "No disponible durante la última carga; sus datos están ausentes, no son cero.",
    sourceNotRetrieved: "No se recuperó en la última carga.",
    freshnessDegraded: "Los datos principales se cargaron, pero una fuente opcional no estaba disponible.",
    freshnessInconsistent: "Los metadatos de actualización no coinciden con los datos actuales, por lo que esta página no los presenta como actuales.",
    freshnessUnavailable: "No hay ninguna carga de datos correcta registrada.",
    coverageHeading: "Lo que realmente podemos mostrar",
    dataCatalogTitle: "Datos y fuentes",
    dataCatalogIntro: "Cobertura y fuentes declaradas para el primer equipo masculino del Manchester United. Una celda permitida no garantiza que exista una fila correspondiente en la base de datos; las combinaciones ausentes nunca equivalen a cero.",
    dataCatalogEmpty: "Actualmente no hay cobertura de datos publicada.",
    dataCatalogTableLabel: "Cobertura de datos declarada por métrica, temporada, competición y fuente",
    definitionCol: "Definición",
    entityCol: "Entidad",
    competitionCol: "Competición",
    granularityCol: "Detalle",
    sourceCol: "Fuente",
    availabilityCol: "Estado de publicación",
    feasibilityCol: "Capacidad",
    attributionHeading: "Atribución de las fuentes",
    availableForPublication: "Permitido si está presente",
    unavailableForPublication: "No permitido",
    feasibilityQueued: "Calculable ahora (en cola)",
    feasibilityExpensive: "Calculable, pero costoso",
    feasibilityNoRights: "Sin derechos de publicación",
    legendAvailable: "disponible",
    legendNoRights: "tenemos la fuente pero no el derecho de publicarla",
    legendNoSource: "ninguna fuente integrada",
    parsedAsRules: "Interpretado como (basado en reglas)",
    parsedAsAi: "Interpretado como (asistido por IA)",
    assumptions: "Suposiciones:",
    clarificationRequired:
      "Esta propuesta es ambigua y no se ha ejecutado. Añade la métrica o la temporada que falta y vuelve a preguntar.",
    dataHeading: "Datos",
    metricCol: "Métrica",
    seasonCol: "Temporada",
    playerCol: "Jugador",
    posCol: "Pos",
    rankCol: "Puesto",
    resultCount: (returned, requested) => `Resultados mostrados: ${returned}; solicitados: ${requested}.`,
    backToMatrix: "Volver a la matriz de cobertura",
    fullSquadFor: (s) => `Plantilla completa de ${s}`,
    artifactNote: "preguntas idénticas producen esta misma clave.",
    careerRecordFor: (s) => `Producción del Manchester United por temporada. Seleccionada: ${s}.`,
    goalsPer90Col: "Goles / 90",
    assistsPer90Col: "Asistencias / 90",
    careerRateExplainer:
      "Por 90 = 90 × total ÷ minutos. Un guion significa que un valor no está disponible; los datos ausentes no son cero.",
    careerTableLabel: "Producción del jugador del Manchester United por temporada",
    dashExplainer:
      "Un guion significa que no hay fuente para esa temporada, o que un valor no está disponible para publicación.",
    squadHeading: (s) => `Plantilla — ${s}`,
    squadTableLabel: (s) => `Producción de la plantilla del Manchester United en ${s}`,
    teamSeasonsHeading: "Comparación de temporadas de liga",
    teamSeasonsIntro: "La temporada seleccionada y las temporadas anteriores con cobertura de la Premier League.",
    teamSeasonsTableLabel: "Temporadas del Manchester United en la Premier League",
    playedCol: "Jugados",
    leaguePointsCol: "Puntos de liga",
    pointsPerMatchCol: "Puntos / partido",
    goalsForCol: "Goles a favor",
    goalsPerMatchCol: "Goles a favor / partido",
    partialLabel: "Parcial",
    teamSeasonsExplainer: "Puntos de liga = 3 × victorias + empates. Las tasas por partido dividen por partidos jugados. Menos de 38 partidos registrados indica una temporada parcial; las tasas no son pronósticos ni veredictos de rendimiento.",
    teamSeasonsSource: (source) => `Fuente: ${source}.`,
    teamSeasonsUnavailable: "La comparación de temporadas no está disponible porque su cobertura o instantánea de publicación está incompleta.",
    leagueRecord: (p, w, d, l, gf, ga) =>
      `Récord en liga: ${p} jugados, ${w}G ${d}E ${l}P, ${gf}–${ga} goles.`,
    europeanRecord: (p, w, d, l, gf, ga) =>
      `Liga de Campeones: ${p} jugados, ${w}G ${d}E ${l}P, ${gf}–${ga} goles.`,
    seeTopScorers: "Ver máximos goleadores",
    noSeasonRecord: (s) => `Aún no hay resultados de temporada integrados para ${s}.`,
    noPlayerMatched: (n) => `Ningún jugador coincide con "${n}" en nuestros datos.`,
    noPlayerSeasonData: (n, s) => `No hay datos verificados del Manchester United para ${n} en ${s}.`,
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
    budgetExceeded:
      "Este sitio ha alcanzado su presupuesto de cómputo por hoy. No se calculó nada -- intenta de nuevo después de medianoche UTC.",
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
