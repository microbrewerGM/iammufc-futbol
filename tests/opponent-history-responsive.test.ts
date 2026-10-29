import { describe, expect, it } from "vitest";
// @ts-expect-error Node's built-in module is available in the configured test runtime.
import * as nodeFs from "node:fs";
import { opponentHistoryBody } from "../worker/src/views/opponent-history";
import { queryOpponentHistory } from "../worker/src/core/opponent-history";
import type { SeasonSplitCatalog } from "../worker/src/core/season-splits";

const snapshot = "b".repeat(64);
const request = { schema_version: 1, competition: "PL", seasons: ["2024-25"], group_by: "opponent", venue: null, opponent_id: "club:1001" };
const catalog = { snapshot_id: snapshot, seasons: [{ season: "2024-25", coverage: "complete" }] } as SeasonSplitCatalog;
const result = queryOpponentHistory(request, catalog, []);
const { readFileSync } = nodeFs as unknown as { readFileSync(path: URL, encoding: "utf8"): string };

describe("opponent history narrow table layout", () => {
  it("marks the opponent history scroll region and keeps keyboard focusability", () => {
    const html = opponentHistoryBody({ result, credits: {} }, "en");
    expect(html).toContain('<div class="comparison-table opponent-history-table" role="region" tabindex="0"');
  });

  it("sticks the season labels only inside a narrow-screen opponent-history rule", () => {
    const css = readFileSync(new URL("../worker/public/style.css", import.meta.url), "utf8");
    const media = css.match(/@media\s*\(max-width:\s*620px\)\s*\{([\s\S]*?)\n\}/g)?.join("\n") ?? "";
    expect(media).toMatch(/\.opponent-history-table\s*>\s*table\s*\{[^}]*min-width:\s*\d{3,}px/s);
    expect(media).toMatch(/\.opponent-history-table\s+th:first-child[^}]*position:\s*sticky/s);
    expect(media).toMatch(/\.opponent-history-table\s+td:first-child[^}]*position:\s*sticky/s);
    expect(media).toMatch(/\.opponent-history-table\s+th:first-child[^}]*background:/s);
  });
});
