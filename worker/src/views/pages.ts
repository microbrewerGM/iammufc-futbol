import { barChartSvg, buildAltText, formatValue as formatValueEn } from "../core/chart";
import type {
  ResultRow,
  SeasonRecord,
  SeasonRow,
  SourceId,
  SourceObservationStatus,
  SquadRow,
} from "../core/db";
import { columnFeasibility, type Catalog, type FeasibilityResult } from "../core/feasibility";
import type { QueryIntent } from "../core/intent";
import { formatNumber, metricLabel, positionLabel, type Locale } from "../core/locale";
import type { Proposal } from "../core/parser";
import type { GateRejected } from "../security/askguard";
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

export type FreshnessState = "current" | "degraded" | "inconsistent" | "unavailable";
export interface FreshnessSourceView {
  id: SourceId;
  status: SourceObservationStatus;
  coverageThrough: string | null;
  retrievedAt: string | null;
  sourceAsOf: string | null;
}
export type FreshnessView =
  | {
      state: "current" | "degraded";
      coverageThrough: string;
      lastSuccessfulLoadAt: string;
      sources: readonly FreshnessSourceView[];
    }
  | { state: "inconsistent" | "unavailable" };

const SOURCE_LABELS: Record<SourceId, string> = {
  fpl: "Fantasy Premier League",
  football_data_couk: "Football-Data.co.uk",
  openfootball_cl: "openfootball — Champions League",
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
  // Scoped to Premier League, and to player-level cells where both exist.
  //
  // The matrix is a metric x season grid with no competition dimension, so a
  // bare `metric/season` key silently collides once a metric is covered for
  // more than one competition or entity type -- last cell in the YAML wins,
  // and the tooltip then credits the wrong source. That went unnoticed while
  // the only collision was harmless; adding Champions League cells made it
  // credit football-data.org for what is actually FPL player data.
  //
  // Champions League coverage is surfaced on the season pages instead, where
  // it has a place to live. Giving this table a real competition dimension is
  // a deliberate design change, not something to fall out of a bug fix.
  const plCells = catalog.coverage.filter((c) => c.competition === "PL");
  const seasons = [...new Set(plCells.map((c) => c.season))].sort().reverse();
  const index = new Map<string, (typeof plCells)[number]>();
  for (const c of plCells) {
    const key = `${c.metric}/${c.season}`;
    const held = index.get(key);
    // Deterministic precedence, rather than document order: these columns feed
    // the player tables, so a player-level cell is the one being described.
    if (!held || (held.entity_type !== "player" && c.entity_type === "player")) {
      index.set(key, c);
    }
  }

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

export function freshnessPanel(view: FreshnessView, locale: Locale): string {
  const t = locale.strings;
  const heading = `<h2 id="data-freshness">${esc(t.freshnessHeading)}</h2>`;
  if (view.state !== "current" && view.state !== "degraded") {
    const message = view.state === "inconsistent" ? t.freshnessInconsistent : t.freshnessUnavailable;
    return `<section class="card" aria-labelledby="data-freshness">${heading}<p>${esc(message)}</p></section>`;
  }
  const sources = view.sources
    .map((source) => {
      const label = SOURCE_LABELS[source.id];
      if (source.status === "unavailable") {
        return `<li><strong>${esc(label)}</strong> — ${esc(t.sourceUnavailable)} ${esc(t.sourceNotRetrieved)} ${esc(t.sourceAsOfUnavailable)}</li>`;
      }
      const asOf = source.sourceAsOf
        ? `${esc(t.sourceAsOf)} <time datetime="${esc(source.sourceAsOf)}">${esc(source.sourceAsOf)}</time>.`
        : esc(t.sourceAsOfUnavailable);
      return `<li><strong>${esc(label)}</strong> — ${esc(t.sourceObserved)} ${esc(t.sourceCoverageThrough(source.coverageThrough!))} ${esc(t.sourceRetrieved)} <time datetime="${esc(source.retrievedAt!)}">${esc(source.retrievedAt!)}</time>. ${asOf}</li>`;
    })
    .join("\n");
  const degraded = view.state === "degraded" ? `<p>${esc(t.freshnessDegraded)}</p>` : "";
  return `<section class="card" aria-labelledby="data-freshness">${heading}
<p>${esc(t.coverageThrough(view.coverageThrough))}</p>
<p>${esc(t.lastSuccessfulLoad)} <time datetime="${esc(view.lastSuccessfulLoadAt)}">${esc(view.lastSuccessfulLoadAt)}</time>.</p>
${degraded}<ul>${sources}</ul></section>`;
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

function seasonDataTable(
  rows: ResultRow[],
  metricLbl: string,
  decimals: number,
  locale: Locale,
): string {
  const t = locale.strings;
  const fmt = (value: number | null) => formatNumber(value, decimals, locale.code);
  const record = locale.code === "es" ? "Balance" : "Record";
  const body = rows
    .map(
      (row) =>
        `<tr><th scope="row"><a href="${base(locale)}/season/${encodeURIComponent(row.label)}">${esc(row.label)}</a></th>` +
        `<td>${esc(row.secondary ?? "")}</td><td class="num">${esc(fmt(row.value))}</td></tr>`,
    )
    .join("");
  return `<h3>${esc(t.dataHeading)}</h3>
<table><thead><tr><th>${esc(t.seasonCol)}</th><th>${record}</th><th class="num">${esc(metricLbl)}</th></tr></thead>
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
<input type="hidden" name="entity_type" value="${esc(feasibility.nearest_alternative.entity_type)}">
<input type="hidden" name="competition" value="${esc(feasibility.nearest_alternative.competition)}">
<input type="hidden" name="limit" value="${feasibility.nearest_alternative.limit}">
<button class="secondary" type="submit">${esc(metricLabel(catalog, feasibility.nearest_alternative.metric, locale.code))} — ${esc(feasibility.nearest_alternative.season)}</button>
</form>`
    : "";

  // Refusals are first-class output, not error states. Naming which of the two
  // kinds of gap this is tells the user whether it could ever be closed.
  if (
    feasibility.state === "no_data" ||
    feasibility.state === "no_rights"
  ) {
    const kind =
      feasibility.state === "no_rights"
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

  if (feasibility.state === "computable_but_expensive") {
    return `<div class="stop">
<p class="state">${esc(feasibility.state)}</p>
<p><strong>${esc(feasibility.reason)}</strong></p>
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
${intent.entity_type === "season" ? seasonDataTable(rows, label, decimals, locale) : dataTable(rows, label, decimals, intent.season, locale)}
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
      const why = f?.state === "no_rights" ? locale.strings.legendNoRights : locale.strings.legendNoSource;
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
<p class="state">no_data</p>
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
  europeanRecord: SeasonRecord | null = null,
): string {
  const t = locale.strings;
  if (squad.length === 0) {
    return `<h1>${esc(season)}</h1>
<div class="stop">
<p class="state">no_data</p>
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

  // Champions League line renders ONLY when the ingest actually found a row --
  // United did not enter Europe's top competition every season in this window,
  // and an empty "0 played" line would read as a claim we measured something.
  // Attribution comes from the CL coverage cell's lineage, never hand-coded:
  // football-data.org's terms (clause 7.1) mandate that exact string whenever
  // their data is shown, so the line renders with its attribution or not at all.
  const clFeas = europeanRecord
    ? columnFeasibility(catalog, "season", season, "CL", locale.code)
    : null;
  const clCell = clFeas?.get("goals") ?? null;
  const clAttribution = clCell?.attribution_text ?? null;
  // Gate on the RIGHT to publish, not on the existence of a credit line.
  // An earlier version required attribution_text to be non-null, which was
  // correct while the source mandated a verbatim credit -- and silently hid
  // the whole line the moment the source became openfootball, whose public
  // domain dedication requires no attribution at all. The invariant that
  // actually matters is the other direction: where a credit IS required it
  // renders with the data, which the `clAttribution &&` below still enforces.
  const clPublishable = clCell?.state === "available" || clCell?.state === "computable_now_queued";
  const europeanLine =
    europeanRecord && clPublishable
      ? `<p class="tagline">${esc(
          t.europeanRecord(
            europeanRecord.played,
            europeanRecord.won,
            europeanRecord.drawn,
            europeanRecord.lost,
            europeanRecord.goals,
            europeanRecord.goals_against,
          ),
        )}</p>`
      : "";

  const attribution = feas.get("goals")?.attribution_text;

  return `<h1>${esc(t.squadHeading(season))}</h1>
${recordLine}
${europeanLine}
<table>
<thead><tr><th>${esc(t.playerCol)}</th>${head}<th>${esc(t.posCol)}</th></tr></thead>
<tbody>${rows}</tbody>
</table>
${attribution ? `<p class="tagline">${esc(attribution)}</p>` : ""}
${clAttribution ? `<p class="tagline">${esc(clAttribution)}</p>` : ""}
<p><a href="${base(locale)}/">${esc(t.backToMatrix)}</a></p>`;
}

export function homeBody(
  catalog: Catalog,
  locale: Locale,
  freshness: FreshnessView = { state: "unavailable" },
): string {
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
${freshnessPanel(freshness, locale)}
${coverageMatrix(catalog, locale)}`;
}


/**
 * The Ask gate's refusal, rendered.
 *
 * Reuses the `.stop` treatment the feasibility refusals already use, on
 * purpose: to a reader, "we will not answer that" and "we cannot answer that"
 * are the same class of outcome and should look the same. What differs is the
 * sentence, not the styling.
 *
 * The suggestion is a live link, not prose. A refusal that leaves the user
 * retyping from scratch is a dead end -- the same reason a feasibility refusal
 * carries nearest_alternative as a button rather than a description.
 */
export function rejectionPanel(verdict: GateRejected, locale: Locale): string {
  const heading = locale.code === "es" ? "No se ejecutó" : "Not run";
  const tryLabel = locale.code === "es" ? "Prueba en su lugar" : "Try instead";

  // The suggestion copy is authored as "Prefix: the question". Only the part
  // after the colon is a question we can prefill; splitting on the LAST colon
  // keeps a colon inside the question itself intact.
  const idx = verdict.suggestion.lastIndexOf(":");
  const prefilled = idx >= 0 ? verdict.suggestion.slice(idx + 1).trim() : verdict.suggestion;

  return `<div class="stop">
<p class="state">${esc(verdict.code)}</p>
<p><strong>${esc(heading)}.</strong> ${esc(verdict.reason)}</p>
<form method="post" action="${base(locale)}/ask">
<p>${esc(tryLabel)}: <button class="secondary" type="submit" name="q" value="${esc(prefilled)}">${esc(prefilled)}</button></p>
</form>
</div>`;
}
