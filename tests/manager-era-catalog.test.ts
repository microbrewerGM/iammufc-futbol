import { describe, expect, it } from "vitest";

import { decodeCompiledCatalog } from "../worker/src/core/catalog-contract";
import { Catalog } from "../worker/src/core/feasibility";
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

describe("manager era catalog metadata", () => {
  it("accepts manager era output coverage and defaults a missing state to unknown", () => {
    const value = candidate();
    value.output_coverage = [{ output_id: "manager_era_records", state: "partial" }];
    const decoded = decodeCompiledCatalog(value);
    expect(decoded.output_coverage).toEqual([
      { output_id: "manager_era_records", state: "partial" },
    ]);
    expect(new Catalog(decoded).outputCapability("manager_era_records")).toBe("partial");

    delete value.output_coverage;
    expect(new Catalog(decodeCompiledCatalog(value)).outputCapability("manager_era_records")).toBe("unknown");
  });

  it("rejects unsupported manager era states", () => {
    const value = candidate();
    value.output_coverage = [{ output_id: "manager_era_records", state: "loaded" }];
    expect(() => decodeCompiledCatalog(value)).toThrow();
  });
});
