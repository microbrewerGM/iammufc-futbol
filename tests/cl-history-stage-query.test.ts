import { describe, expect, it } from "vitest";
import { clHistoryRows } from "../worker/src/core/cl-history";
import type { Env } from "../worker/src/core/db";
import type { CompiledCatalog } from "../worker/src/core/feasibility";

const snapshot = "a".repeat(64);
const seasons = ["2024-25", "2023-24"];
const catalog = { version: 1, metrics: [], coverage: seasons.map((season) => ({ metric: "goals", entity_type: "season", granularity: "box_score", season, competition: "CL", source_id: "openfootball", redistributable: true, cost_class: "cheap", attribution_asset: null, attribution_text: null, attribution_text_es: null, source_name: "OpenFootball" })) } as CompiledCatalog;
const totals = (season: string) => ({ season, played: 2, won: 1, drawn: 1, lost: 0, goals: 3, goals_against: 2, snapshot_id: snapshot });
const stage = (season: string, stage_reached: unknown = "semi_final", snapshot_id: unknown = snapshot) => ({ season, stage_reached, snapshot_id });

function fakeDb(stageRows: unknown[] = [], totalRows: unknown[] = [totals(seasons[0]!)]) {
  const calls: string[] = [];
  const DB = {
    prepare(sql: string) { const statement = { sql, bind() { return statement; } }; return statement; },
    async batch(statements: { sql: string }[]) {
      return statements.map(({ sql }) => {
        calls.push(sql);
        if (/FROM snapshots/.test(sql)) return { results: [{ snapshot_id: snapshot, sources_json: "{}" }] };
        return { results: totalRows.map((row) => {
          const season = (row as { season: string }).season;
          const match = stageRows.find((candidate) => (candidate as { season: string }).season === season) as { stage_reached: unknown; snapshot_id: unknown } | undefined;
          return { ...(row as Record<string, unknown>), stage_reached: match?.stage_reached ?? null, stage_snapshot_id: match?.snapshot_id ?? null };
        }) };
      });
    },
  };
  return { env: { DB } as unknown as Env, calls };
}

describe("CL stage history query", () => {
  it("reads stage rows in the snapshot batch and adds stage to observed records", async () => {
    const db = fakeDb([stage(seasons[0]!, "semi_final")]);
    const result = await clHistoryRows(db.env, catalog);
    expect(result.entries).toEqual([
      { status: "observed", row: { ...totals(seasons[0]!), stage_reached: "semi_final" } },
      { status: "gap", season: seasons[1] },
    ]);
    expect(db.calls).toHaveLength(2);
    expect(db.calls[1]).toContain("LEFT JOIN cl_season_stage");
    expect(db.calls[1]).toContain("snapshot_id = (SELECT snapshot_id FROM\n          snapshots");
  });

  it("leaves stage unavailable when the season has no stage row", async () => {
    const result = await clHistoryRows(fakeDb().env, catalog);
    expect(result.entries[0]).toMatchObject({ status: "observed", row: { stage_reached: null } });
  });

  it("rejects unknown codes and mismatched stage snapshots", async () => {
    await expect(clHistoryRows(fakeDb([stage(seasons[0]!, "group")]).env, catalog)).rejects.toThrow("invalid CL history row");
    await expect(clHistoryRows(fakeDb([stage(seasons[0]!, "semi_final", "b".repeat(64))]).env, catalog)).rejects.toThrow("invalid CL history row");
  });

  it("rejects duplicate season rows", async () => {
    await expect(clHistoryRows(fakeDb([], [totals(seasons[0]!), totals(seasons[0]!)]).env, catalog)).rejects.toThrow("invalid CL history row");
  });
});
