import { describe, expect, it } from "vitest";
import { querySeasonSplits, type SeasonSplitRequest, type SeasonSplitRow } from "../worker/src/core/season-splits";
import { LOCALES } from "../worker/src/core/locale";
import { seasonSplitsBody, seasonSplitSelection, type SeasonSplitView } from "../worker/src/views/season-splits";

const seasons = ["2024-25"];
const request: SeasonSplitRequest = {
  schema_version: 1, competition: "PL", seasons, group_by: "opponent", venue: null, opponent_id: null,
};
const row: SeasonSplitRow = {
  season: seasons[0]!, competition: "PL", venue: "home", opponent_id: "club:1001",
  played: 1, won: 1, drawn: 0, lost: 0, goals_for: 2, goals_against: 0,
  snapshot_id: "synthetic", lineage: ["synthetic:one"],
};
const result = querySeasonSplits(request, {
  snapshot_id: "synthetic", seasons: [{ season: seasons[0]!, coverage: "complete" }],
}, [row]);
const render = (opponents: SeasonSplitView["opponents"], code: "en" | "es") => seasonSplitsBody({
  selection: seasonSplitSelection(request), seasons, opponents, result, credits: {},
}, LOCALES[code]);

describe("season splits opponent label fallback", () => {
  it.each(["en", "es"] as const)("shows a stable opponent ID when its label is missing in %s", code => {
    const html = render([], code);
    expect(html).toContain("<th scope=\"row\">club:1001</th>");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("> </th>");
  });

  it("uses the ID for an empty label, preserves a resolved label, and escapes the fallback", () => {
    expect(render([{ opponent_id: "club:1001", label: "  " }], "en")).toContain("<th scope=\"row\">club:1001</th>");
    expect(render([{ opponent_id: "club:1001", label: "Arsenal" }], "en")).toContain("<th scope=\"row\">Arsenal</th>");
    const unsafeKey = '<img src=x onerror="bad">';
    const unsafeResult = { ...result, groups: result.groups.map(group => ({ ...group, key: unsafeKey })) };
    const html = seasonSplitsBody({ selection: seasonSplitSelection(request), seasons, opponents: [], result: unsafeResult, credits: {} }, LOCALES.en);
    expect(html).toContain("&lt;img src=x onerror=&quot;bad&quot;&gt;");
    expect(html).not.toContain('<img src=x');
  });
});
