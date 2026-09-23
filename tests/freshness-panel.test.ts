import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import { freshnessPanel, type FreshnessView } from "../worker/src/views/pages";

const current: FreshnessView = {
  state: "current",
  coverageThrough: "2025-26",
  lastSuccessfulLoadAt: "2026-09-23T12:00:01.000Z",
  sources: [
    { id: "fpl", status: "observed", coverageThrough: "2025-26", retrievedAt: "2026-09-23T12:00:00.000Z", sourceAsOf: null },
    { id: "football_data_couk", status: "observed", coverageThrough: "2025-26", retrievedAt: "2026-09-23T12:00:00.000Z", sourceAsOf: null },
    { id: "openfootball_cl", status: "observed", coverageThrough: "2023-24", retrievedAt: "2026-09-23T12:00:00.000Z", sourceAsOf: null },
  ],
};

describe("freshness panel", () => {
  it("renders distinct truthful English freshness fields without raw metadata", () => {
    const markup = freshnessPanel(current, LOCALES.en);
    expect(markup).toContain("Data freshness");
    expect(markup).toContain("Coverage through 2025-26.");
    expect(markup).toContain("Last successful load:");
    expect(markup).toContain("Source as-of date not provided.");
    expect(markup).toContain("Football-Data.co.uk");
    expect(markup).not.toMatch(/snapshot|source_status_json|sources_json|row_counts|\{\"/);
  });

  it("renders controlled Spanish copy without an English fallback", () => {
    const markup = freshnessPanel(current, LOCALES.es);
    expect(markup).toContain("Actualización de los datos");
    expect(markup).toContain("Última carga correcta:");
    expect(markup).toContain("La fuente no proporciona una fecha de vigencia.");
    expect(markup).not.toContain("Last successful load");
  });

  it("describes optional-source absence as missing, never zero or stale", () => {
    const degraded: FreshnessView = {
      ...current,
      state: "degraded",
      sources: current.sources.map((source) =>
        source.id === "openfootball_cl"
          ? { ...source, status: "unavailable", coverageThrough: null, retrievedAt: null }
          : source,
      ),
    };
    const markup = freshnessPanel(degraded, LOCALES.en);
    expect(markup).toContain("optional source was unavailable");
    expect(markup).toContain("absent, not zero");
    expect(markup).toContain("Not retrieved in the last load");
    expect(markup).not.toMatch(/Coverage through null|Retrieved: null/);
  });

  it.each(["inconsistent", "unavailable"] as const)("withholds dates for %s metadata", (state) => {
    const markup = freshnessPanel({ state }, LOCALES.en);
    expect(markup).not.toContain("<time");
    expect(markup).not.toContain("<ul>");
    expect(markup).not.toContain("Last successful load");
  });

  it("keeps source as-of separate from retrieval and escapes dynamic values", () => {
    const view = {
      ...current,
      coverageThrough: '<script>alert("season")</script>',
      lastSuccessfulLoadAt: '<script>alert("load")</script>',
      sources: current.sources.map((source, index) =>
        index === 0 ? { ...source, sourceAsOf: "2026-09-22T00:00:00.000Z" } : source,
      ),
    } as FreshnessView;
    const markup = freshnessPanel(view, LOCALES.en);
    expect(markup).toContain("2026-09-22T00:00:00.000Z");
    expect(markup).toContain("2026-09-23T12:00:00.000Z");
    expect(markup).not.toContain("<script>");
  });
});

