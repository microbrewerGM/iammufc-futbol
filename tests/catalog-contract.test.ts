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

function first(values: Array<Record<string, unknown>>): Record<string, unknown> {
  const value = values[0];
  if (!value) throw new Error("test fixture must not be empty");
  return value;
}

describe("committed public catalog contract", () => {
  it("decodes the committed artifact", () => {
    const decoded = decodeCompiledCatalog(compiled);
    expect(decoded.metrics).toHaveLength(6);
    expect(decoded.coverage).toHaveLength(59);
  });

  it("rejects extra private fields and wrong primitive or enum types", () => {
    const extra = candidate();
    extra.private_notes = "forbidden";
    expect(() => decodeCompiledCatalog(extra)).toThrow(/must contain exactly/);

    const wrongBoolean = candidate();
    first(wrongBoolean.coverage).redistributable = 1;
    expect(() => decodeCompiledCatalog(wrongBoolean)).toThrow(/must be boolean/);

    const badEnum = candidate();
    first(badEnum.metrics).granularity = "invented";
    expect(() => decodeCompiledCatalog(badEnum)).toThrow(/unsupported value/);
  });

  it("rejects duplicate metric ids and coverage cells", () => {
    const duplicateMetric = candidate();
    duplicateMetric.metrics.push(structuredClone(first(duplicateMetric.metrics)));
    expect(() => decodeCompiledCatalog(duplicateMetric)).toThrow(/duplicate metric_id/);

    const duplicateCell = candidate();
    duplicateCell.coverage.push(structuredClone(first(duplicateCell.coverage)));
    expect(() => decodeCompiledCatalog(duplicateCell)).toThrow(/duplicate coverage cell/);
  });

  it("rejects missing metrics, granularity drift and inconsistent source display", () => {
    const missingMetric = candidate();
    first(missingMetric.coverage).metric = "missing";
    expect(() => decodeCompiledCatalog(missingMetric)).toThrow(/references missing metric/);

    const granularityDrift = candidate();
    first(granularityDrift.coverage).granularity = "tracking";
    expect(() => decodeCompiledCatalog(granularityDrift)).toThrow(/granularity disagrees/);

    const sourceDrift = candidate();
    const sourceId = first(sourceDrift.coverage).source_id;
    const sameSource = sourceDrift.coverage.slice(1).find((cell) => cell.source_id === sourceId);
    expect(sameSource).toBeDefined();
    sameSource!.source_name = "inconsistent source name";
    expect(() => decodeCompiledCatalog(sourceDrift)).toThrow(/source display disagrees/);
  });

  it("rejects unsafe contract edges", () => {
    const allowed = candidate();
    first(allowed.metrics).label_en = "";
    const fbref = allowed.coverage.find((cell) => cell.source_id === "fbref");
    expect(fbref).toBeDefined();
    fbref!.attribution_text = "";
    expect(() => decodeCompiledCatalog(allowed)).not.toThrow();

    const excessiveDecimals = candidate();
    first(excessiveDecimals.metrics).decimals = 7;
    expect(() => decodeCompiledCatalog(excessiveDecimals)).toThrow(/0 through 6/);

    const whitespaceSeason = candidate();
    first(whitespaceSeason.coverage).season = " ";
    expect(() => decodeCompiledCatalog(whitespaceSeason)).toThrow(/non-empty string/);

    const badSource = candidate();
    first(badSource.coverage).source_id = "Bad-Source";
    expect(() => decodeCompiledCatalog(badSource)).toThrow(/source_id.*public contract/);
  });
});
