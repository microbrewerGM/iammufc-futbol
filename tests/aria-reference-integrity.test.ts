import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import { queryOpponentHistory } from "../worker/src/core/opponent-history";
import { querySeasonSplits, type SeasonSplitCatalog, type SeasonSplitRequest, type SeasonSplitRow } from "../worker/src/core/season-splits";
import { opponentHistoryBody } from "../worker/src/views/opponent-history";
import { seasonSplitSelection, seasonSplitsBody } from "../worker/src/views/season-splits";

// These views emit quoted attributes. Read attributes only inside opening tags,
// including SVG title/desc, so text and data-id cannot masquerade as targets.
function referenceErrors(html: string): { errors: string[]; references: string[] } {
  const counts = new Map<string, number>();
  const references: string[] = [];
  for (const tag of html.matchAll(/<[a-z][^>]*>/gi)) {
    for (const attribute of tag[0].matchAll(/\s(id|aria-labelledby|aria-describedby)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const value = attribute[2] ?? attribute[3] ?? "";
      if (attribute[1] === "id") counts.set(value, (counts.get(value) ?? 0) + 1);
      else references.push(...value.trim().split(/\s+/).filter(Boolean));
    }
  }
  return {
    references,
    errors: [...new Set(references)].flatMap(id => {
      const count = counts.get(id) ?? 0;
      return count === 1 ? [] : [`ARIA reference "${id}" has ${count} targets (expected exactly 1)`];
    }),
  };
}

const season = "2024-25";
const snapshot = "a".repeat(64);
const request: SeasonSplitRequest = {
  schema_version: 1, competition: "PL", seasons: [season],
  group_by: "opponent", venue: null, opponent_id: "club:1001",
};
const row: SeasonSplitRow = {
  snapshot_id: snapshot, season, competition: "PL", venue: "home", opponent_id: "club:1001",
  played: 1, won: 1, drawn: 0, lost: 0, goals_for: 2, goals_against: 0, lineage: ["synthetic:league"],
};
const cases = [
  { name: "complete", coverage: "complete", rows: [row], status: "available" },
  { name: "partial", coverage: "partial", rows: [row], status: "available" },
  { name: "no_matches", coverage: "complete", rows: [], status: "no_matches" },
  { name: "missing coverage", coverage: "missing", rows: [], status: "missing_capability" },
] as const;
const credits = { "synthetic:league": "Synthetic league credit" };

for (const locale of ["en", "es"] as const) {
  describe(`ARIA references in ${locale} result bodies`, () => {
    for (const fixture of cases) {
      const catalog: SeasonSplitCatalog = {
        snapshot_id: snapshot, seasons: [{ season, coverage: fixture.coverage }],
      };
      it(`season splits: ${fixture.name}`, () => {
        const result = querySeasonSplits(request, catalog, [...fixture.rows]);
        expect(result.status).toBe(fixture.status);
        expect(result.partial).toBe(fixture.coverage !== "complete");
        const html = seasonSplitsBody({
          selection: seasonSplitSelection(request), seasons: [season],
          opponents: [{ opponent_id: "club:1001", label: "Synthetic opponent" }], result, credits,
        }, LOCALES[locale]);
        const audit = referenceErrors(html);
        expect(audit.errors).toEqual([]);
        // Empty/missing bodies deliberately have no table, hence no IDREFs.
        expect(audit.references).toEqual(fixture.rows.length
          ? ["splits-summary", "splits-method", ...(fixture.coverage === "partial" ? ["splits-warning"] : [])]
          : []);
        expect(html.includes("<table")).toBe(fixture.rows.length > 0);
      });
      it(`opponent history: ${fixture.name}`, () => {
        const result = queryOpponentHistory(request, catalog, [...fixture.rows]);
        expect(result.seasons[0]?.status).toBe(fixture.status);
        expect(result.seasons[0]?.coverage).toBe(fixture.coverage);
        expect(result.partial).toBe(fixture.coverage !== "complete");
        const html = opponentHistoryBody({ result, opponentLabel: "Synthetic opponent", credits }, locale);
        const audit = referenceErrors(html);
        expect(audit.errors).toEqual([]);
        expect(audit.references).toEqual(["h2h-chart-title", "h2h-chart-desc", "h2h-summary"]);
      });
    }
  });
}

describe("ARIA reference checker regression probes", () => {
  it("accepts multiple references with whitespace and a shared target", () => {
    expect(referenceErrors(`<svg aria-labelledby="title  desc" aria-describedby='desc\t note'>
      <title id="title">Title</title><desc id='desc'>Description</desc></svg><p id="note">Note</p>`).errors).toEqual([]);
  });
  it("names a dangling description target", () => {
    expect(referenceErrors('<table aria-describedby="missing"></table>').errors)
      .toEqual(['ARIA reference "missing" has 0 targets (expected exactly 1)']);
  });
  it("names a duplicate label target", () => {
    expect(referenceErrors('<svg aria-labelledby="duplicate"><title id="duplicate"></title><desc id="duplicate"></desc></svg>').errors)
      .toEqual(['ARIA reference "duplicate" has 2 targets (expected exactly 1)']);
  });
  it("does not count data attributes or escaped text as targets", () => {
    expect(referenceErrors('<p aria-describedby="missing" data-id="missing">&lt;p id="missing"&gt;</p>').errors)
      .toEqual(['ARIA reference "missing" has 0 targets (expected exactly 1)']);
  });
});
