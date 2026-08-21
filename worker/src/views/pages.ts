import { barChartSvg, buildAltText, formatValue as formatValueEn } from "../core/chart";
import type { ResultRow, SeasonRecord, SeasonRow, SquadRow } from "../core/db";
import { columnFeasibility, type Catalog, type FeasibilityResult } from "../core/feasibility";
import type { QueryIntent } from "../core/intent";
import { formatNumber, metricLabel, positionLabel, type Locale } from "../core/locale";
import type { Proposal } from "../core/parser";
import { esc } from "./layout";

const EXAMPLES: Record<Locale["code"], string[]> = {
  en: [
    "Who scored the most for United in 2024-25?",
    "Top assists 2023-24",
    "Expected goals 2025-26",
    "Show me a shot map for 2024-25",
    "Progressive passes 2024-25",
  ],
  es: [
    "¿Quién anotó más para el United en 2024-25?",
    "Máximas asistencias 2023-24",
    "Goles esperados 2025-26",
    "Muéstrame un mapa de tiros de 2024-25",
    "Pases progresivos 2024-25",
  ],
};

function base(locale: Locale): string {
  return `/${locale.code}`;
}

export function chatForm(locale: Locale, question = ""): string {
  const t = locale.strings;
  return `<form method="post" action="${base(locale)}/ask">
<input type="text" name="q" value="${esc(question)}" placeholder="${esc(t.askPlaceholder)}" aria-label="${esc(t.askPlaceholder)}" required>
<button type="submit">${esc(t.askButton)}</button>
</form>`;
}

/** The parsed intent is shown before anything executes. Ambiguity becomes a
 *  correction opportunity instead of a wrong answer. */
export function intentPanel(proposal: Proposal, locale: Locale): string {
  const t = locale.strings;
  const i = proposal.intent;
  const lines = [
    `metric      ${i.metric}`,
    `entity      ${i.entity_type} = ${i.entity_id}`,
    `season      ${i.season}`,
    `competition ${i.competition}`,
    `viz         ${i.viz}`,
  ].join("\n");

  const notes = proposal.notes.length
    ? `<div class="note"><strong>${esc(t.assumptions)}</strong> ${proposal.notes.map(esc).join(" ")}</div>`
    : "";

  return `<h3>${esc(proposal.source === "ai" ? t.parsedAsAi : t.parsedAsRules)}</h3>
<div class="intent">${esc(lines)}</div>
${notes}`;
}

