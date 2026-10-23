import { describe, expect, it } from "vitest";
import { clHistoryRows } from "../worker/src/core/cl-history";
import type { Env } from "../worker/src/core/db";
import type { CompiledCatalog } from "../worker/src/core/feasibility";

const snapshot = "a".repeat(64);
const coverage = (seasons: string[]) => seasons.map((season) => ({
  metric: "goals", entity_type: "season", granularity: "box_score" as const, season,
  competition: "CL", source_id: "openfootball", redistributable: true, cost_class: "cheap" as const,
  attribution_asset: null, attribution_text: null, attribution_text_es: null, source_name: "OpenFootball",
}));
const catalog = (seasons: string[]): CompiledCatalog => ({ version: 1, metrics: [], coverage: coverage(seasons) });

function fakeDb(rows: Record<string, unknown>[], current = snapshot) {
  const calls: { sql: string; bindings: unknown[] }[] = [];
  const DB = { prepare(sql: string) {
    let bindings: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) { bindings = values; return statement; },
      async first<T>() { calls.push({ sql, bindings }); return { snapshot_id: current } as T; },
      async all<T>() { calls.push({ sql, bindings }); return { results: rows as T[] }; },
    };
    return statement;
  } };
  return { env: { DB } as unknown as Env, calls };
}
const row = (season: string, patch: Record<string, unknown> = {}) => ({
  season, played: 2, won: 1, drawn: 1, lost: 0, goals: 0, goals_against: 0, snapshot_id: snapshot, ...patch,
});

describe("Champions League history query", () => {
  it("returns an empty list for empty coverage and does not query season_stats", async () => {
    const store = fakeDb([]);
    expect(await clHistoryRows(store.env, catalog([]))).toEqual({ snapshot_id: snapshot, entries: [] });
    expect(store.calls).toHaveLength(1);
  });

  it("returns observed rows in ascending order with explicit gaps and exact parameterized SQL", async () => {
    const store = fakeDb([row("2024-25"), row("2016-17")]);
    const result = await clHistoryRows(store.env, catalog(["2024-25", "2016-17", "2017-18"]));
    expect(result.entries).toEqual([
      { status: "observed", row: row("2016-17") },
      { status: "gap", season: "2017-18" },
      { status: "observed", row: row("2024-25") },
    ]);
    expect(store.calls[1]).toEqual({
      sql: `SELECT season, played, won, drawn, lost, goals, goals_against, snapshot_id
       FROM season_stats
      WHERE competition = ? AND season IN (?, ?, ?)
      ORDER BY season ASC LIMIT 4`,
      bindings: ["CL", "2016-17", "2017-18", "2024-25"],
    });
  });

  it("rejects duplicate rows, invalid counts, and mixed snapshots", async () => {
    await expect(clHistoryRows(fakeDb([row("2016-17"), row("2016-17")]).env, catalog(["2016-17"])))
      .rejects.toThrow("invalid CL history row");
    await expect(clHistoryRows(fakeDb([row("2016-17", { won: 3 })]).env, catalog(["2016-17"])))
      .rejects.toThrow("invalid CL history row");
    await expect(clHistoryRows(fakeDb([row("2016-17", { snapshot_id: "b".repeat(64) })]).env, catalog(["2016-17"])))
      .rejects.toThrow("invalid CL history row");
  });

  it("does not derive coverage from unapproved cells", async () => {
    const other = coverage(["2016-17"])[0]!;
    const store = fakeDb([]);
    expect(await clHistoryRows(store.env, { ...catalog([]), coverage: [{ ...other, competition: "PL" }] }))
      .toEqual({ snapshot_id: snapshot, entries: [] });
  });
});
