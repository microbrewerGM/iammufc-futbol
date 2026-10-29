import { describe, expect, it } from "vitest";
import { queryOpponentHistory } from "../worker/src/core/opponent-history";
import { opponentHistoryBody, type OpponentHistoryStrings } from "../worker/src/views/opponent-history";
import type { SeasonSplitCatalog } from "../worker/src/core/season-splits";

const seasons = ["2023-24", "2024-25"];
const snapshot = "a".repeat(64);
const catalog = { snapshot_id: snapshot, seasons: seasons.map(season => ({ season, coverage: "complete" as const })) } as SeasonSplitCatalog;
const request = { schema_version: 1, competition: "PL", seasons, group_by: "opponent", venue: null, opponent_id: "club:1001" };
// Complete coverage, zero rows for the opponent: a true "no meetings" selection.
const result = queryOpponentHistory(request, catalog, []);

const sentinel = (tag: string): OpponentHistoryStrings => ({
  opponent: `${tag}-opponent`, title: `${tag}-title`, context: `${tag}-context`, season: `${tag}-season`, played: `${tag}-played`, wins: `${tag}-wins`,
  draws: `${tag}-draws`, losses: `${tag}-losses`, goalsFor: `${tag}-gf`, goalsAgainst: `${tag}-ga`, points: `${tag}-points`, goalDifference: `${tag}-gd`, combined: `${tag}-combined`,
  partial: `${tag}-partial`, missing: `${tag}-missing`, noMatches: `${tag}-no-matches`, failure: `${tag}-failure`, available: `${tag}-available`,
  status: `${tag}-status`, complete: `${tag}-complete`, source: `${tag}-source`, attributionUnavailable: `${tag}-attr`, snapshot: `${tag}-snapshot`,
  chart: `${tag}-chart`, chartDescription: `${tag}-chartdesc`, chartUnavailable: `${tag}-chartunavail`, pointsPerMatch: `${tag}-ppm`,
  venueBoth: `${tag}-both`, venueHome: `${tag}-home`, venueAway: `${tag}-away`, recordHeadline: `${tag}-headline`,
});

const copy = { en: "No completed matches match this selection.", es: "Ningún partido finalizado coincide con esta selección." } as const;
const tbody = (html: string): string => html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "";

describe("opponent history with zero meetings", () => {
  it("resolves to the no_matches state without a record", () => {
    expect(result.status).toBe("no_matches");
    expect(result.combined).toBeUndefined();
    for (const entry of result.seasons) { expect(entry.status).toBe("no_matches"); expect(entry.record).toBeUndefined(); }
  });
  it.each(["en", "es"] as const)("renders the %s empty state and no fabricated record", locale => {
    const html = opponentHistoryBody({ result, opponentLabel: "Arsenal", credits: {} }, locale);
    expect(html).toContain(copy[locale]);
    // one empty-state cell per season row plus the combined row
    expect(html.split(copy[locale]).length - 1).toBeGreaterThanOrEqual(seasons.length + 1);
    const rows = tbody(html).match(/<tr>[\s\S]*?<\/tr>/g) ?? [];
    expect(rows).toHaveLength(seasons.length + 1);
    for (const row of rows) {
      expect(row).toContain('<td colspan="9">—</td>');
      expect(row).not.toMatch(/<td>\s*0\s*<\/td>/);
    }
    expect(html).not.toContain('id="h2h-record"');
    expect(html).not.toMatch(/\b0\s*[-–]\s*0\s*[-–]\s*0\b/);
    expect(html).not.toMatch(/\bW\s*0\b[^<]*\bD\s*0\b[^<]*\bL\s*0\b/);
    expect(html).not.toContain("zero-mark");
    expect(html).not.toMatch(/<rect\b/);
    expect(html).not.toMatch(/0[.,]00/);
  });
  it.each(["en", "es"] as const)("takes the %s empty-state copy from the supplied locale dictionary", locale => {
    const strings = sentinel(locale);
    const html = opponentHistoryBody({ result, opponentLabel: "Arsenal", credits: {}, strings }, locale);
    expect(html).toContain(strings.noMatches);
    expect(html).not.toContain(copy.en);
    expect(html).not.toContain(copy.es);
    expect(html).not.toContain(`${strings.missing}</td>`);
  });
  it("keeps EN and ES empty-state copy distinct", () => {
    expect(copy.en).not.toBe(copy.es);
    expect(opponentHistoryBody({ result, credits: {} }, "en")).not.toContain(copy.es);
    expect(opponentHistoryBody({ result, credits: {} }, "es")).not.toContain(copy.en);
  });
});
