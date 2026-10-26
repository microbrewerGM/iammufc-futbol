import type { SeasonSplitGroup, SeasonSplitRequest, SeasonSplitResult } from "../core/season-splits";
import { formatNumber, type Locale } from "../core/locale";
import { esc } from "./layout";

/** Raw GET controls are preserved on validation errors; B14-WIRE validates them. */
export interface SeasonSplitSelection {
  seasons: string[]; group_by: string; venue: string; opponent_id: string;
}
export interface SeasonSplitView {
  selection: SeasonSplitSelection;
  seasons: string[];
  opponents: { opponent_id: string; label: string }[];
  result?: SeasonSplitResult;
  error?: string;
  /** Localized credits resolved from lineage by the publication adapter. */
  credits: Readonly<Record<string, string>>;
}
export function seasonSplitSelection(request: SeasonSplitRequest): SeasonSplitSelection {
  return { seasons: [...request.seasons], group_by: request.group_by,
    venue: request.venue ?? "", opponent_id: request.opponent_id ?? "" };
}
/** Body fragment only. B14-WIRE owns routes, canonical links and the page shell. */
export function seasonSplitsBody(model: SeasonSplitView, locale: Locale): string {
  const t = (en: string, es: string) => locale.code === "es" ? es : en;
  const title = t("Explore season performance", "Explorar el rendimiento por temporada");
  const s = model.selection;
  const result = model.error ? undefined : model.result;
  const venueName = (key: string) => key === "home" ? t("Home", "Local") : t("Away", "Visitante");
  const opponentName = (key: string) => model.opponents.find(o => o.opponent_id === key)?.label ?? key;
  const select = (id: string, label: string, choices: [string, string][], selected: string) => {
    const all = choices.some(([v]) => v === selected) ? choices : [...choices, [selected, selected] as [string, string]];
    return `<label for="splits-${id}">${label}</label><select id="splits-${id}" name="${id}">${all.map(([v, text]) => `<option value="${esc(v)}"${v === selected ? " selected" : ""}>${esc(text)}</option>`).join("")}</select>`;
  };
  const seasons = [...new Set([...model.seasons, ...s.seasons])].sort();
  const form = `<form method="get" action="/${locale.code}/seasons/explore">
    <input type="hidden" name="schema_version" value="1"><input type="hidden" name="competition" value="PL">
    <fieldset><legend>${t("Seasons (choose 1–16)", "Temporadas (elige 1–16)")}</legend>${seasons.map((v, i) => `<label for="splits-season-${i}"><input id="splits-season-${i}" type="checkbox" name="seasons" value="${esc(v)}"${s.seasons.includes(v) ? " checked" : ""}>${esc(v)}</label>`).join("")}</fieldset>
    ${select("group_by", t("Group by", "Agrupar por"), [["venue", t("Home and away", "Local y visitante")], ["opponent", t("Opponent", "Rival")]], s.group_by)}
    ${select("venue", t("Venue", "Localía"), [["", t("All venues", "Todas las localías")], ["home", venueName("home")], ["away", venueName("away")]], s.venue)}
    ${select("opponent_id", t("Opponent", "Rival"), [["", t("All opponents", "Todos los rivales")], ...model.opponents.map(o => [o.opponent_id, o.label] as [string, string])], s.opponent_id)}
    <button type="submit">${t("Explore seasons", "Explorar temporadas")}</button></form>`;
  const method = `<p id="splits-method">${t("Manchester United · Premier League. Completed matches only. Points = 3 × wins + draws. Rates divide totals by the same played matches; they are not schedule-adjusted.", "Manchester United · Premier League. Solo partidos finalizados. Puntos = 3 × victorias + empates. Las tasas dividen los totales entre los mismos partidos jugados; no se ajustan al calendario.")}</p>`;
  if (!result) return `<h1>${title}</h1>${model.error ? `<p role="alert">${esc(model.error)}</p>` : ""}${form}${method}`;
  const num = (value: number | null, digits = 0) => value === null
    ? `<span aria-label="${t("Missing data", "Datos ausentes")}">—</span>` : formatNumber(value, digits, locale.code);
  const coverageLabel = { complete: t("Complete", "Completa"), partial: t("Partial schedule", "Calendario parcial"), missing: t("Missing split coverage", "Sin cobertura de desgloses") };
  const partial = result.partial ? `<p id="splits-warning" role="note">${t("Partial schedule: these are partial subtotals. Missing matches are not zero; rates describe only the matches available.", "Calendario parcial: son subtotales parciales. Los partidos ausentes no equivalen a cero; las tasas describen solo los partidos disponibles.")}</p>` : "";
  const summary = `<p id="splits-summary">${esc(result.request.seasons.join(", "))} · ${t("Group by", "Agrupar por")}: ${result.request.group_by === "venue" ? t("Home and away", "Local y visitante") : t("Opponent", "Rival")} · ${result.request.venue === null ? t("All venues", "Todas las localías") : venueName(result.request.venue)} · ${result.request.opponent_id === null ? t("All opponents", "Todos los rivales") : esc(opponentName(result.request.opponent_id))}</p>`;
  const coverage = `<ul aria-label="${t("Season coverage", "Cobertura por temporada")}">${result.coverage.map(c => `<li>${esc(c.season)}: ${coverageLabel[c.coverage]}</li>`).join("")}</ul>`;
  const headers = [result.request.group_by === "venue" ? t("Venue", "Localía") : t("Opponent", "Rival"), t("Played", "Jugados"), t("Wins", "Victorias"), t("Draws", "Empates"), t("Losses", "Derrotas"), t("Goals for", "Goles a favor"), t("Goals against", "Goles en contra"), t("Goal difference", "Diferencia de goles"), t("Points", "Puntos"), t("Points / match", "Puntos / partido"), t("Goals for / match", "Goles a favor / partido"), t("Goals against / match", "Goles en contra / partido"), t("Win rate (%)", "Victorias (%)"), t("Contributing seasons", "Temporadas con datos")];
  const rows = result.groups.map(g => `<tr><th scope="row">${esc(result.request.group_by === "venue" ? venueName(g.key) : opponentName(g.key))}</th>${[g.played, g.won, g.drawn, g.lost, g.goals_for, g.goals_against, g.goal_difference, g.points].map(v => `<td>${num(v)}</td>`).join("")}<td>${num(g.points_per_match, 2)}</td><td>${num(g.goals_for_per_match, 2)}</td><td>${num(g.goals_against_per_match, 2)}</td><td>${num(g.win_rate === null ? null : 100 * g.win_rate, 2)}</td><td>${esc(g.contributing_seasons.join(", "))}</td></tr>`).join("");
  const sum = (pick: (g: SeasonSplitGroup) => number) => result.groups.reduce((a, g) => a + pick(g), 0);
  const totalRow = (): string => {
    const [played, won, drawn, lost, gf, ga, gd, points] = [sum(g => g.played), sum(g => g.won), sum(g => g.drawn), sum(g => g.lost), sum(g => g.goals_for), sum(g => g.goals_against), sum(g => g.goal_difference), sum(g => g.points)];
    const per = (v: number) => played > 0 ? v / played : null;
    const winRate = per(won);
    const seasonsUsed = [...new Set(result.groups.flatMap(g => g.contributing_seasons))].sort();
    const label = `${t("All matches", "Todos los partidos")}${result.partial ? ` · ${t("partial subtotals", "subtotales parciales")}` : ""}`;
    return `<tr><th scope="row">${label}</th>${[played, won, drawn, lost, gf, ga, gd, points].map(v => `<td>${num(v)}</td>`).join("")}<td>${num(per(points), 2)}</td><td>${num(per(gf), 2)}</td><td>${num(per(ga), 2)}</td><td>${num(winRate === null ? null : 100 * winRate, 2)}</td><td>${esc(seasonsUsed.join(", "))}</td></tr>`;
  };
  const total = result.request.group_by === "venue" && result.groups.length ? totalRow() : "";
  const table = result.groups.length ? `<div class="comparison-table" role="region" tabindex="0" aria-label="${title}"><table aria-describedby="splits-summary splits-method${result.partial ? " splits-warning" : ""}"><caption>${t("Season performance", "Rendimiento por temporada")}${result.partial ? ` · ${t("partial subtotals", "subtotales parciales")}` : ""}</caption><thead><tr>${headers.map(h => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody>${rows}${total}</tbody></table></div>` : `<p>${result.status === "no_matches" ? t("No completed matches match this selection.", "Ningún partido finalizado coincide con esta selección.") : t("Split coverage is unavailable for this selection. No zero-match total is implied.", "La cobertura de desgloses no está disponible para esta selección. No se afirma un total de cero partidos.")}</p>`;
  const lineage = [...new Set(result.groups.flatMap(g => g.lineage))];
  const creditFor = (ref: string): string | undefined => {
    const value: unknown = Object.hasOwn(model.credits, ref) ? model.credits[ref] : undefined;
    return typeof value === "string" && value.trim() ? value : undefined;
  };
  const credits = [...new Set(lineage.map(creditFor).filter((v): v is string => v !== undefined))];
  const sources = `<section aria-label="${t("Sources and snapshot", "Fuentes y versión de datos")}"><h2>${t("Sources and snapshot", "Fuentes y versión de datos")}</h2>${credits.map(c => `<p>${esc(c)}</p>`).join("")}${!lineage.length || lineage.some(ref => creditFor(ref) === undefined) ? `<p>${t("Source attribution unavailable for some data.", "Atribución de fuente no disponible para algunos datos.")}</p>` : ""}<p>${t("Snapshot", "Versión de datos")}: ${esc(result.snapshot_id)}</p></section>`;
  return `<h1>${title}</h1>${form}${summary}${partial}${coverage}${table}${method}${sources}`;
}
