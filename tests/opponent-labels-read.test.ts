import { describe, expect, it } from "vitest";
import { readOpponentLabels } from "../worker/src/core/db";
import { queryOpponentHistory } from "../worker/src/core/opponent-history";
import { opponentHistoryBody } from "../worker/src/views/opponent-history";

describe("readOpponentLabels", () => {
  it("reads only approved IDs for the requested snapshot with bounded parameters", async () => {
    const seen: { sql?: string; bindings?: unknown[] } = {};
    const env = { DB: { prepare(sql: string) { seen.sql = sql; return { bind(...bindings: unknown[]) {
      seen.bindings = bindings;
      return { all: async () => ({ results: [
        { opponent_id: "club:1001", label: "United", snapshot_id: "a".repeat(64) },
        { opponent_id: "club:1002", label: "<img src=x>", snapshot_id: "a".repeat(64) },
      ] }) };
    } }; } } } as never;
    const labels = await readOpponentLabels(env, "a".repeat(64), ["club:1001", "club:9999", "club:1001"]);
    expect(labels).toEqual(new Map([["club:1001", "United"]]));
    expect(seen.sql).toContain("FROM opponent_labels");
    expect(seen.sql).toContain("snapshot_id = ?");
    expect(seen.sql).toContain("LIMIT 45");
    expect(seen.bindings).toEqual(["a".repeat(64), "club:1001"]);
  });

  it("returns an empty map for no IDs and rejects invalid snapshots", async () => {
    const env = { DB: { prepare() { throw new Error("query should not run"); } } } as never;
    expect(await readOpponentLabels(env, "a".repeat(64), [])).toEqual(new Map());
    await expect(readOpponentLabels(env, "bad", ["club:1001"])).rejects.toThrow();
  });

  it.each(["en", "es"] as const)("escapes a D1 label in opponent history for %s", (locale) => {
    const history = queryOpponentHistory(
      { schema_version: 1, competition: "PL", seasons: ["2024-25"], group_by: "opponent", venue: null, opponent_id: "club:1001" },
      { snapshot_id: "a".repeat(64), seasons: [{ season: "2024-25", coverage: "complete" }] },
      [],
    );
    const body = opponentHistoryBody({ result: history, opponentLabel: '<img src=x onerror="bad()">', credits: {} }, locale);
    expect(body).not.toMatch(/<img\b/);
    expect(body).toContain("&lt;img src=x onerror=&quot;bad()&quot;&gt;");
  });
});