export function coverageMatrix(catalog: Catalog, locale: Locale): string {
  const t = locale.strings;
  const metrics = catalog.metrics;
  const seasons = [...new Set(catalog.coverage.map((c) => c.season))].sort().reverse();
  const index = new Map(catalog.coverage.map((c) => [`${c.metric}/${c.season}`, c] as const));

  const head = seasons.map((s) => `<th class="num">${esc(s)}</th>`).join("");
  const rows = metrics
    .map((m) => {
      const cells = seasons
        .map((s) => {
          const cell = index.get(`${m.metric_id}/${s}`);
          if (!cell) return `<td class="num no" title="${esc(t.legendNoSource)}">–</td>`;
          if (!cell.redistributable) {
            return `<td class="num no" title="${esc(cell.source_name)}: ${esc(t.legendNoRights)}">✕</td>`;
          }
          return `<td class="num yes" title="${esc(cell.source_name)}">●</td>`;
        })
        .join("");
      return `<tr><th scope="row">${esc(metricLabel(catalog, m.metric_id, locale.code))}</th>${cells}</tr>`;
    })
    .join("");

  return `<h2>${esc(t.coverageHeading)}</h2>
<p class="tagline">● ${esc(t.legendAvailable)} &nbsp; ✕ ${esc(t.legendNoRights)} &nbsp; – ${esc(t.legendNoSource)}</p>
<table class="matrix"><thead><tr><th>${esc(t.metricCol)}</th>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

function dataTable(
  rows: ResultRow[],
  metricLbl: string,
  decimals: number,
  season: string,
  locale: Locale,
): string {
  const t = locale.strings;
  const fmt = (v: number | null) => formatNumber(v, decimals, locale.code);
  const body = rows
    .map(
      (r) =>
        `<tr><td><a href="${base(locale)}/player/${encodeURIComponent(r.label)}/${esc(season)}">${esc(r.label)}</a></td>` +
        `<td>${esc(positionLabel(r.secondary ?? "", locale.code))}</td>` +
        `<td class="num">${esc(fmt(r.value))}</td></tr>`,
    )
    .join("");
  return `<h3>${esc(t.dataHeading)}</h3>
<table><thead><tr><th>${esc(t.playerCol)}</th><th>${esc(t.posCol)}</th><th class="num">${esc(metricLbl)}</th></tr></thead>
<tbody>${body}</tbody></table>`;
}

export function resultPanel(
  intent: QueryIntent,
  feasibility: FeasibilityResult,
  rows: ResultRow[],
  catalog: Catalog,
  artifactKey: string,
  locale: Locale,
): string {
  const t = locale.strings;
  const label = metricLabel(catalog, intent.metric, locale.code);
  const metric = catalog.metric(intent.metric);
  const decimals = metric?.decimals ?? 0;
  const fmt = (v: number | null, d: number) => formatNumber(v, d, locale.code);

  const alternative = feasibility.nearest_alternative
    ? `<form method="get" action="${base(locale)}/q">
<input type="hidden" name="metric" value="${esc(feasibility.nearest_alternative.metric)}">
<input type="hidden" name="season" value="${esc(feasibility.nearest_alternative.season)}">
<input type="hidden" name="viz" value="${esc(feasibility.nearest_alternative.viz)}">
<input type="hidden" name="entity_id" value="${esc(feasibility.nearest_alternative.entity_id)}">
<button class="secondary" type="submit">${esc(metricLabel(catalog, feasibility.nearest_alternative.metric, locale.code))} — ${esc(feasibility.nearest_alternative.season)}</button>
</form>`
    : "";

  // Refusals are first-class output, not error states. Naming which of the two
  // kinds of gap this is tells the user whether it could ever be closed.
  if (
    feasibility.state === "not_computable_data_missing" ||
    feasibility.state === "not_computable_no_rights"
  ) {
    const kind =
      feasibility.state === "not_computable_no_rights"
        ? locale.code === "es"
          ? "Tenemos una fuente para esto, pero no licencia para republicarla. Ese vacío necesita una licencia paga, no más ingeniería."
          : "We have a source for this, but no licence to republish it. That gap needs a paid licence, not more engineering."
        : locale.code === "es"
          ? "Ninguna fuente integrada provee esto. Ese vacío podría cerrarse si integramos una."
          : "No source we have integrated provides this. That gap could close if we integrate one.";
    return `<div class="stop">
<p class="state">${esc(feasibility.state)}</p>
<p><strong>${esc(feasibility.reason)}</strong></p>
<p>${esc(kind)}</p>
${alternative}
</div>`;
  }

  if (rows.length === 0) {
    const msg =
      locale.code === "es"
        ? "El catálogo dice que esto es respondible, pero la consulta no devolvió nada. Prueba con un apellido, o pide una clasificación."
        : "The catalog says this is answerable, but the query returned nothing. Try a surname, or ask for a ranking.";
    return `<div class="stop"><p class="state">no rows</p><p><strong>${esc(msg)}</strong></p></div>`;
  }

  const title = `${label} — ${intent.season} ${intent.competition}`;
  const altText = buildAltText(rows, { title, decimals, formatValue: fmt as typeof formatValueEn });
  const chart =
    intent.viz === "table"
      ? ""
      : barChartSvg(rows, { title, unit: intent.metric, decimals, altText, formatValue: fmt as typeof formatValueEn });

  return `<h2>${esc(title)}</h2>
${chart}
${dataTable(rows, label, decimals, intent.season, locale)}
<p class="tagline"><a href="${base(locale)}/season/${esc(intent.season)}">${esc(t.fullSquadFor(intent.season))}</a> ·
<code>${esc(artifactKey.slice(0, 16))}</code> — ${esc(t.artifactNote)}</p>`;
}

// ---------------------------------------------------------------------------
// Player career and season squad pages. Coverage is per (metric, season), not
// per row, so feasibility is looked up once per column via columnFeasibility
// -- never inferred, never fabricated, but not re-checked per player either.
// ---------------------------------------------------------------------------

const METRIC_ORDER = ["goals", "assists", "minutes", "points", "xg"] as const;

function metricHeadCells(catalog: Catalog, feas: Map<string, FeasibilityResult>, locale: Locale): string {
  return METRIC_ORDER.map((id) => {
    if (!catalog.metric(id)) return "";
    const ok = feas.get(id)?.state === "computable_now_queued" || feas.get(id)?.state === "available";
    const label = metricLabel(catalog, id, locale.code);
    return `<th class="num"${ok ? "" : ` title="${esc(locale.strings.legendNoSource)}"`}>${esc(label)}</th>`;
  }).join("");
}

function metricValueCells(
  catalog: Catalog,
  feas: Map<string, FeasibilityResult>,
  values: Partial<Record<(typeof METRIC_ORDER)[number], number | null>>,
  locale: Locale,
): string {
  return METRIC_ORDER.map((id) => {
    const m = catalog.metric(id);
    if (!m) return "";
    const f = feas.get(id);
    const ok = f?.state === "computable_now_queued" || f?.state === "available";
    if (!ok) {
      const why = f?.state === "not_computable_no_rights" ? locale.strings.legendNoRights : locale.strings.legendNoSource;
      return `<td class="num no" title="${esc(f?.reason ?? why)}">–</td>`;
    }
    return `<td class="num">${esc(formatNumber(values[id] ?? null, m.decimals, locale.code))}</td>`;
  }).join("");
}

export function playerPageBody(
  displayName: string,
  season: string,
  career: SeasonRow[],
  catalog: Catalog,
  locale: Locale,
): string {
  const t = locale.strings;
  if (career.length === 0) {
    return `<h1>${esc(displayName)}</h1>
<div class="stop">
<p class="state">not_computable_data_missing</p>
<p><strong>${esc(t.noPlayerMatched(displayName))}</strong></p>
<p>${esc(t.checkMatrix)} <a href="${base(locale)}/">${esc(t.backToMatrix)}</a></p>
</div>`;
  }

  const current = career.find((r) => r.season === season) ?? career[career.length - 1]!;
  const rows = career
    .map((r) => {
      const feas = columnFeasibility(catalog, "player", r.season, "PL", locale.code);
      const cells = metricValueCells(catalog, feas, r, locale);
      const here = r.season === current.season ? ' class="current"' : "";
      return `<tr${here}><td><a href="${base(locale)}/player/${encodeURIComponent(displayName)}/${esc(r.season)}">${esc(r.season)}</a></td>${cells}<td>${esc(positionLabel(r.position, locale.code))}</td></tr>`;
    })
    .join("");

  const headFeas = columnFeasibility(catalog, "player", current.season, "PL", locale.code);
  const head = metricHeadCells(catalog, headFeas, locale);
  const attribution = headFeas.get("goals")?.attribution_text;

  return `<h1>${esc(displayName)}</h1>
<p class="tagline">${esc(t.careerRecordFor(current.season))}</p>
<table>
<thead><tr><th>${esc(t.seasonCol)}</th>${head}<th>${esc(t.posCol)}</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<p class="tagline">${esc(t.dashExplainer)}</p>
${attribution ? `<p class="tagline">${esc(attribution)}</p>` : ""}
<p><a href="${base(locale)}/">${esc(t.backToMatrix)}</a></p>`;
}

export function seasonPageBody(
  season: string,
  squad: SquadRow[],
  record: SeasonRecord | null,
  catalog: Catalog,
  locale: Locale,
): string {
  const t = locale.strings;
  if (squad.length === 0) {
    return `<h1>${esc(season)}</h1>
<div class="stop">
<p class="state">not_computable_data_missing</p>
<p><strong>${esc(t.noSquadData(season))}</strong></p>
<p><a href="${base(locale)}/">${esc(t.backToMatrix)}</a></p>
</div>`;
  }

  const feas = columnFeasibility(catalog, "player", season, "PL", locale.code);
  const head = metricHeadCells(catalog, feas, locale);
  const rows = squad
    .map(
      (p) =>
        `<tr><td><a href="${base(locale)}/player/${encodeURIComponent(p.label)}/${esc(season)}">${esc(p.label)}</a></td>` +
        `${metricValueCells(catalog, feas, p, locale)}<td>${esc(positionLabel(p.secondary, locale.code))}</td></tr>`,
    )
    .join("");

  const recordLine = record
    ? `<p class="tagline">${esc(t.leagueRecord(record.played, record.won, record.drawn, record.lost, record.goals, record.goals_against))}
<a href="${base(locale)}/q?metric=goals&season=${esc(season)}&viz=bar&entity_id=all">${esc(t.seeTopScorers)}</a></p>`
    : `<p class="note">${esc(t.noSeasonRecord(season))}</p>`;

  const attribution = feas.get("goals")?.attribution_text;

  return `<h1>${esc(t.squadHeading(season))}</h1>
${recordLine}
<table>
<thead><tr><th>${esc(t.playerCol)}</th>${head}<th>${esc(t.posCol)}</th></tr></thead>
<tbody>${rows}</tbody>
</table>
${attribution ? `<p class="tagline">${esc(attribution)}</p>` : ""}
<p><a href="${base(locale)}/">${esc(t.backToMatrix)}</a></p>`;
}

export function homeBody(catalog: Catalog, locale: Locale): string {
  const t = locale.strings;
  return `<h1>iammufc</h1>
<p class="tagline">${esc(t.siteTagline)}</p>
<div class="card">
${chatForm(locale)}
<h3>${esc(t.examplesHeading)}</h3>
<ul class="examples">
${EXAMPLES[locale.code].map((e) => `<li>${esc(e)}</li>`).join("\n")}
</ul>
</div>
${coverageMatrix(catalog, locale)}`;
}
