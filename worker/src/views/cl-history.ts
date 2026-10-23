import { esc } from "./layout";

export interface ChampionsLeagueTotals {
  season: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goals: number;
  goals_against: number;
  lineage: readonly string[];
  partial?: boolean;
}

export type ChampionsLeagueHistoryEntry =
  | { state: "observed"; row: ChampionsLeagueTotals }
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
}

/** Render-only fragment. The caller owns localization, coverage resolution and page shell. */
export function championsLeagueHistoryBody(
  model: ChampionsLeagueHistoryView,
  strings: ChampionsLeagueHistoryStrings,
): string {
  if (model.unavailable) return `<h1>${esc(strings.heading)}</h1><p role="status">${esc(strings.unavailable)}</p>`;
  const eligible = model.entries.filter((entry) => entry.state !== "out_of_coverage");
  if (!eligible.length) return `<h1>${esc(strings.heading)}</h1><p role="status">${esc(strings.outsideCoverage)}</p>`;

  const lineage = [...new Set(eligible.flatMap((entry) => entry.state === "observed" ? entry.row.lineage : []))];
  const creditFor = (ref: string): string | undefined => {
    const value: unknown = Object.hasOwn(model.credits, ref) ? model.credits[ref] : undefined;
    return typeof value === "string" && value.trim() ? value : undefined;
  };
  const credits = [...new Set(lineage.map(creditFor).filter((value): value is string => value !== undefined))];
  const headers = [strings.season, strings.played, strings.won, strings.drawn, strings.lost, strings.goalsFor, strings.goalsAgainst];
  const rows = eligible.map((entry) => {
    if (entry.state === "gap") {
      return `<tr><th scope="row">${esc(entry.season)}</th><td colspan="6"><span aria-label="${esc(strings.gap)}">—</span> <span>${esc(strings.gap)}</span></td></tr>`;
    }
    const row = entry.row;
    const values = [row.played, row.won, row.drawn, row.lost, row.goals, row.goals_against];
    return `<tr><th scope="row">${esc(row.season)}${row.partial ? ` <span>(${esc(strings.partial)})</span>` : ""}</th>${values.map((value) => `<td>${value}</td>`).join("")}</tr>`;
  }).join("");
  const table = `<div class="comparison-table" role="region" tabindex="0" aria-label="${esc(strings.heading)}"><table><caption>${esc(strings.caption)}</caption><thead><tr>${headers.map((header) => `<th scope="col">${esc(header)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
  const sourceSection = lineage.length
    ? `<section aria-label="${esc(strings.sources)}"><h2>${esc(strings.sources)}</h2>${credits.map((credit) => `<p>${esc(credit)}</p>`).join("")}${lineage.some((ref) => creditFor(ref) === undefined) ? `<p>${esc(strings.attributionUnavailable)}</p>` : ""}${model.snapshotDate ? `<p>${esc(strings.snapshotDate)}: ${esc(model.snapshotDate)}</p>` : ""}</section>`
    : "";
  return `<h1>${esc(strings.heading)}</h1>${eligible.every((entry) => entry.state === "gap") ? `<p role="status">${esc(strings.noResults)}</p>` : ""}${table}${sourceSection}`;
}
