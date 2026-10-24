import { describe, expect, it } from "vitest";
import { calculatePlayerRange } from "../worker/src/core/player-range";
import type { PlayerRangeCatalog, PlayerRangeRequest, PlayerRangeRow } from "../worker/src/core/player-range";

const a = "fpl:code:101", b = "fpl:code:202", unknown = "fpl:code:303";
const catalog: PlayerRangeCatalog = { snapshot_id: "edge-snapshot", person_ids: [a, b], seasons: ["2024-25"] };
const request: PlayerRangeRequest = { schema_version: 1, competition: "PL", person_ids: [a, b], seasons: catalog.seasons,
  metric: "goals", normalization: "per90", min_minutes: 0, viz: "table" };
const fact = (person_id: string, total: number, minutes: number): PlayerRangeRow => ({ person_id, season: "2024-25",
  competition: "PL", metric: "goals", definition: "goals", total, minutes, snapshot_id: catalog.snapshot_id,
  lineage: [`synthetic:${person_id}`] });
const calculate = (rows: readonly unknown[], req: unknown = request) => calculatePlayerRange(req, catalog, rows);

describe("player range edge cases", () => {
  it("breaks exact per-90 ties by person_id using exact cross-multiplication", () => {
    // Fractions are equal (1/3 and 2/6); the smaller ID wins despite input order.
    expect(calculate([fact(b, 2, 6), fact(a, 1, 3)]).ranked_person_ids).toEqual([a, b]);
  });

  it.each([
    ["missing_row", [] as PlayerRangeRow[], { total: null, eligible_minutes: 0 }],
    ["missing_support", [{ ...fact(a, 9, 120), minutes: null }], { total: null, eligible_minutes: 0 }],
  ] as const)("marks %s as partial and never counts it as zero", (_name, rows, expected) => {
    const player = calculate(rows).players[0]!;
    expect(player.cells[0]!.reason).toBe(_name);
    expect(player).toMatchObject({ partial: true, missing_seasons: ["2024-25"], ...expected });
    expect(calculate(rows).ranked_person_ids).not.toContain(a);
  });

  it("keeps below-minimum and zero-minute players out of ranked IDs", () => {
    const rows = [fact(a, 1, 0), fact(b, 1, 89)];
    const result = calculate(rows, { ...request, min_minutes: 90 });
    expect(result.players.map(p => p.reasons)).toEqual([["zero_minutes", "below_minimum"], ["below_minimum"]]);
    expect(result.ranked_person_ids).toEqual([]);
  });

  it.each([
    ["mixed snapshots", [fact(a, 1, 90), { ...fact(b, 1, 90), snapshot_id: "other" }], "mixed snapshots"],
    ["duplicate facts", [fact(a, 1, 90), fact(a, 2, 90)], "duplicate fact"],
    ["unknown people", [{ ...fact(a, 1, 90), person_id: unknown }], "row identity"],
  ])("rejects %s", (_name, rows, error) => {
    expect(() => calculate(rows)).toThrow(error);
  });
});
