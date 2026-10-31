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
  const strings = locale.strings.seasonSplits;
  const title = strings.exploreSeasonPerformance;
  const s = model.selection;
  const result = model.error ? undefined : model.result;
  const venueName = (key: string) => key === "home" ? strings.home : strings.away;
  const opponentName = (key: string) => {
    const label = model.opponents.find(o => o.opponent_id === key)?.label;
    return label?.trim() ? label : key;
  };
  const select = (id: string, label: string, choices: [string, string][], selected: string) => {
    const all = choices.some(([v]) => v === selected) ? choices : [...choices, [selected, selected] as [string, string]];
    return `<label for="splits-${id}">${label}</label><select id="splits-${id}" name="${id}">${all.map(([v, text]) => `<option value="${esc(v)}"${v === selected ? " selected" : ""}>${esc(text)}</option>`).join("")}</select>`;
  };
  const seasons = [...new Set([...model.seasons, ...s.seasons])].sort();
  const seasonGroups = new Map<string, string[]>();
  for (const season of seasons) {
    const year = Number(season.slice(0, 4));
    const decade = Number.isFinite(year) ? Math.floor(year / 10) * 10 : 0;
    const label = decade ? strings.decadeLabel(decade) : strings.otherSeasons;
    seasonGroups.set(label, [...(seasonGroups.get(label) ?? []), season]);
  }
  let seasonIndex = 0;
  const seasonChoices = [...seasonGroups].map(([label, groupedSeasons]) => `<fieldset><legend>${esc(label)}</legend>${groupedSeasons.map(v => {
    const i = seasonIndex++;
    return `<label for="splits-season-${i}"><input id="splits-season-${i}" type="checkbox" name="seasons" value="${esc(v)}"${s.seasons.includes(v) ? " checked" : ""}>${esc(v)}</label>`;
  }).join("")}</fieldset>`).join("");
  const form = `<form method="get" action="/${locale.code}/seasons/explore">
    <input type="hidden" name="schema_version" value="1"><input type="hidden" name="competition" value="PL">
    <fieldset><legend>${strings.seasonSelection(seasons.filter(v => s.seasons.includes(v)).length)}</legend>${seasonChoices}</fieldset>
    ${select("group_by", strings.groupBy, [["venue", strings.homeAndAway], ["opponent", strings.opponent]], s.group_by)}
    ${select("venue", strings.venue, [["", strings.allVenues], ["home", venueName("home")], ["away", venueName("away")]], s.venue)}
    ${select("opponent_id", strings.opponent, [["", strings.allOpponents], ...model.opponents.map(o => [o.opponent_id, o.label] as [string, string])], s.opponent_id)}
    <button type="submit">${strings.exploreSeasons}</button></form>`;
  const method = `<p id="splits-method">${result ? `${strings.rowsCombineTheSelectedSeasons}` : ""}${strings.manchesterUnitedPremierLeagueCompletedMatches}</p>`;
  if (!result) return `<h1>${title}</h1>${model.error ? `<p role="alert">${esc(model.error)}</p>` : ""}${form}${method}`;
  const num = (value: number | null, digits = 0) => value === null
    ? `<span aria-label="${strings.missingData}">—</span>` : formatNumber(value, digits, locale.code);
  const coverageLabel = { complete: strings.complete, partial: strings.partialSchedule, missing: strings.missingSplitCoverage };
  const partial = result.partial ? `<p id="splits-warning" role="note">${strings.partialScheduleTheseArePartialSubtotals}</p>` : "";
  const summary = `<p id="splits-summary">${esc(result.request.seasons.join(", "))} · ${strings.groupBy}: ${result.request.group_by === "venue" ? strings.homeAndAway : strings.opponent} · ${result.request.venue === null ? strings.allVenues : venueName(result.request.venue)} · ${result.request.opponent_id === null ? strings.allOpponents : esc(opponentName(result.request.opponent_id))}</p>`;
  const coverage = `<ul aria-label="${strings.seasonCoverage}">${result.coverage.map(c => `<li>${esc(c.season)}: ${coverageLabel[c.coverage]}</li>`).join("")}</ul>`;
  const coverageSummary = result.coverage.length ? (() => {
    const counts = result.coverage.reduce((total, entry) => {
      total[entry.coverage]++;
      return total;
    }, { complete: 0, partial: 0, missing: 0 });
    return `<p id="splits-coverage-summary">${strings.coverageSummary(result.coverage.length, counts.complete, counts.partial, counts.missing)}</p>`;
  })() : "";
  const headers = [result.request.group_by === "venue" ? strings.venue : strings.opponent, strings.played, strings.wins, strings.draws, strings.losses, strings.goalsFor, strings.goalsAgainst, strings.goalDifference, strings.points, strings.pointsMatch, strings.goalsForMatch, strings.goalsAgainstMatch, strings.winRate, strings.contributingSeasons];
  const rows = result.groups.map(g => `<tr><th scope="row">${esc(result.request.group_by === "venue" ? venueName(g.key) : opponentName(g.key))}</th>${[g.played, g.won, g.drawn, g.lost, g.goals_for, g.goals_against, g.goal_difference, g.points].map(v => `<td>${num(v)}</td>`).join("")}<td>${num(g.points_per_match, 2)}</td><td>${num(g.goals_for_per_match, 2)}</td><td>${num(g.goals_against_per_match, 2)}</td><td>${num(g.win_rate === null ? null : 100 * g.win_rate, 2)}</td><td>${esc(g.contributing_seasons.join(", "))}</td></tr>`).join("");
  const sum = (pick: (g: SeasonSplitGroup) => number) => result.groups.reduce((a, g) => a + pick(g), 0);
  const totalRow = (): string => {
    const [played, won, drawn, lost, gf, ga, gd, points] = [sum(g => g.played), sum(g => g.won), sum(g => g.drawn), sum(g => g.lost), sum(g => g.goals_for), sum(g => g.goals_against), sum(g => g.goal_difference), sum(g => g.points)];
    const per = (v: number) => played > 0 ? v / played : null;
    const winRate = per(won);
    const seasonsUsed = [...new Set(result.groups.flatMap(g => g.contributing_seasons))].sort();
    const label = `${strings.allMatches}${result.partial ? ` · ${strings.partialSubtotals}` : ""}`;
    return `<tr><th scope="row">${label}</th>${[played, won, drawn, lost, gf, ga, gd, points].map(v => `<td>${num(v)}</td>`).join("")}<td>${num(per(points), 2)}</td><td>${num(per(gf), 2)}</td><td>${num(per(ga), 2)}</td><td>${num(winRate === null ? null : 100 * winRate, 2)}</td><td>${esc(seasonsUsed.join(", "))}</td></tr>`;
  };
  const total = result.request.group_by === "venue" && result.request.venue === null && result.groups.length ? totalRow() : "";
  const unavailableSeasons = result.coverage.filter(c => c.coverage === "missing").map(c => c.season);
  const unavailable = unavailableSeasons.length
    ? strings.unavailableSeasons(unavailableSeasons.join(", "))
    : strings.splitCoverageIsUnavailableForThis;
  const table = result.groups.length ? `<div class="comparison-table" role="region" tabindex="0" aria-label="${title}"><table aria-describedby="splits-summary splits-method${result.partial ? " splits-warning" : ""}"><caption>${strings.seasonPerformance}${result.partial ? ` · ${strings.partialSubtotals}` : ""}</caption><thead><tr>${headers.map(h => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody>${rows}${total}</tbody></table></div>` : `<p>${result.status === "no_matches" ? strings.noCompletedMatchesMatchThisSelection : unavailable}</p>`;
  const lineage = [...new Set(result.groups.flatMap(g => g.lineage))];
  const creditFor = (ref: string): string | undefined => {
    const value: unknown = Object.hasOwn(model.credits, ref) ? model.credits[ref] : undefined;
    return typeof value === "string" && value.trim() ? value : undefined;
  };
  const credits = [...new Set(lineage.map(creditFor).filter((v): v is string => v !== undefined))];
  const sources = `<section aria-label="${strings.sourcesAndSnapshot}"><h2>${strings.sourcesAndSnapshot}</h2>${credits.map(c => `<p>${esc(c)}</p>`).join("")}${!lineage.length || lineage.some(ref => creditFor(ref) === undefined) ? `<p>${strings.sourceAttributionUnavailableForSomeData}</p>` : ""}<p>${strings.snapshot}: ${esc(result.snapshot_id)}</p></section>`;
  return `<h1>${title}</h1>${form}${summary}${partial}${coverageSummary}${coverage}${table}${method}${sources}`;
}
