import type { PlayerRangeRequest, PlayerRangeResult } from "../core/player-range";
import { formatNumber, type Locale } from "../core/locale";
import { esc } from "./layout";

/** Raw GET selections survive validation errors. The route validates them before
 * calculating; this renderer never interprets them as a query or executable code. */
export interface PlayerRangeSelection {
  person_ids: string[]; seasons: string[]; metric: string;
  normalization: string; min_minutes: string; viz: string;
}
export interface PlayerRangeView {
  selection: PlayerRangeSelection;
  people: { person_id: string; label: string }[];
  seasons: string[];
  result?: PlayerRangeResult;
  error?: string;
  /** Human-readable credits resolved by the adapter from each lineage reference. */
  credits: Readonly<Record<string, string>>;
}
export function playerRangeSelection(request: PlayerRangeRequest): PlayerRangeSelection {
  return { ...request, min_minutes: String(request.min_minutes) };
}

/** Body fragment only: B13-WIRE owns validated routes, canonical links and shell. */
export function playerRangeBody(model: PlayerRangeView, locale: Locale): string {
  const es = locale.code === "es";
  const t = (en: string, spanish: string) => es ? spanish : en;
  const s = model.selection;
  const result = model.error ? undefined : model.result;
  const name = (id: string) => model.people.find(p => p.person_id === id)?.label ?? id;
  const number = (value: number | null, digits = 0) => value === null
    ? `<span aria-label="${t("Missing data", "Datos ausentes")}">—</span>`
    : formatNumber(value, digits, locale.code);
  const option = (value: string, label: string, selected: boolean) =>
    `<option value="${esc(value)}"${selected ? " selected" : ""}>${esc(label)}</option>`;
  const select = (id: string, label: string, choices: [string, string][], selected: string) => {
    const all = choices.some(([value]) => value === selected) ? choices : [...choices, [selected, selected] as [string, string]];
    return `<label for="range-${id}">${label}</label><select id="range-${id}" name="${id}">${all.map(([value, text]) => option(value, text, value === selected)).join("")}</select>`;
  };
  const people = [...new Set([...model.people.map(p => p.person_id), ...s.person_ids])];
  const seasons = [...new Set([...model.seasons, ...s.seasons])].sort();
  const form = `<form method="get" action="/${locale.code}/compare/players">
    <input type="hidden" name="schema_version" value="1"><input type="hidden" name="competition" value="PL">
    <fieldset><legend>${t("Players (choose 2–5)", "Jugadores (elige 2–5)")}</legend>${people.map((id, index) =>
      `<label for="range-person-${index}"><input id="range-person-${index}" type="checkbox" name="person_ids" value="${esc(id)}"${s.person_ids.includes(id) ? " checked" : ""}>${esc(name(id))}</label>`).join("")}</fieldset>
    <fieldset><legend>${t("Seasons (choose 1–8)", "Temporadas (elige 1–8)")}</legend>${seasons.map((season, index) =>
      `<label for="range-season-${index}"><input id="range-season-${index}" type="checkbox" name="seasons" value="${esc(season)}"${s.seasons.includes(season) ? " checked" : ""}>${esc(season)}</label>`).join("")}</fieldset>
    ${select("metric", t("Metric", "Métrica"), [["goals", t("Goals", "Goles")], ["assists", t("FPL assists", "Asistencias FPL")]], s.metric)}
    ${select("normalization", t("Compare", "Comparar"), [["total", t("Totals", "Totales")], ["per90", t("Per 90", "Por 90")]], s.normalization)}
    <label for="range-minutes">${t("Minimum minutes", "Minutos mínimos")}</label><input id="range-minutes" name="min_minutes" type="text" inputmode="numeric" pattern="[0-9]+" value="${esc(s.min_minutes)}" required aria-describedby="range-method">
    ${select("viz", t("Display", "Vista"), [["table", t("Table", "Tabla")], ["bar", t("Bars and table", "Barras y tabla")]], s.viz)}
    <button type="submit">${t("Compare players", "Comparar jugadores")}</button>
  </form>`;
  const title = t("Compare players across seasons", "Comparar jugadores entre temporadas");
  const method = `<p id="range-method">${t("Premier League contributions for Manchester United. Per 90 = 90 × supported total ÷ the same rows’ minutes. Minimum minutes: 0–20000 (default 450 for per 90); this is adjustable, not a significance threshold. Partial subtotals are excluded from ranking.", "Aportaciones en la Premier League con el Manchester United. Por 90 = 90 × total con datos ÷ minutos de las mismas filas. Minutos mínimos: 0–20000 (450 por defecto para por 90); es ajustable, no un umbral de significación. Los subtotales parciales se excluyen de la clasificación.")}</p>`;
  if (!result) return `<h1>${title}</h1>${model.error ? `<p role="alert">${esc(model.error)}</p>` : ""}${form}${method}`;
  const metric = result.definition === "fpl_assists" ? t("FPL assists", "Asistencias FPL") : t("Goals", "Goles");
  const reasons = {
    partial_subtotal: t("Partial subtotal — excluded from ranking", "Subtotal parcial — excluido de la clasificación"),
    no_supported_rows: t("No supported rows", "Sin filas con datos suficientes"),
    zero_minutes: t("Per 90 unavailable: zero minutes", "Por 90 no disponible: cero minutos"),
    below_minimum: t("Below minimum minutes", "Por debajo del mínimo de minutos"),
  };
  const summary = `<p id="range-summary">${esc(metric)} · ${esc(result.request.seasons.join(", "))} · ${result.players.length} ${t("selected players", "jugadores seleccionados")} · ${result.ranked_person_ids.length} ${t("comparable players", "jugadores comparables")}.</p>`;
  const rows = result.players.map(player => `<tr><th scope="row">${esc(name(player.person_id))}</th>
    <td>${player.comparable ? result.ranked_person_ids.indexOf(player.person_id) + 1 : "—"}</td>
    <td>${number(player.total)}${player.partial ? ` (${t("partial subtotal", "subtotal parcial")})` : ""}</td>
    <td>${number(player.eligible_minutes)}</td><td>${number(player.rate, 2)}</td>
    <td>${player.reasons.length ? player.reasons.map(r => reasons[r]).join("; ") : t("Comparable", "Comparable")}</td>
    <td>${player.cells.map(cell => `${esc(cell.season)}: ${number(cell.total)} / ${number(cell.minutes)} ${t("minutes", "minutos")}${cell.reason === "supported" ? "" : ` — ${cell.reason === "missing_row" ? t("Missing row", "Fila ausente") : t("Incomplete metric or minutes", "Métrica o minutos incompletos")}`}`).join("<br>")}</td></tr>`).join("");
  const table = `<div class="comparison-table" role="region" tabindex="0" aria-label="${title}"><table aria-describedby="range-summary range-method"><caption>${esc(metric)} · ${t("Totals, minutes and per 90", "Totales, minutos y por 90")}</caption>
    <thead><tr>${[t("Player", "Jugador"), t("Rank", "Posición"), t("Total", "Total"), t("Supported minutes", "Minutos con datos"), t("Per 90", "Por 90"), t("Coverage", "Cobertura"), t("Season detail: total / minutes", "Detalle por temporada: total / minutos")].map(h => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
  const comparable = result.ranked_person_ids.map(id => result.players.find(p => p.person_id === id)!);
  const maximum = Math.max(1, ...comparable.map(p => p.value ?? 0));
  const bars = result.request.viz === "bar" ? `<section aria-label="${t("Comparable player bars", "Barras de jugadores comparables")}"><h2>${t("Comparable players", "Jugadores comparables")} · ${esc(metric)} · ${result.request.normalization === "per90" ? t("Per 90", "Por 90") : t("Totals", "Totales")}</h2>${comparable.length ? comparable.map(p => `<p>${esc(name(p.person_id))}: <meter min="0" max="${maximum}" value="${p.value ?? 0}" aria-label="${esc(name(p.person_id))}">${number(p.value, 2)}</meter> ${number(p.value, result.request.normalization === "per90" ? 2 : 0)}</p>`).join("") : `<p>${t("No comparable players", "No hay jugadores comparables")}</p>`}</section>` : "";
  const lineage = [...new Set(result.players.flatMap(p => p.lineage))];
  const creditFor = (ref: string): string | undefined => {
    const value: unknown = Object.hasOwn(model.credits, ref) ? model.credits[ref] : undefined;
    return typeof value === "string" && value.trim() ? value : undefined;
  };
  const credits = [...new Set(lineage.map(creditFor).filter((credit): credit is string => credit !== undefined))];
  const attribution = `<section aria-label="${t("Sources and snapshot", "Fuentes y versión de datos")}"><h2>${t("Sources and snapshot", "Fuentes y versión de datos")}</h2>${credits.map(credit => `<p>${esc(credit)}</p>`).join("")}${!lineage.length || lineage.some(ref => creditFor(ref) === undefined) ? `<p>${t("Source attribution unavailable for some data.", "Atribución de fuente no disponible para algunos datos.")}</p>` : ""}<p>${t("Snapshot", "Versión de datos")}: ${esc(result.snapshot_id)}</p></section>`;
  const definition = result.definition === "fpl_assists" ? `<p>${t("Assists use FPL definitions, which changed in 2025–26. Comparing across that boundary requires care.", "Las asistencias siguen las definiciones FPL, que cambiaron en 2025–26. Compara con cuidado entre ambos periodos.")}</p>` : "";
  return `<h1>${title}</h1>${form}${summary}${bars}${table}${method}${definition}${attribution}`;
}
