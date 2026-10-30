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
      sql,
      bind(...values: unknown[]) { bindings = values; return statement; },
      async first<T>() { calls.push({ sql, bindings }); return { snapshot_id: current } as T; },
      async all<T>() { calls.push({ sql, bindings }); return { results: rows as T[] }; },
    };
    return statement;
  },
    batch: async (statements: { sql: string; all: () => Promise<unknown> }[]) => Promise.all(statements.map(async (item) => {
      const result = await item.all() as { results: unknown[] };
      return /FROM snapshots/.test(item.sql) ? { results: [{ snapshot_id: current, sources_json: "{}" }] } : result;
    })),
  };
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

  it("returns observed rows newest first with explicit gaps and exact parameterized SQL", async () => {
    const store = fakeDb([row("2024-25"), row("2016-17")]);
    const result = await clHistoryRows(store.env, catalog(["2024-25", "2016-17", "2017-18"]));
    expect(result.entries).toEqual([
      { status: "observed", row: { ...row("2024-25"), stage_reached: null } },
      { status: "gap", season: "2017-18" },
      { status: "observed", row: { ...row("2016-17"), stage_reached: null } },
    ]);
    expect(store.calls[1]).toEqual({
      sql: `SELECT s.season, s.played, s.won, s.drawn, s.lost, s.goals, s.goals_against, s.snapshot_id,
              st.stage_reached, st.snapshot_id AS stage_snapshot_id
       FROM season_stats s
       LEFT JOIN cl_season_stage st
         ON st.season = s.season
        AND st.snapshot_id = (SELECT snapshot_id FROM
          snapshots AS current_snapshot ORDER BY created_at DESC LIMIT 1)
      WHERE s.competition = ? AND s.season IN (?, ?, ?)
      ORDER BY s.season DESC LIMIT 4`,
      bindings: ["CL", "2024-25", "2017-18", "2016-17"],
    });
  });

  it("rejects coverage larger than the hard cap of 20 seasons", async () => {
    const seasons = Array.from({ length: 21 }, (_, i) => `${2000 + i}-${String((2001 + i) % 100).padStart(2, "0")}`);
    await expect(clHistoryRows(fakeDb([]).env, catalog(seasons))).rejects.toThrow("invalid CL history coverage");
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
