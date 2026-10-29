import type { OpponentHistoryResult, HistoryRecord } from "../core/opponent-history";
import type { LocaleCode } from "../core/locale";
import { esc } from "./layout";

export interface OpponentHistoryStrings {
  opponent: string;
  title: string;
  context: string;
  season: string;
  played: string;
  wins: string;
  draws: string;
  losses: string;
  goalsFor: string;
  goalsAgainst: string;
  points: string;
  goalDifference?: string;
  pointsPerMatch?: string;
  combined: string;
  partial: string;
  unavailableSeasons?: string;
  missing: string;
  noMatches: string;
  failure: string;
  available: string;
  status: string;
  complete: string;
  source: string;
  attributionUnavailable: string;
  snapshot: string;
  chart: string;
  chartDescription: string;
  chartUnavailable: string;
  venueBoth: string;
  venueHome: string;
  venueAway: string;
  recordHeadline: string;
}

const defaultStrings: Record<LocaleCode, OpponentHistoryStrings> = {
  en: { opponent: "Opponent", title: "Opponent history", context: "Manchester United · Premier League · selected seasons", season: "Season", played: "Played", wins: "Wins", draws: "Draws", losses: "Losses", goalsFor: "Goals for", goalsAgainst: "Goals against", points: "Points", goalDifference: "Goal difference", pointsPerMatch: "Points / match", combined: "Combined record for selected seasons", partial: "Recorded subtotal; some selected data is missing or partial", unavailableSeasons: "History unavailable for requested seasons", missing: "Record unavailable; missing matches are not zero", noMatches: "No completed matches match this selection.", failure: "Opponent history is temporarily unavailable", available: "Available", status: "Status", complete: "Complete", source: "Sources and snapshot", attributionUnavailable: "Source attribution unavailable for some data.", snapshot: "Snapshot", chart: "Points per match by season", chartDescription: "Chart of observed points per match by selected season, on a scale from 0 to 3.", chartUnavailable: "No rate mark: season result is unavailable or no matches matched.", venueBoth: "All venues", venueHome: "Home", venueAway: "Away", recordHeadline: "{played} played · {won} won · {drawn} drawn · {lost} lost · {gf}–{ga}" },
  es: { opponent: "Rival", title: "Historial contra rivales", context: "Manchester United · Premier League · temporadas seleccionadas", season: "Temporada", played: "Jugados", wins: "Victorias", draws: "Empates", losses: "Derrotas", goalsFor: "Goles a favor", goalsAgainst: "Goles en contra", points: "Puntos", goalDifference: "Diferencia de goles", pointsPerMatch: "Puntos / partido", combined: "Balance conjunto de las temporadas seleccionadas", partial: "Subtotal registrado; faltan datos seleccionados o son parciales", unavailableSeasons: "Historial no disponible para las temporadas solicitadas", missing: "Balance no disponible; los partidos ausentes no equivalen a cero", noMatches: "Ningún partido finalizado coincide con esta selección.", failure: "El historial contra rivales no está disponible temporalmente", available: "Disponible", status: "Estado", complete: "Completa", source: "Fuentes y versión de datos", attributionUnavailable: "Atribución de fuente no disponible para algunos datos.", snapshot: "Versión de datos", chart: "Puntos por partido por temporada", chartDescription: "Gráfico de puntos por partido observados por temporada seleccionada, en una escala de 0 a 3.", chartUnavailable: "Sin marca de tasa: el resultado no está disponible o no hubo partidos coincidentes.", venueBoth: "Todas las localías", venueHome: "Local", venueAway: "Visitante", recordHeadline: "Jugados: {played} · Ganados: {won} · Empatados: {drawn} · Perdidos: {lost} · Goles: {gf}–{ga}" },
};

const unpublishedStrings: Record<LocaleCode, { title: string; message: string }> = {
  en: { title: "Opponent history", message: "Season splits capability is not published." },
  es: { title: "Historial contra rivales", message: "La capacidad de desgloses por temporada no está publicada." },
};

