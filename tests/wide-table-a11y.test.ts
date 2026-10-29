import { describe, expect, it } from "vitest";
import { LOCALES, type LocaleCode } from "../worker/src/core/locale";
import { querySeasonSplits, type SeasonSplitRequest, type SeasonSplitRow } from "../worker/src/core/season-splits";
import { queryOpponentHistory } from "../worker/src/core/opponent-history";
import { calculatePer90Leaders, calculatePlayerTrends, type PlayerTrendsRequest, type PlayerTrendRow } from "../worker/src/core/player-trends";
import { seasonSplitsBody, seasonSplitSelection } from "../worker/src/views/season-splits";
import { opponentHistoryBody } from "../worker/src/views/opponent-history";
import { championsLeagueHistoryBody } from "../worker/src/views/cl-history";
import { playerTrendsBody } from "../worker/src/views/player-trends";

const season = "2025-26";
const snapshot = "a".repeat(64);
const credits = { "synthetic:league": "Synthetic league credit" };
const splitRequest: SeasonSplitRequest = {
  schema_version: 1, competition: "PL", seasons: [season], group_by: "venue", venue: null, opponent_id: null,
};
const catalog = { snapshot_id: snapshot, seasons: [{ season, coverage: "complete" as const }] };
const splitRow: SeasonSplitRow = {
  snapshot_id: snapshot, season, competition: "PL", venue: "home", opponent_id: "club:1001",
  played: 1, won: 1, drawn: 0, lost: 0, goals_for: 2, goals_against: 0, lineage: ["synthetic:league"],
};
const people = [{ person_id: "fpl:code:1", label: "Alex" }, { person_id: "fpl:code:2", label: "Bea" }];
const trendCatalog = { snapshot_id: snapshot, seasons: [season], person_ids: people.map(p => p.person_id) };
const trendRequest: PlayerTrendsRequest = {
  schema_version: 1, competition: "PL", person_ids: trendCatalog.person_ids, seasons: [season],
  metric: "goals", normalization: "per90", min_minutes: 450, viz: "table",
};
const trendRows: PlayerTrendRow[] = people.map((person, index) => ({
  person_id: person.person_id, season, competition: "PL", metric: "goals", definition: "goals",
  total: 2, minutes: index === 0 ? 900 : 200, snapshot_id: snapshot, lineage: ["synthetic:league"],
}));

function splits(locale: LocaleCode, rows: SeasonSplitRow[]) {
  return seasonSplitsBody({
    selection: seasonSplitSelection(splitRequest), seasons: [season], opponents: [], credits,
    result: querySeasonSplits(splitRequest, catalog, rows),
  }, LOCALES[locale]);
}
function opponent(locale: LocaleCode, rows: SeasonSplitRow[]) {
  return opponentHistoryBody({
    result: queryOpponentHistory({ ...splitRequest, group_by: "opponent", opponent_id: "club:1001" }, catalog, rows),
    opponentLabel: "Arsenal", credits,
  }, locale);
}
function trends(locale: LocaleCode, rows: PlayerTrendRow[], leaders = false) {
  return playerTrendsBody({
    ...calculatePlayerTrends(trendRequest, trendCatalog, rows), people, credits,
    ...(leaders ? { leaders: calculatePer90Leaders(trendCatalog, season, "goals", 450, rows) } : {}),
  }, {}, LOCALES[locale]);
}

// These fragments contain flat div table wrappers. Count all tables as well as
// wrappers so an unwrapped table cannot silently escape the contract checks.
function assertTables(html: string, expectedTables: number) {
  const tables = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/g)];
  const regions = [...html.matchAll(/<div\b([^>]*\brole="region"[^>]*)>([\s\S]*?)<\/div>/g)];
  expect(tables).toHaveLength(expectedTables);
  expect(regions).toHaveLength(expectedTables);
  for (const [index, region] of regions.entries()) {
    expect.soft(region[1], `region ${index + 1} keyboard access`).toMatch(/\btabindex="0"/);
    expect.soft(region[1], `region ${index + 1} name`).toMatch(/\baria-label="[^"\s][^"]*"/);
    const contained = [...region[2]!.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/g)];
    expect.soft(contained, `region ${index + 1} table`).toHaveLength(1);
    expect.soft(region[2], `region ${index + 1} has meaningful body rows`).toMatch(/<tbody>\s*<tr\b/);
  }
  for (const [index, [table]] of tables.entries()) {
    const opening = table.match(/^<table\b[^>]*>/)?.[0] ?? "";
    const caption = table.match(/<caption\b[^>]*>([^<]*)<\/caption>/)?.[1] ?? "";
    const named = caption.trim().length > 0 || /\baria-label="[^"\s][^"]*"/.test(opening);
    expect.soft(named, `table ${index + 1} needs its own caption or aria-label`).toBe(true);
    const headers = [...(table.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/)?.[1] ?? "").matchAll(/<th\b([^>]*)>/g)];
    expect.soft(headers.length, `table ${index + 1} column headers`).toBeGreaterThan(0);
    for (const header of headers) expect.soft(header[1], `table ${index + 1} column scope`).toMatch(/\bscope="col"/);
  }
}

describe.each(["en", "es"] as const)("wide table contract (%s)", locale => {
  it("names and focuses season-splits tables", () => assertTables(splits(locale, [splitRow]), 1));
  it("names and focuses opponent-history tables", () => assertTables(opponent(locale, [splitRow]), 1));
  it("names and focuses Champions League tables", () => {
    assertTables(championsLeagueHistoryBody({ entries: [{ state: "observed", row: {
      season, played: 1, won: 1, drawn: 0, lost: 0, goals: 2, goals_against: 0, lineage: ["synthetic:league"],
    } }], credits }, LOCALES[locale].strings.clHistory, locale), 1);
  });
  it("names and focuses the player-trends main table", () => assertTables(trends(locale, trendRows), 1));
  it("names every player-trends leaderboard and exclusion table", () => assertTables(trends(locale, trendRows, true), 3));
  it("omits focusable regions when season-splits has no matches", () => assertTables(splits(locale, []), 0));
  it("omits focusable regions outside Champions League coverage", () => {
    assertTables(championsLeagueHistoryBody({ entries: [], credits }, LOCALES[locale].strings.clHistory, locale), 0);
  });
  it("omits focusable regions when Champions League history is unavailable", () => {
    assertTables(championsLeagueHistoryBody({ entries: [], credits, unavailable: true }, LOCALES[locale].strings.clHistory, locale), 0);
  });
  it("retains informative opponent no-match rows instead of an empty region", () => assertTables(opponent(locale, []), 1));
  it("retains player gap rows when facts are missing", () => assertTables(trends(locale, []), 1));
  it("does not emit an empty focusable leaderboard when no player qualifies", () => {
    // Valid calculator output: both selected players are below the threshold.
    // The gap/threshold table and exclusion table remain informative.
    assertTables(trends(locale, trendRows.map(row => ({ ...row, minutes: 200 })), true), 2);
  });
});
