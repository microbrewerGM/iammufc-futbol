import { describe, expect, it } from "vitest";

import { decodeCompiledCatalog } from "../worker/src/core/catalog-contract";
import compiled from "../worker/src/generated/catalog.json" with { type: "json" };

type MutableCatalog = {
  version: unknown;
  metrics: Array<Record<string, unknown>>;
  coverage: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

function candidate(): MutableCatalog {
  return structuredClone(compiled) as unknown as MutableCatalog;
}

describe("season split catalog metadata", () => {
  it("accepts optional season split metadata separately from metric coverage", () => {
    const value = candidate();
    value.output_coverage = [{ output_id: "season_splits", state: "unknown" }];

    const decoded = decodeCompiledCatalog(value);

    expect(decoded.output_coverage).toEqual([
      { output_id: "season_splits", state: "unknown" },
    ]);
    expect(decoded.coverage.some((cell) => cell.entity_type === "venue")).toBe(false);
  });

  it("keeps older catalogs valid without output coverage", () => {
    const value = candidate();
    delete value.output_coverage;

    expect(decodeCompiledCatalog(value).output_coverage).toEqual([]);
  });

  it("rejects invalid IDs, states, private fields and duplicate output IDs", () => {
    for (const output_coverage of [
      [{ output_id: "venue", state: "clear" }],
      [{ output_id: "season_splits", state: "loaded" }],
      [{ output_id: "season_splits", state: "unknown", private_note: "hidden" }],
      [
        { output_id: "season_splits", state: "unknown" },
        { output_id: "season_splits", state: "partial" },
      ],
    ]) {
      const value = candidate();
      value.output_coverage = output_coverage;
      expect(() => decodeCompiledCatalog(value)).toThrow();
    }
  });
});
