import { describe, expect, it } from "vitest";
import { Catalog, type CompiledCatalog, type FeasibilityResult } from "../worker/src/core/feasibility";
import type { ResultRow } from "../worker/src/core/db";
import { withDefaults } from "../worker/src/core/intent";
import { LOCALES } from "../worker/src/core/locale";
import { resultPanel } from "../worker/src/views/pages";
import compiled from "../worker/src/generated/catalog.json" with { type: "json" };

const catalog = new Catalog(compiled as unknown as CompiledCatalog);
const rows: ResultRow[] = [
  { label: "Alpha", route_key: "fpl:code:1", secondary: "FW", value: 7 },
  { label: "Beta", route_key: "fpl:code:2", secondary: "MF", value: 3 },
];
const feasible: FeasibilityResult = { state: "computable_now_queued", reason: "fixture", cost_class: "cheap" };

function render(
  language: "en" | "es",
  count: number,
  limit: number,
  entityType: "player" | "season" = "player",
  entityId = "all",
): string {
  const returnedRows = rows.slice(0, count);
  const intent = {
    ...withDefaults({ metric: "goals", entity_type: entityType, entity_id: entityId, season: "2025-26", competition: "PL", limit }),
    viz: "table" as const,
  };
  return resultPanel(intent, feasible, returnedRows, catalog, "count-fixture", LOCALES[language]);
}

describe("ask result count", () => {
  it.each([
    [1, 5, "Results shown: 1; requested: 5."],
    [2, 2, "Results shown: 2; requested: 2."],
    [2, 1, "Results shown: 2; requested: 1."],
  ])("shows returned and requested counts for %i rows with limit %i in English", (count, limit, copy) => {
    expect(render("en", count, limit)).toContain(copy);
  });

  it.each([
    [1, 5, "Resultados mostrados: 1; solicitados: 5."],
    [2, 2, "Resultados mostrados: 2; solicitados: 2."],
    [2, 1, "Resultados mostrados: 2; solicitados: 1."],
  ])("shows returned and requested counts for %i rows with limit %i in Spanish", (count, limit, copy) => {
    expect(render("es", count, limit)).toContain(copy);
  });

  it.each(["en", "es"] as const)("omits the ranking count for named-player and season intents in %s", (language) => {
    const copy = language === "es" ? "Resultados mostrados:" : "Results shown:";
    expect(render(language, 1, 5, "player", "fpl:code:1")).not.toContain(copy);
    expect(render(language, 1, 5, "season")).not.toContain(copy);
  });
});
