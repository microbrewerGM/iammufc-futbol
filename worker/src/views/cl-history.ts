import { esc } from "./layout";
import type { LocaleCode } from "../core/locale";
import { validSeason } from "../core/cl-history";

export interface ChampionsLeagueTotals {
  season: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goals: number;
  goals_against: number;
  lineage?: readonly string[] | null;
}

export type ChampionsLeagueHistoryEntry =
  | { state: "observed"; row: ChampionsLeagueTotals }
  | { state: "partial"; row: ChampionsLeagueTotals }
  | { state: "gap"; season: string }
  | { state: "out_of_coverage"; season: string };

export interface ChampionsLeagueHistoryView {
  entries: readonly ChampionsLeagueHistoryEntry[];
  /** Credits resolved by the caller from the coverage lineage references. */
  credits: Readonly<Record<string, string>>;
  snapshotDate?: string | null;
  /** Set for a temporary read or consistency failure. */
  unavailable?: boolean;
}

export interface ChampionsLeagueHistoryStrings {
  heading: string;
  caption: string;
  season: string;
  played: string;
  won: string;
  drawn: string;
  lost: string;
  goalsFor: string;
  goalsAgainst: string;
  gap: string;
  partial: string;
  outsideCoverage: string;
  noResults: string;
  unavailable: string;
  snapshotDate: string;
  sources: string;
  attributionUnavailable: string;
  /** Contains {n}. */
  observedSeasons: string;
  /** Contains {n}. */
  seasonsExcluded: string;
}

/** Render-only fragment. The caller owns localization, coverage resolution and page shell. */
export function championsLeagueHistoryBody(
  model: ChampionsLeagueHistoryView,
  strings: ChampionsLeagueHistoryStrings,
  locale: LocaleCode,
): string {
  if (model.unavailable) return `<h1>${esc(strings.heading)}</h1><p role="status">${esc(strings.unavailable)}</p>`;
  const eligible = model.entries.filter((entry) => entry.state !== "out_of_coverage");
  if (!eligible.length) return `<h1>${esc(strings.heading)}</h1><p role="status">${esc(strings.outsideCoverage)}</p>`;

  const lineage = [...new Set(eligible.flatMap((entry) => (entry.state === "observed" || entry.state === "partial") && Array.isArray(entry.row.lineage) ? entry.row.lineage.filter((ref) => typeof ref === "string" && ref.trim()) : []))];
  const creditFor = (ref: string): string | undefined => {
    const value: unknown = Object.hasOwn(model.credits, ref) ? model.credits[ref] : undefined;
    return typeof value === "string" && value.trim() ? value : undefined;
  };
  const credits = [...new Set(lineage.map(creditFor).filter((value): value is string => value !== undefined))];
  const headers = [strings.season, strings.played, strings.won, strings.drawn, strings.lost, strings.goalsFor, strings.goalsAgainst];
  const validLineage = (row: ChampionsLeagueTotals): boolean => {
    const refs = Array.isArray(row.lineage) ? row.lineage.filter((ref) => typeof ref === "string" && ref.trim()) : [];
    return refs.length > 0 && refs.every((ref) => creditFor(ref) !== undefined);
  };
  const totalled = eligible.flatMap((entry) => (entry.state !== "gap" && validLineage(entry.row) ? [entry] : []));
  const sum = (pick: (row: ChampionsLeagueTotals) => number): number => totalled.reduce((total, entry) => total + pick(entry.row), 0);
  const notTotalled = eligible.length - totalled.length;
  const totalsLabel = strings.observedSeasons.replace("{n}", String(totalled.length));
  const totalsRow = totalled.length
    ? `<tfoot><tr><th scope="row">${esc(totalsLabel)}${notTotalled ? ` <span>${esc(strings.seasonsExcluded.replace("{n}", String(notTotalled)))}</span>` : ""}</th>${[sum((r) => r.played), sum((r) => r.won), sum((r) => r.drawn), sum((r) => r.lost), sum((r) => r.goals), sum((r) => r.goals_against)].map((value) => `<td>${value}</td>`).join("")}</tr></tfoot>`
    : "";
  const rows = eligible.map((entry) => {
    if (entry.state === "gap") {
      return `<tr><th scope="row">${esc(entry.season)}</th><td colspan="6"><span aria-label="${esc(strings.gap)}">—</span> <span>${esc(strings.gap)}</span></td></tr>`;
    }
    const row = entry.row;
    const seasonText = esc(row.season);
    const seasonLink = validSeason(row.season)
      ? `<a href="${esc(`/${locale}/season/${encodeURIComponent(row.season)}`)}">${seasonText}</a>`
      : seasonText;
    const seasonLabel = seasonLink;
    if (!validLineage(row)) {
      return `<tr><th scope="row">${seasonLabel}</th><td colspan="6"><span aria-label="${esc(strings.attributionUnavailable)}">—</span> <span>${esc(strings.attributionUnavailable)}</span></td></tr>`;
    }
    const rowCreditIds = [...new Set(row.lineage!.map(creditFor).filter((credit): credit is string => credit !== undefined))]
      .map((credit) => `cl-history-source-${credits.indexOf(credit)}`);
    const describedBy = rowCreditIds.length ? ` aria-describedby="${rowCreditIds.join(" ")}"` : "";
    const sourceLinks = rowCreditIds.map((id) => `<a class="cl-history-row-source" href="#${id}" aria-label="${esc(strings.sources)}">§</a>`).join(" ");
    const values = [row.played, row.won, row.drawn, row.lost, row.goals, row.goals_against];
    return `<tr${describedBy}><th scope="row">${seasonLabel}${sourceLinks ? ` <span class="cl-history-row-sources">${sourceLinks}</span>` : ""}</th>${values.map((value) => `<td>${value}</td>`).join("")}</tr>`;
  }).join("");
  const table = `<div class="comparison-table" role="region" tabindex="0" aria-label="${esc(strings.heading)}"><table><caption>${esc(strings.caption)}</caption><thead><tr>${headers.map((header) => `<th scope="col">${esc(header)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody>${totalsRow}</table></div>`;
  const sourceSection = lineage.length
    ? `<section aria-label="${esc(strings.sources)}"><h2>${esc(strings.sources)}</h2>${credits.map((credit, index) => `<p id="cl-history-source-${index}">${esc(credit)}</p>`).join("")}${lineage.some((ref) => creditFor(ref) === undefined) ? `<p>${esc(strings.attributionUnavailable)}</p>` : ""}${model.snapshotDate ? `<p>${esc(strings.snapshotDate)}: ${esc(model.snapshotDate)}</p>` : ""}</section>`
    : "";
  return `<h1>${esc(strings.heading)}</h1>${eligible.every((entry) => entry.state === "gap") ? `<p role="status">${esc(strings.noResults)}</p>` : ""}${table}${sourceSection}`;
}
