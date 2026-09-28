import { describe, expect, it } from "vitest";
import { Catalog, type CompiledCatalog } from "../worker/src/core/feasibility";
import { LOCALES } from "../worker/src/core/locale";
import { dataAvailabilityPage } from "../worker/src/views/pages";

const compiled: CompiledCatalog = {
  version: 1,
  metrics: [
    {
      metric_id: "goals",
      label_en: "Goals",
      label_es: "Goles",
      description: "Goals scored in the competition.",
      description_es: "Goles marcados en la competición.",
      granularity: "box_score",
      unit: "count",
      decimals: 0,
    },
    {
      metric_id: "assists",
      label_en: "Assists",
      label_es: "Asistencias",
      description: "Assists <recorded>.",
      description_es: "Asistencias <registradas>.",
      granularity: "box_score",
      unit: "count",
      decimals: 0,
    },
  ],
  coverage: [
    {
      metric: "goals",
      entity_type: "season",
      granularity: "box_score",
      season: "2024-25",
      competition: "PL",
      source_id: "results",
      redistributable: true,
      cost_class: "cheap",
      attribution_asset: null,
      attribution_text: "Results <credit>.",
      attribution_text_es: "Resultados <crédito>.",
      source_name: "Results & scores",
    },
    {
      metric: "assists",
      entity_type: "player",
      granularity: "box_score",
      season: "2024-25",
      competition: "PL",
      source_id: "results",
      redistributable: false,
      cost_class: "cheap",
      attribution_asset: null,
      attribution_text: "Results <credit>.",
      attribution_text_es: "Resultados <crédito>.",
      source_name: "Results & scores",
    },
  ],
};

describe("data availability page", () => {
  it("renders an accessible English table and deduplicated lineage attribution", () => {
    const markup = dataAvailabilityPage(new Catalog(compiled), LOCALES.en);
    expect(markup).toContain("Data and sources");
    expect(markup).toContain('role="region"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain("Goals scored in the competition.");
    expect(markup).toContain("Permitted when present");
    expect(markup).toContain("Computable now (queued)");
    expect(markup).toContain("No publication rights");
    expect(markup).toContain("does not guarantee that a matching database row exists");
    expect(markup.match(/Results &lt;credit&gt;\./g)).toHaveLength(1);
    expect(markup).not.toContain("<credit>");
    expect(markup).not.toContain("<recorded>");
  });

  it("uses the Spanish descriptions, labels and attribution", () => {
    const markup = dataAvailabilityPage(new Catalog(compiled), LOCALES.es);
    expect(markup).toContain("Datos y fuentes");
    expect(markup).toContain("Goles marcados en la competición.");
    expect(markup).toContain("No permitido");
    expect(markup).toContain("Calculable ahora (en cola)");
    expect(markup).toContain("Sin derechos de publicación");
    expect(markup).toContain("Resultados &lt;crédito&gt;.");
    expect(markup).not.toContain("Goals scored in the competition.");
  });

  it("does not describe a capability-only coverage cell as an existing row", () => {
    const markup = dataAvailabilityPage(new Catalog(compiled), LOCALES.en);
    expect(markup).not.toContain(">Available<");
    expect(markup).toContain("Permitted when present");
  });

  it("keeps expensive capability distinct from current queued work", () => {
    const expensive: CompiledCatalog = {
      ...compiled,
      coverage: [{ ...compiled.coverage[0]!, cost_class: "expensive" }],
    };
    const markup = dataAvailabilityPage(new Catalog(expensive), LOCALES.en);
    expect(markup).toContain("Computable but expensive");
    expect(markup).not.toContain("Computable now (queued)");
  });

  it("renders an honest localized empty state", () => {
    const empty = new Catalog({ ...compiled, coverage: [] });
    expect(dataAvailabilityPage(empty, LOCALES.en)).toContain("No data coverage is currently published.");
    expect(dataAvailabilityPage(empty, LOCALES.es)).toContain("Actualmente no hay cobertura de datos publicada.");
  });
});
