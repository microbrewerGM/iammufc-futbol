/**
 * TypeScript feasibility must agree with pipeline/contracts/feasibility.py.
 * These mirror tests/test_feasibility.py case for case -- the two resolvers
 * sit on opposite sides of the same catalog and must refuse identically.
 */

import { describe, expect, it } from "vitest";

import { Catalog, type CompiledCatalog } from "../worker/src/core/feasibility";
import { withDefaults, type QueryIntent, type VizType } from "../worker/src/core/intent";
import compiled from "../worker/src/generated/catalog.json" with { type: "json" };

const catalog = new Catalog(compiled as unknown as CompiledCatalog);

function intent(over: Partial<QueryIntent> = {}): QueryIntent {
  return withDefaults({
    metric: "goals",
    entity_type: "player",
    entity_id: "p1",
    season: "2024-25",
    viz: "bar",
    ...over,
  });
}

describe("feasible queries", () => {
  it("resolves a covered box-score metric", () => {
    const r = catalog.checkFeasibility(intent());
    expect(r.state).toBe("computable_now_queued");
    expect(r.source_name).toBe("Fantasy Premier League public API");
  });

  it("carries attribution with the result", () => {
    // Attribution renders from lineage. If it does not arrive here, the page
    // has nothing to render and we ship an unattributed artifact.
    const r = catalog.checkFeasibility(intent());
    expect(r.attribution_text).toContain("Fantasy Premier League");
  });

  it("returns available for an already-materialised artifact", () => {
    expect(catalog.checkFeasibility(intent(), true).state).toBe("available");
  });
});

describe("refusals", () => {
  it("refuses pitch overlays as NO_DATA", () => {
    // Free republishable Man United event coordinates cover 2017-18 only, and
    // that is not ingested yet.
    const r = catalog.checkFeasibility(intent({ viz: "shot_map" as VizType }));
    expect(r.state).toBe("not_computable_data_missing");
    expect(r.reason).toContain("event_with_coords");
  });

  it("offers an alternative that is itself feasible", () => {
    const r = catalog.checkFeasibility(intent({ viz: "shot_map" as VizType }));
    expect(r.nearest_alternative).toBeTruthy();
    // Otherwise we have only moved the lie one hop further down.
    expect(catalog.checkFeasibility(r.nearest_alternative!).state).toBe("computable_now_queued");
  });

  it("refuses an uncovered season as NO_DATA", () => {
    const r = catalog.checkFeasibility(intent({ season: "2013-14" }));
    expect(r.state).toBe("not_computable_data_missing");
    expect(r.reason).toContain("2013-14");
  });

  it("distinguishes NO_RIGHTS from NO_DATA", () => {
    // The distinction is the point: NO_DATA is a gap we could close by
    // integrating a source; NO_RIGHTS may never close without a licence.
    const r = catalog.checkFeasibility(intent({ metric: "progressive_passes" }));
    expect(r.state).toBe("not_computable_no_rights");
    expect(r.reason).toContain("FBref");
    expect(r.reason).toContain("redistribution");
  });

  it("rejects a hallucinated metric via the catalog, not the model", () => {
    const r = catalog.checkFeasibility(intent({ metric: "vibes_per_90" }));
    expect(r.state).toBe("not_computable_data_missing");
    expect(r.reason).toContain("vibes_per_90");
  });
});

describe("never optimistic", () => {
  it("refuses every combination absent from the coverage matrix", () => {
    const covered = new Set(
      catalog.coverage.filter((c) => c.redistributable).map((c) => `${c.metric}/${c.season}`),
    );
    const feasibleStates = new Set([
      "available",
      "computable_now_queued",
      "computable_but_expensive",
    ]);

    for (const metric of ["goals", "assists", "minutes", "points", "xg", "progressive_passes"]) {
      for (const season of ["2013-14", "2017-18", "2023-24", "2024-25", "2025-26", "2030-31"]) {
        const r = catalog.checkFeasibility(intent({ metric, season }));
        expect(
          feasibleStates.has(r.state),
          `${metric}/${season} resolved ${r.state}`,
        ).toBe(covered.has(`${metric}/${season}`));
      }
    }
  });
});

describe("builder support", () => {
  it("exposes only servable seasons, so infeasible picks are unselectable", () => {
    // All ten seasons for a metric with full coverage.
    expect(catalog.seasonsFor("goals", "player", "box_score")).toEqual([
      "2025-26",
      "2024-25",
      "2023-24",
      "2022-23",
      "2021-22",
      "2020-21",
      "2019-20",
      "2018-19",
      "2017-18",
      "2016-17",
    ]);
    // xg only from 2022-23 -- FPL did not publish expected_goals earlier, and
    // the builder must not offer a season it cannot actually serve.
    expect(catalog.seasonsFor("xg", "player", "box_score")).toEqual([
      "2025-26",
      "2024-25",
      "2023-24",
      "2022-23",
    ]);
    // progressive_passes has a cell, but a non-redistributable one.
    expect(catalog.seasonsFor("progressive_passes", "player", "box_score")).toEqual([]);
  });
});

describe("alternative fallbacks", () => {
  it("offers a feasible alternative even for a wholly uncovered season", () => {
    // Without the third fallback rule this was a bare refusal and a dead end.
    const r = catalog.checkFeasibility(intent({ season: "2022-23", viz: "shot_map" as VizType }));
    expect(r.state).toBe("not_computable_data_missing");
    expect(r.nearest_alternative).toBeTruthy();
    expect(catalog.checkFeasibility(r.nearest_alternative!).state).toBe("computable_now_queued");
  });

  it("invents nothing when no alternative exists", () => {
    // Honesty cuts both ways -- a plausible-looking suggestion we cannot serve
    // would be worse than admitting there is nothing.
    const r = catalog.checkFeasibility(intent({ metric: "progressive_passes" }));
    expect(r.state).toBe("not_computable_no_rights");
    expect(r.nearest_alternative ?? null).toBeNull();
  });
});
