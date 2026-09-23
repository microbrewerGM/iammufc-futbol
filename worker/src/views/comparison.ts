import type { ComparisonRequest, executeComparison } from "../core/comparison";
import { formatNumber, type Locale } from "../core/locale";
import { esc, html, page } from "./layout";

export function comparisonPage(
  request: ComparisonRequest,
  result: Awaited<ReturnType<typeof executeComparison>>,
  seasons: string[],
  locale: Locale,
): Response {
  const es = locale.code === "es";
  const title = es ? "Producción por 90 minutos" : "Output per 90 minutes";
  const metric =
    request.metric === "goals" ? (es ? "Goles" : "Goals") : es ? "Asistencias FPL" : "FPL assists";
  const query = new URLSearchParams({
    season: request.season,
    metric: request.metric,
    min_minutes: String(request.minMinutes),
  });
  const failures: Record<string, string> = {
    coverage_or_rights_unavailable: es
      ? "La cobertura o los permisos no permiten esta comparación."
      : "Coverage or rights do not permit this comparison.",
    inconsistent_snapshot: es
      ? "No se puede mostrar la comparación: las versiones de datos no coinciden."
      : "Comparison withheld: data snapshot versions are inconsistent.",
    no_rows: es
      ? "No hay datos integrados para esta temporada."
      : "No integrated rows are available for this season.",
  };
  const table =
    result.ok && result.rows.length
      ? `<div class="comparison-table" tabindex="0" role="region" aria-label="${esc(title)}"><table>
    <caption>${esc(metric)} · Premier League · ${esc(request.season)} · ${request.minMinutes} ${es ? "minutos mínimos" : "minimum minutes"}</caption>
    <thead><tr><th scope="col">${es ? "Jugador" : "Player"}</th><th scope="col">${es ? "Minutos" : "Minutes"}</th><th scope="col">${esc(metric)}</th><th scope="col">${es ? "Por 90" : "Per 90"}</th></tr></thead>
    <tbody>${result.rows
      .map(
        (row) =>
          `<tr><th scope="row">${esc(row.label)}</th><td>${row.minutes}</td><td>${row.total}</td><td>${formatNumber(row.rate, 2, locale.code)}</td></tr>`,
      )
      .join("")}</tbody></table></div>`
      : `<p role="status">${
          !result.ok
            ? failures[result.reason]
            : es
              ? "Ninguna fila comparable cumple estos requisitos. Los datos ausentes no son ceros."
              : "No comparable rows meet these requirements. Missing data is not zero."
        }</p>`;
  const body = `<h1>${title}</h1>
    <p>${es ? "Totales de temporada FPL de jugadores identificados con Manchester United en la captura de la fuente. No se ha verificado que excluyan aportaciones en otros clubes tras un traspaso." : "FPL season totals for players listed with Manchester United in the source snapshot. Totals are not verified to exclude contributions at other clubs after a transfer."}</p>
    <form method="get" action="/${locale.code}/compare">
      <label for="season">${es ? "Temporada" : "Season"}</label><select name="season" id="season">${[...new Set([request.season, ...seasons])]
        .sort()
        .reverse()
        .map(
          (season) =>
            `<option value="${esc(season)}"${season === request.season ? " selected" : ""}>${esc(season)}</option>`,
        )
        .join("")}</select>
      <label for="metric">${es ? "Métrica" : "Metric"}</label><select name="metric" id="metric"><option value="goals"${request.metric === "goals" ? " selected" : ""}>${es ? "Goles" : "Goals"}</option><option value="assists"${request.metric === "assists" ? " selected" : ""}>${es ? "Asistencias FPL" : "FPL assists"}</option></select>
      <label for="min_minutes">${es ? "Minutos mínimos" : "Minimum minutes"}</label><input type="number" name="min_minutes" id="min_minutes" min="0" max="20000" step="1" value="${request.minMinutes}" required>
      <button type="submit">${es ? "Comparar" : "Compare"}</button>
    </form>
    <p>${es ? "Fórmula: 90 × total ÷ minutos. El mínimo inicial de 450 minutos es ajustable, no un umbral de significación estadística. Ordenamos antes de redondear; los empates usan minutos y un identificador estable." : "Formula: 90 × total ÷ minutes. The default 450-minute minimum is adjustable, not a statistical-significance threshold. Ranking precedes rounding; ties use minutes then stable player ID."}</p>
    ${table}
    <p>${es ? "Las filas con métricas ausentes o minutos no positivos se excluyen. Las asistencias siguen las reglas FPL, que cambiaron en 2025–26. La ejecución nocturna no demuestra que la fuente esté actualizada." : "Rows with missing metrics or nonpositive minutes are excluded. Assists follow FPL rules, which changed in 2025–26. A nightly refresh does not prove that the source is current."}</p>
    <p><a href="/${locale.code}">${es ? "Volver a la cobertura" : "Back to coverage"}</a></p>`;
  return html(
    page(body, {
      title,
      locale,
      unprefixedPath: `/compare?${query}`,
      attribution: result.ok ? [result.attribution] : [],
      snapshotId: result.ok ? result.snapshot : null,
    }),
  );
}
