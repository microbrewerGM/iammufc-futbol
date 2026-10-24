import { describe, expect, it } from "vitest";
import { managerEraFacts, queryManagerEras, type Env } from "../worker/src/core/manager-era";

const snapshot = "a".repeat(64);
const seasons = ["2023-24", "2024-25"];
const lineage = ["openfootball_cl"];
const coverage = seasons.map(season => ({ snapshot_id: snapshot, season, coverage: "complete", completed: 10, unfinished: 0, ambiguous: 0, lineage }));
const era = [
  { snapshot_id: snapshot, season: seasons[0], tenure_id: "tenure:one", manager_id: "manager:one", role: "manager", played: 3, won: 2, drawn: 1, lost: 0, goals_for: 5, goals_against: 2, lineage },
  { snapshot_id: snapshot, season: seasons[1], tenure_id: "tenure:one", manager_id: "manager:one", role: "manager", played: 2, won: 1, drawn: 0, lost: 1, goals_for: 3, goals_against: 3, lineage },
];
const unassigned = [{ snapshot_id: snapshot, season: seasons[0], reason: "date_uncertain", played: 1, won: 0, drawn: 1, lost: 0, goals_for: 1, goals_against: 1, lineage }];
const managers = [{ snapshot_id: snapshot, manager_id: "manager:one", label: "Manager One", lineage }];

describe("manager era reader and summarizer", () => {
  it("sums selected seasons per tenure and returns points, reason totals and coverage", () => {
    const result = queryManagerEras(snapshot, seasons, era, unassigned, managers, coverage);
    expect(result.eras).toEqual([{ tenure_id: "tenure:one", manager_id: "manager:one", manager: "Manager One", role: "manager",
      played: 5, won: 3, drawn: 1, lost: 1, goals_for: 8, goals_against: 5, points: 10 }]);
    expect(result.managers[0]).toMatchObject({ selected_window: false });
    expect(result.unassigned).toEqual([{ reason: "date_uncertain", played: 1, won: 0, drawn: 1, lost: 0, goals_for: 1, goals_against: 1, points: 1 }]);
    expect(result.coverage.map(row => row.coverage)).toEqual(["complete", "complete"]);
  });

  it("reports missing coverage without treating that season as zero", () => {
    const result = queryManagerEras(snapshot, [seasons[0], seasons[1]], [...era, { ...era[0], season: "2025-26" }], [], managers, [coverage[0]]);
    expect(result.coverage[1]).toMatchObject({ season: seasons[1], coverage: "missing" });
    expect(result.eras[0]?.played).toBe(3);
    expect(result.managers[0]?.selected_window).toBe(true);
  });

  it("reports partial coverage and excludes its rows from totals", () => {
    const partialCoverage = { ...coverage[1], coverage: "partial" as const };
    const partialEra = { ...era[1], played: 10, won: 5, drawn: 3, lost: 2 };
    const partialUnassigned = { ...unassigned[0]!, season: seasons[1], played: 10, won: 5, drawn: 3, lost: 2 };
    const result = queryManagerEras(snapshot, seasons, era.map(row => row.season === seasons[1] ? partialEra : row),
      [unassigned[0]!, partialUnassigned], managers, [coverage[0], partialCoverage]);
    expect(result.coverage[1]).toMatchObject({ season: seasons[1], coverage: "partial" });
    expect(result.eras[0]?.played).toBe(3);
    expect(result.unassigned[0]?.played).toBe(1);
  });

  it("rejects mixed snapshots and malformed projections", () => {
    expect(() => queryManagerEras(snapshot, seasons, [{ ...era[0], snapshot_id: "b".repeat(64) }], [], managers, coverage)).toThrow();
    expect(() => queryManagerEras(snapshot, seasons, [{ ...era[0], won: 1 }], [], managers, coverage)).toThrow();
  });

  it("uses parameterized bounded reads against fake D1", async () => {
    const executed: { sql: string; bindings: unknown[] }[] = [];
    const tables: Record<string, Record<string, unknown>[]> = {
      manager_era_season_records: era,
      manager_era_season_unassigned: unassigned,
      manager_era_season_coverage: coverage,
      manager_era_managers: managers,
    };
    const db = { prepare(sql: string) {
      let bindings: unknown[] = [];
      const statement = { bind(...values: unknown[]) { bindings = values; return statement; },
        first: async () => ({ snapshot_id: snapshot }),
        all: async () => {
          executed.push({ sql, bindings });
          const table = Object.keys(tables).find(name => sql.includes(`FROM ${name}`));
          if (!table) return { results: [] };
          const sourceRows = tables[table]!;
          const chosen = table === "manager_era_managers" || table === "manager_era_season_records" ? sourceRows : sourceRows.filter(row => bindings.slice(1).includes(row.season));
          return { results: chosen.map(row => ({ ...row, lineage_json: JSON.stringify(row.lineage) })) };
        } };
      return statement;
    } };
    const result = await managerEraFacts({ DB: db } as unknown as Env, snapshot, seasons);
    expect(result.eras[0]?.points).toBe(10);
    expect(executed).toHaveLength(4);
    expect(executed.every(q => q.sql.includes("LIMIT") && q.sql.includes("?") && !q.sql.includes(seasons[0]!))).toBe(true);
  });
});
