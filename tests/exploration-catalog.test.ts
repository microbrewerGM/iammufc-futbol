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

describe("arrivals and manager catalog metadata", () => {
  it("accepts optional capability metadata without claiming availability", () => {
    const value = candidate();
    value.output_coverage = [{ output_id: "arrival_manager_groups", state: "unknown" }];

    expect(decodeCompiledCatalog(value).output_coverage).toContainEqual({
      output_id: "arrival_manager_groups",
      state: "unknown",
    });
  });

  it("rejects duplicate capability IDs, unsupported states and private fields", () => {
    for (const output_coverage of [
      [
        { output_id: "arrival_manager_groups", state: "unknown" },
        { output_id: "arrival_manager_groups", state: "partial" },
      ],
      [{ output_id: "arrival_manager_groups", state: "loaded" }],
      [{ output_id: "arrival_manager_groups", state: "unknown", private_note: "hidden" }],
      [
        { output_id: "shot_map", state: "unknown" },
        { output_id: "season_splits", state: "unknown" },
        { output_id: "arrival_manager_groups", state: "unknown" },
        { output_id: "extra", state: "unknown" },
      ],
    ]) {
      const value = candidate();
      value.output_coverage = output_coverage;
      expect(() => decodeCompiledCatalog(value)).toThrow();
    }
  });
});
