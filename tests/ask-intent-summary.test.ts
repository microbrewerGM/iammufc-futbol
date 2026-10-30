import { describe, expect, it } from "vitest";
import compiled from "../worker/src/generated/catalog.json" with { type: "json" };
import { Catalog, type CompiledCatalog } from "../worker/src/core/feasibility";
import { withDefaults } from "../worker/src/core/intent";
import { LOCALES, metricLabel } from "../worker/src/core/locale";
import type { Proposal } from "../worker/src/core/parser";
import { intentPanel } from "../worker/src/views/pages";

const catalog = new Catalog(compiled as unknown as CompiledCatalog);

function proposal(): Proposal {
  return {
    intent: withDefaults({ metric: "goals", entity_type: "player", entity_id: "all", season: "2024-25", competition: "PL", viz: "dot_plot" }),
    confidence: "high",
    notes: [],
    source: "rules",
    model_status: "not_configured",
  };
}

describe("ask intent summary", () => {
  it("shows readable English intent labels and values", () => {
    const markup = intentPanel(proposal(), catalog, LOCALES.en);

    expect(markup).toContain(`Metric: ${metricLabel(catalog, "goals", "en")}`);
    expect(markup).toContain("Scope: Player: All");
    expect(markup).toContain("Season: 2024-25");
    expect(markup).toContain("Competition: Premier League");
    expect(markup).toContain("Visualization: Dot plot");
    expect(markup).not.toMatch(/entity_type|dot_plot/);
  });

  it("shows the same intent fields with Spanish labels and metric", () => {
    const markup = intentPanel(proposal(), catalog, LOCALES.es);

    expect(markup).toContain(`Métrica: ${metricLabel(catalog, "goals", "es")}`);
    expect(markup).toContain("Alcance: Jugador: Todos");
    expect(markup).toContain("Temporada: 2024-25");
    expect(markup).toContain("Competición: Premier League");
    expect(markup).toContain("Visualización: Gráfico de puntos");
    expect(markup).not.toMatch(/entity_type|dot_plot/);
  });

  it.each([
    ["en", "line", "Line chart"],
    ["en", "pass_map", "Pass map"],
    ["es", "line", "Gráfico de líneas"],
    ["es", "pass_map", "Mapa de pases"],
  ] as const)("labels %s visualization %s", (language, viz, label) => {
    const markup = intentPanel({ ...proposal(), intent: withDefaults({ ...proposal().intent, viz }) }, catalog, LOCALES[language]);
    expect(markup).toContain(`${language === "es" ? "Visualización" : "Visualization"}: ${label}`);
    expect(markup).not.toContain(viz);
  });
});
