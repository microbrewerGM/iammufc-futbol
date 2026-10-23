import type { Per90LeadersResult, PlayerTrendSeries, PlayerTrendsRequest } from "../core/player-trends";
import { formatNumber, type Locale } from "../core/locale";
import { esc } from "./layout";

export interface PlayerTrendsView {
  request: PlayerTrendsRequest;
  snapshot_id: string;
  definition: "goals" | "fpl_assists";
  series: PlayerTrendSeries[];
  people: { person_id: string; label: string }[];
  credits: Readonly<Record<string, string>>;
  leaders?: Per90LeadersResult;
}

/** Render a bounded trend result and its optional single-season per-90 leaderboard. */
export function playerTrendsBody(model: PlayerTrendsView, strings: Readonly<Record<string, string>>, locale: Locale): string {
  const tr = (key: string, fallback: string) => strings[key] ?? fallback;
  const t = (en: string, es: string) => locale.code === "es" ? es : en;
  const name = (id: string) => model.people.find(p => p.person_id === id)?.label ?? id;
  const safeName = (id: string) => esc(name(id));
  const n = (value: number | null, digits = 0) => value === null
    ? `<span aria-label="${esc(tr("missing", t("Data unavailable", "Datos no disponibles")))}">—</span>`
    : formatNumber(value, digits, locale.code);
  const metric = model.definition === "fpl_assists"
    ? tr("assists", t("FPL assists", "Asistencias FPL"))
    : tr("goals", t("Goals", "Goles"));
  const heading = tr("heading", t("Player trends", "Evolución de jugadores"));
  const seasons = model.request.seasons;
  const allCells = model.series.flatMap(s => s.cells);
  const hasGaps = allCells.some(c => c.reason === "missing_row" || c.reason === "missing_numerator" || c.reason === "missing_minutes" || c.reason === "zero_minutes");
  const range = seasons.length === 1 ? seasons[0]! : `${seasons[0]}–${seasons[seasons.length - 1]}`;
  const alt = `${heading}: ${model.series.map(s => name(s.person_id)).join(", ")}; ${metric}; ${range}${hasGaps ? `; ${t("gaps", "hay datos no disponibles")}` : model.request.normalization === "per90" && allCells.some(c => c.reason === "below_minimum") ? `; ${t("below minimum minutes", "por debajo del mínimo de minutos")}` : ""}.`;
  const reasonLabel = (reason: string) => ({
    supported: tr("supported", t("Available", "Disponible")),
    missing_row: tr("missing_row", t("Data unavailable", "Datos no disponibles")),
    missing_numerator: tr("missing_numerator", t("Metric unavailable", "Métrica no disponible")),
    missing_minutes: tr("missing_minutes", t("Minutes unavailable", "Minutos no disponibles")),
    zero_minutes: tr("zero_minutes", t("No positive minutes", "Sin minutos positivos")),
    below_minimum: tr("below_minimum", t("Below minimum minutes", "Por debajo del mínimo de minutos")),
  } as Record<string, string>)[reason] ?? tr("missing", t("Data unavailable", "Datos no disponibles"));

  const seriesMarkup = model.series.map(series => {
    const cells = series.cells;
    const points = cells.map((cell, index) => {
      const value = model.request.normalization === "per90" ? cell.rate : cell.total;
      return value === null ? null : { index, value };
    }).filter((p): p is { index: number; value: number } => p !== null);
    const max = Math.max(1, ...points.map(p => p.value));
    const coords = points.map(p => `${(cells.length === 1 ? 50 : 4 + 92 * p.index / (cells.length - 1)).toFixed(2)},${(96 - 76 * p.value / max).toFixed(2)}`);
    const line = coords.length > 1 ? `<polyline points="${coords.join(" ")}" fill="none" stroke="currentColor" stroke-width="2" />` : "";
    const markers = points.map(p => `<circle cx="${(cells.length === 1 ? 50 : 4 + 92 * p.index / (cells.length - 1)).toFixed(2)}" cy="${(96 - 76 * p.value / max).toFixed(2)}" r="2.5"><title>${esc(cells[p.index]!.season)}: ${n(p.value, model.request.normalization === "per90" ? 2 : 0)}</title></circle>`).join("");
    const gaps = cells.map((cell, index) => cell.reason === "missing_row" || cell.reason === "missing_numerator" || cell.reason === "missing_minutes" || cell.reason === "zero_minutes"
      ? `<text x="${(cells.length === 1 ? 50 : 4 + 92 * index / (cells.length - 1)).toFixed(2)}" y="98" text-anchor="middle" aria-label="${esc(reasonLabel(cell.reason))}">×</text>` : "").join("");
    return `<figure><figcaption>${safeName(series.person_id)}</figcaption><svg viewBox="0 0 100 100" role="img" aria-label="${esc(alt)}"><title>${esc(alt)}</title><desc>${esc(t("Gaps break the line; the table gives each season and reason.", "Los datos ausentes interrumpen la línea; la tabla muestra cada temporada y motivo."))}</desc>${line}${markers}${gaps}</svg></figure>`;
  }).join("");

  const columns = [
    tr("player", t("Player", "Jugador")), tr("season", t("Season", "Temporada")), metric,
    tr("minutes", t("Minutes played", "Minutos jugados")),
    model.request.normalization === "per90" ? tr("rate", t("Output per 90 minutes", "Producción por 90 minutos")) : tr("status", t("Status", "Estado")),
    tr("reason", t("Coverage", "Cobertura")),
  ];
  const rows = model.series.flatMap(series => series.cells.map(cell => {
    const reason = reasonLabel(cell.reason);
    return `<tr><th scope="row">${safeName(series.person_id)}</th><td>${esc(cell.season)}</td><td>${n(cell.total)}</td><td>${n(cell.minutes)}</td><td>${model.request.normalization === "per90" ? n(cell.rate, 2) : esc(reason)}</td><td>${esc(reason)}</td></tr>`;
  })).join("");
  const tableLabel = tr("table", t("Season by season values and availability", "Valores y disponibilidad por temporada"));
  const table = `<div role="region" tabindex="0" aria-label="${esc(tableLabel)}"><table><caption>${esc(tableLabel)}</caption><thead><tr>${columns.map(c => `<th scope="col">${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
  const chart = model.request.viz === "line"
    ? `<section aria-label="${esc(heading)}"><h2>${esc(heading)}</h2><p class="trend-alt">${esc(alt)}</p>${model.series.some(s => s.cells.filter(c => c.reason === "supported").length >= 2) ? seriesMarkup : `<p>${esc(tr("insufficient", t("Not enough points for a trend", "No hay suficientes puntos para mostrar una evolución")))}</p>`}</section>` : "";
  const threshold = model.request.normalization === "per90"
    ? `<p>${esc(tr("threshold", t("Minimum minutes per season", "Minutos mínimos por temporada")))}: ${n(model.request.min_minutes)}.</p>` : "";
  const belowCount = allCells.filter(c => c.reason === "below_minimum").length;
  const eligibility = belowCount ? `<p>${belowCount} ${esc(tr("below_minimum", t("Below minimum minutes", "Por debajo del mínimo de minutos")))}. ${esc(t("These seasons are excluded from the rate.", "Estas temporadas se excluyen de la tasa."))}</p>` : "";
  const lineage = [...new Set(allCells.flatMap(c => c.lineage))];
  const creditFor = (ref: string) => typeof model.credits[ref] === "string" && model.credits[ref]!.trim() ? model.credits[ref]! : undefined;
  const credits = [...new Set(lineage.map(creditFor).filter((x): x is string => !!x))];
  const attribution = `<section aria-label="${esc(tr("attribution", t("Sources and snapshot", "Fuentes y versión de datos")))}"><h2>${esc(tr("attribution", t("Sources and snapshot", "Fuentes y versión de datos")))}</h2>${credits.map(c => `<p>${esc(c)}</p>`).join("")}${(!lineage.length || lineage.some(ref => !creditFor(ref))) ? `<p>${esc(tr("credit_missing", t("Source attribution unavailable for some data.", "Atribución de fuente no disponible para algunos datos.")))}</p>` : ""}<p>${esc(t("Snapshot", "Versión de datos"))}: ${esc(model.snapshot_id)}</p></section>`;
  const definition = model.definition === "fpl_assists" ? `<p>${esc(t("Assists use FPL definitions, which changed in 2025–26. Comparing across that boundary requires care.", "Las asistencias siguen las definiciones FPL, que cambiaron en 2025–26. Compara con cuidado entre ambos periodos."))}</p>` : "";

  let leaderboard = "";
  if (model.leaders) {
    const l = model.leaders;
    const leaderRows = l.leaders.map((p, i) => `<tr><td>${i + 1}</td><th scope="row">${safeName(p.person_id)}</th><td>${n(p.total)}</td><td>${n(p.minutes)}</td><td>${n(p.rate, 2)}</td></tr>`).join("");
    const excludedRows = l.excluded.map(p => `<tr><th scope="row">${safeName(p.person_id)}</th><td>${esc(reasonLabel(p.reason))}</td></tr>`).join("");
    leaderboard = `<section aria-label="${esc(tr("leaderboard", t("Per-90 leaderboard", "Clasificación por 90 minutos")))}"><h2>${esc(tr("leaderboard", t("Per-90 leaderboard", "Clasificación por 90 minutos")))} · ${esc(l.season)}</h2><p>${esc(tr("threshold", t("Minimum minutes", "Minutos mínimos")))}: ${n(l.min_minutes)}. ${esc(t("Players below the threshold are excluded and listed.", "Los jugadores por debajo del mínimo se excluyen y se indican."))}</p><div role="region" tabindex="0" aria-label="${esc(tr("leaderboard", t("Per-90 leaderboard", "Clasificación por 90 minutos")))}"><table><thead><tr>${[t("Rank", "Posición"), t("Player", "Jugador"), metric, t("Minutes played", "Minutos jugados"), t("Per 90", "Por 90")].map(x => `<th scope="col">${esc(x)}</th>`).join("")}</tr></thead><tbody>${leaderRows}</tbody></table></div>${excludedRows ? `<h3>${esc(t("Excluded players", "Jugadores excluidos"))}</h3><table><thead><tr><th scope="col">${esc(t("Player", "Jugador"))}</th><th scope="col">${esc(t("Reason", "Motivo"))}</th></tr></thead><tbody>${excludedRows}</tbody></table>` : ""}</section>`;
  }
  return `<h1>${esc(heading)}</h1><p>${esc(metric)} · ${esc(range)}</p>${threshold}${eligibility}${chart}${table}${leaderboard}${definition}${attribution}`;
}
