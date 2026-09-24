import { afterEach, describe, expect, it, vi } from "vitest";
import {
  comparisonIntent,
  executeComparison,
  parseComparison,
  rankComparison,
  type ComparisonRow,
} from "../worker/src/core/comparison";
import { artifactKey, canonicalize } from "../worker/src/core/intent";
import { Catalog, type CompiledCatalog, type FeasibilityState } from "../worker/src/core/feasibility";
import { validateQuerySemantics } from "../worker/src/core/validate-intent";
import { comparisonPage } from "../worker/src/views/comparison";
import { LOCALES } from "../worker/src/core/locale";
import type { Env } from "../worker/src/core/db";
import compiled from "../worker/src/generated/catalog.json";

const catalog = new Catalog(compiled as unknown as CompiledCatalog);
const row = (id: string, total: number | null, minutes: number | null): ComparisonRow => ({
  player_id: id,
  label: id,
  total,
  minutes,
  snapshot_id: "synthetic",
});
const request = { season: "2024-25", metric: "goals" as const, minMinutes: 450 };

afterEach(() => vi.restoreAllMocks());

describe("per-90 comparison", () => {
  it("uses the denominator and threshold without turning missingness into zero", () => {
    const rows = [
      row("two", 2, 180),
      row("zero", 0, 450),
      row("below", 8, 449),
      row("boundary", 5, 450),
      row("null", null, 450),
      row("missing-minutes", 1, null),
      row("zero-minutes", 5, 0),
      row("invalid", -1, 500),
      row("fractional", 1.5, 500),
      row("infinity", Infinity, 500),
    ];
    expect(rankComparison(rows, 180).find((candidate) => candidate.player_id === "two")?.rate).toBe(1);
    expect(rankComparison(rows, 450).map((candidate) => candidate.player_id)).toEqual([
      "boundary",
      "zero",
    ]);
    expect(rankComparison(rows, 0).some((candidate) => candidate.player_id === "zero-minutes")).toBe(false);
  });

  it("orders exact rates before display rounding and ties stably", () => {
    const rows = [
      row("z", 2, 180),
      row("b", 5, 450),
      row("a", 5, 450),
      row("higher", 1112, 100000),
      row("lower", 1111, 100000),
    ];
    expect(rankComparison(rows, 0).map((candidate) => candidate.player_id)).toEqual([
      "higher",
      "a",
      "b",
      "z",
      "lower",
    ]);
    expect(rankComparison([...rows].reverse(), 0)).toEqual(rankComparison(rows, 0));
  });

  it("validates controls and makes the threshold part of canonical identity", async () => {
    const normalized = parseComparison(new URLSearchParams("min_minutes=00450"), "2024-25")!;
    expect(normalized).toEqual(request);
    for (const query of [
      "metric=xg",
      "min_minutes=-1",
      "min_minutes=1.5",
      "min_minutes=20001",
      "metric=goals&metric=assists",
      "extra=1",
    ]) {
      expect(parseComparison(new URLSearchParams(query), "2024-25")).toBeNull();
    }
    const intent = comparisonIntent(request);
    expect(canonicalize(comparisonIntent(normalized))).toBe(canonicalize(intent));
    expect(canonicalize(intent)).toContain(
      '"filters":{"comparison_version":"1","min_minutes":"450","normalization":"per90"}',
    );
    expect(await artifactKey(intent, "synthetic")).not.toBe(
      await artifactKey(comparisonIntent({ ...request, minMinutes: 451 }), "synthetic"),
    );
    expect(validateQuerySemantics(intent)?.field).toBe("filters");
  });

  it.each<FeasibilityState>(["no_rights", "no_data", "computable_but_expensive"])(
    "refuses %s before SQL",
    async (state) => {
      const prepare = vi.fn();
      const env = { DB: { prepare } } as unknown as Env;
      vi.spyOn(Catalog.prototype, "checkFeasibility").mockReturnValue({
        state,
        reason: "Synthetic refusal",
        cost_class: "cheap",
      });
      expect((await executeComparison(env, catalog, request)).ok).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
    },
  );

  it("requires numerator and denominator to share the supported source", async () => {
    const prepare = vi.fn();
    const env = { DB: { prepare } } as unknown as Env;
    expect((await executeComparison(env, catalog, { ...request, season: "2000-01" })).ok).toBe(false);
    const altered = structuredClone(compiled) as unknown as CompiledCatalog;
    for (const cell of altered.coverage) {
      if (cell.metric === "minutes") cell.source_id = "different-provider-same-name";
    }
    expect((await executeComparison(env, new Catalog(altered), request)).ok).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("binds the selected season, rejects mixed snapshots, and localizes attribution", async () => {
    let rows = [row("Synthetic Alpha", 5, 450), { ...row("Synthetic Beta", 4, 500), snapshot_id: "other" }];
    const all = vi.fn(async () => ({ results: rows }));
    const bind = vi.fn((_season: string) => ({ all }));
    const prepare = vi.fn((_query: string) => ({ bind }));
    const env = { DB: { prepare } } as unknown as Env;
    expect((await executeComparison(env, catalog, request)).ok).toBe(false);
    expect(bind).toHaveBeenCalledWith("2024-25");
    expect(prepare.mock.calls[0]![0]).toContain("p.team = 'Manchester United'");

    rows = [row("Synthetic Alpha", 5, 450), row("Synthetic Beta", 4, 500)];
    const result = await executeComparison(env, catalog, request, "es");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attribution).toContain("Datos de jugadores derivados");
    const body = await comparisonPage(request, result, ["2024-25"], LOCALES.es).text();
    expect(body).toContain("<table>");
    expect(body).toContain("Synthetic Alpha");
    expect(body).toContain('name="min_minutes"');
    expect(body).toContain("450");
    expect(body).toContain("min_minutes=450");
    expect(body).toContain("atribuidos solo a partidos");
    expect(body).not.toContain("No se ha verificado");
  });
});
