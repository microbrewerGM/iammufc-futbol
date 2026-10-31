import { describe, expect, it } from "vitest";
import { clHistoryRows } from "../worker/src/core/cl-history";
import type { Env } from "../worker/src/core/db";
import type { CompiledCatalog } from "../worker/src/core/feasibility";

const snapshot = "a".repeat(64);
const createdAt = "2026-10-31T07:50:00.000Z";
const seasons = ["2024-25", "2023-24"];
const catalog = { version: 1, metrics: [], coverage: seasons.map((season) => ({ metric: "goals", entity_type: "season", granularity: "box_score", season, competition: "CL", source_id: "openfootball", redistributable: true, cost_class: "cheap", attribution_asset: null, attribution_text: null, attribution_text_es: null, source_name: "OpenFootball" })) } as CompiledCatalog;
const totals = (season: string) => ({ season, played: 2, won: 1, drawn: 1, lost: 0, goals: 3, goals_against: 2, snapshot_id: snapshot });
const stage = (season: string, stage_reached: unknown = "semi_final", snapshot_id: unknown = snapshot) => ({ season, stage_reached, snapshot_id });

function fakeDb(stageRows: unknown[] = [], totalRows: unknown[] = [totals(seasons[0]!)], stageError?: Error, stageCreatedAt: unknown = createdAt) {
  const calls: string[] = [];
  const binds = new Map<string, unknown[]>();
  const DB = {
    prepare(sql: string) {
      const statement = { sql, bound: [] as unknown[], bind(...args: unknown[]) { statement.bound = args; binds.set(sql, args); return statement; }, async all<T>() {
        calls.push(sql);
        if (sql.includes("cl_season_stage")) {
          if (stageError) throw stageError;
          return { results: stageRows.map((row) => ({ ...(row as object), created_at: stageCreatedAt })) as T[] };
        }
        return { results: totalRows as T[] };
      } };
      return statement;
    },
    async batch(statements: { sql: string; all: () => Promise<unknown> }[]) {
      return Promise.all(statements.map(async ({ sql, all }) => {
        calls.push(sql);
        return /FROM snapshots/.test(sql)
          ? { results: [{ snapshot_id: snapshot, created_at: createdAt, sources_json: "{}" }] }
          : await all();
      }));
    },
  };
  return { env: { DB } as unknown as Env, calls, binds };
}

describe("CL stage history query", () => {
  it("reads stage rows separately and adds stage to observed records", async () => {
    const db = fakeDb([stage(seasons[0]!, "semi_final")]);
    const result = await clHistoryRows(db.env, catalog);
    expect(result.entries).toEqual([
      { status: "observed", row: { ...totals(seasons[0]!), stage_reached: "semi_final" } },
      { status: "gap", season: seasons[1] },
    ]);
    expect(db.calls).toHaveLength(4);
    expect(db.calls[2]).not.toContain("cl_season_stage");
    expect(db.calls[3]).toContain("FROM cl_season_stage");
    expect(db.calls[0]).toContain("SELECT snapshot_id, created_at, sources_json FROM snapshots");
    expect(db.calls[3]).toContain("JOIN snapshots");
    expect(db.calls[3]).toContain("snapshots.created_at");
    expect(db.binds.get(db.calls[3]!)).toEqual([...seasons, snapshot]);
  });

  it("serves totals with null stages when the stage table is missing", async () => {
    const result = await clHistoryRows(fakeDb([], [totals(seasons[0]!)], new Error("no such table: cl_season_stage")).env, catalog);
    expect(result.entries[0]).toEqual({ status: "observed", row: { ...totals(seasons[0]!), stage_reached: null } });
  });

  it("nulls only the stage cell with an unknown code", async () => {
    const db = fakeDb([stage(seasons[0]!, "group"), stage(seasons[1]!, "final")], [totals(seasons[0]!), totals(seasons[1]!)]);
    const result = await clHistoryRows(db.env, catalog);
    expect(result.entries).toEqual([
      { status: "observed", row: { ...totals(seasons[0]!), stage_reached: null } },
      { status: "observed", row: { ...totals(seasons[1]!), stage_reached: "final" } },
    ]);
  });

  it("nulls only the stage cell with a mismatched snapshot", async () => {
    const db = fakeDb([stage(seasons[0]!, "semi_final", "b".repeat(64)), stage(seasons[1]!, "final")], [totals(seasons[0]!), totals(seasons[1]!)]);
    const result = await clHistoryRows(db.env, catalog);
    expect(result.entries).toEqual([
      { status: "observed", row: { ...totals(seasons[0]!), stage_reached: null } },
      { status: "observed", row: { ...totals(seasons[1]!), stage_reached: "final" } },
    ]);
  });

  it("nulls all stages when the load token changes between reads", async () => {
    const db = fakeDb([stage(seasons[0]!, "semi_final"), stage(seasons[1]!, "final")],
      [totals(seasons[0]!), totals(seasons[1]!)], undefined, "2026-10-31T07:51:00.000Z");
    const result = await clHistoryRows(db.env, catalog);
    expect(result.entries).toEqual([
      { status: "observed", row: { ...totals(seasons[0]!), stage_reached: null } },
      { status: "observed", row: { ...totals(seasons[1]!), stage_reached: null } },
    ]);
  });

  it("nulls a season stage when duplicate stage rows are returned", async () => {
    const result = await clHistoryRows(fakeDb([stage(seasons[0]!, "semi_final"), stage(seasons[0]!, "final")],
      [totals(seasons[0]!)]).env, catalog);
    expect(result.entries[0]).toEqual({ status: "observed", row: { ...totals(seasons[0]!), stage_reached: null } });
  });

  it("rejects duplicate totals season rows", async () => {
    await expect(clHistoryRows(fakeDb([], [totals(seasons[0]!), totals(seasons[0]!)]).env, catalog)).rejects.toThrow("invalid CL history row");
  });
});