/** Localized state shown while the season_splits capability is not clear. */
export const opponentHistoryUnpublishedBody = (locale: LocaleCode): string =>
  `<h1>${esc(unpublishedStrings[locale].title)}</h1><p>${esc(unpublishedStrings[locale].message)}</p>`;

export interface OpponentHistoryView {
  result: OpponentHistoryResult;
  opponentLabel?: string;
  /** Credits resolved from the publication metadata for lineage references. */
  credits: Readonly<Record<string, string>>;
  strings?: OpponentHistoryStrings;
}

const recordCells = (record: HistoryRecord | undefined, locale: LocaleCode): string => {
  if (!record) return `<td colspan="9">—</td>`;
  const n = (value: number) => new Intl.NumberFormat(locale === "es" ? "es-ES" : "en-GB").format(value);
  const rate = record.points_per_match;
  const formattedRate = rate === null ? "—" : new Intl.NumberFormat(locale === "es" ? "es-ES" : "en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(rate);
  return [record.played, record.won, record.drawn, record.lost, record.goals_for, record.goals_against, record.points, record.goal_difference].map(v => `<td>${n(v)}</td>`).join("") + `<td>${formattedRate}</td>`;
};

/** Accessible server-rendered history chart with a complete semantic table fallback. */
export function opponentHistoryBody(model: OpponentHistoryView, locale: LocaleCode): string {
  const s = model.strings ?? defaultStrings[locale];
  const result = model.result;
  const opponent = model.opponentLabel ?? result.request.opponent_id ?? s.opponent;
  const venue = result.request.venue === "home" ? s.venueHome : result.request.venue === "away" ? s.venueAway : s.venueBoth;
  const selectedSeasons = result.seasons.map(x => x.season);
  const partial = result.partial;
  const unavailableSeasons = result.seasons.filter(entry => entry.coverage === "missing").map(entry => entry.season);
  const summary = `${s.context} · ${esc(opponent)} · ${esc(venue)} · ${esc(selectedSeasons.join(", "))}`;
  const rows = result.seasons.map(entry => {
    const state = entry.record ? (entry.coverage === "complete" ? s.available : s.partial) : entry.status === "no_matches" ? s.noMatches : s.missing;
    return `<tr><th scope="row">${esc(entry.season)}</th>${recordCells(entry.record, locale)}<td>${esc(state)}</td></tr>`;
  });
  const combinedState = result.combined ? (result.partial ? s.partial : s.available) : result.status === "no_matches" ? s.noMatches : s.missing;
  rows.push(`<tr><th scope="row">${esc(s.combined)}</th>${recordCells(result.combined, locale)}<td>${esc(combinedState)}</td></tr>`);
  const headers = [s.season, s.played, s.wins, s.draws, s.losses, s.goalsFor, s.goalsAgainst, s.points, s.goalDifference ?? defaultStrings[locale].goalDifference, s.pointsPerMatch ?? defaultStrings[locale].pointsPerMatch, s.status] as string[];
  const total = result.combined;
  const headlineNumbers: Record<string, number> | undefined = total && total.played > 0
    ? { played: total.played, won: total.won, drawn: total.drawn, lost: total.lost, gf: total.goals_for, ga: total.goals_against } : undefined;
  const headline = headlineNumbers
    ? `<p id="h2h-record">${esc(s.recordHeadline.replace(/\{(\w+)\}/g, (_m, key: string) => new Intl.NumberFormat(locale === "es" ? "es-ES" : "en-GB").format(headlineNumbers[key] ?? 0)))}${partial ? ` · ${esc(s.partial)}` : ""}</p>` : "";
  const table = `<div class="comparison-table opponent-history-table" role="region" tabindex="0" aria-label="${esc(s.title)}"><table aria-describedby="h2h-summary"><caption>${esc(s.title)}${partial ? ` · ${esc(s.partial)}` : ""}</caption><thead><tr>${headers.map(h => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  const scaleY = (v: number) => 74 - Math.max(0, Math.min(3, v)) * 20;
  const plot = result.seasons.map((entry, i) => {
    const x = 42 + i * 54;
    const label = esc(entry.season);
    const value = entry.record?.points_per_match;
    const caption = value === null || value === undefined ? (entry.coverage === "partial" || entry.coverage === "missing" ? s.missing : s.noMatches) : new Intl.NumberFormat(locale === "es" ? "es-ES" : "en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
    const bar = value === null || value === undefined ? `<text x="${x}" y="44" text-anchor="middle">${esc(entry.status === "no_matches" ? s.noMatches : s.missing)}</text>` : value === 0 ? `<circle cx="${x}" cy="74" r="3" class="zero-mark"/><text x="${x}" y="65" text-anchor="middle">${esc(caption)}</text>` : `<rect x="${x - 12}" y="${scaleY(value)}" width="24" height="${Math.max(0, 60 - scaleY(value))}" class="bar"/><text x="${x}" y="${scaleY(value) - 4}" text-anchor="middle">${esc(caption)}</text>`;
    return `${bar}<text x="${x}" y="88" text-anchor="middle">${label.slice(0, 7)}</text>`;
  }).join("");
  const chartDesc = `${s.chartDescription} ${s.opponent}: ${opponent}. ${s.season}: ${selectedSeasons.join(", ")}. ${s.chart}: ${venue}. ${result.seasons.map(entry => {
    const rate = entry.record?.points_per_match;
    const description = rate == null ? (entry.status === "no_matches" ? s.noMatches : s.missing) : `${new Intl.NumberFormat(locale === "es" ? "es-ES" : "en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(rate)} ${s.pointsPerMatch ?? defaultStrings[locale].pointsPerMatch}`;
    const limitation = entry.coverage === "partial" ? s.partial : entry.coverage === "missing" ? s.missing : "";
    return `${entry.season}: ${description}${limitation ? `, ${limitation}` : ""}`;
  }).join("; ")}. ${s.combined}: ${result.combined ? (result.combined.points_per_match === null ? s.missing : `${new Intl.NumberFormat(locale === "es" ? "es-ES" : "en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(result.combined.points_per_match)} ${s.pointsPerMatch ?? defaultStrings[locale].pointsPerMatch}`) : result.status === "no_matches" ? s.noMatches : s.missing}${partial ? `, ${s.partial}` : ""}.`;
  const chart = `<figure><figcaption>${esc(s.chart)}</figcaption><svg viewBox="0 0 ${Math.max(300, result.seasons.length * 54 + 24)} 100" role="img" aria-labelledby="h2h-chart-title h2h-chart-desc"><title id="h2h-chart-title">${esc(s.chart)}</title><desc id="h2h-chart-desc">${esc(chartDesc)}</desc><line x1="30" y1="74" x2="100%" y2="74" class="zero-axis"/>${plot}</svg></figure>`;
  const lineage = [...new Set(result.seasons.flatMap(entry => entry.record?.lineage ?? []))];
  const credit = (ref: string) => Object.hasOwn(model.credits, ref) && typeof model.credits[ref] === "string" && model.credits[ref]!.trim() ? model.credits[ref] : undefined;
  const credits = [...new Set(lineage.map(credit).filter((x): x is string => typeof x === "string"))];
  const sources = `<section aria-label="${esc(s.source)}"><h2>${esc(s.source)}</h2>${credits.map(c => `<p>${esc(c)}</p>`).join("")}${lineage.some(ref => !credit(ref)) ? `<p>${esc(s.attributionUnavailable)}</p>` : ""}<p>${esc(s.snapshot)}: ${esc(result.snapshot_id)}</p></section>`;
  const unavailableNote = unavailableSeasons.length
    ? `<p role="note">${esc(s.unavailableSeasons ?? defaultStrings[locale].unavailableSeasons!)}: ${esc(unavailableSeasons.join(", "))}</p>` : "";
  return `<h1>${esc(s.title)}: ${esc(opponent)}</h1><p id="h2h-summary">${summary}</p>${headline}${partial ? `<p role="note">${esc(s.partial)}</p>` : ""}${unavailableNote}${result.status === "missing_capability" ? `<p role="status">${esc(s.missing)}</p>` : ""}${chart}${table}${sources}`;
}
