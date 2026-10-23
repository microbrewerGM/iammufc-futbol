import { describe, expect, it } from "vitest";
import compiled from "../worker/src/generated/catalog.json" with { type: "json" };
import { Catalog, type CompiledCatalog } from "../worker/src/core/feasibility";
import { LOCALES } from "../worker/src/core/locale";
import { parseRuleBased } from "../worker/src/core/parser";
import { parseIntent, validateExecutionSupport, validateQuerySemantics } from "../worker/src/core/validate-intent";
import { homeBody } from "../worker/src/views/pages";

const catalog = new Catalog(compiled as unknown as CompiledCatalog);

describe("ask examples gallery", () => {
  it("renders every parser- and feasibility-supported localized question", () => {
    const expected = [
      { questions: ["Top goals 2025-26", "Máximos goles 2025-26"], metric: "goals", viz: "bar" },
      { questions: ["Top assists 2025-26", "Máximas asistencias 2025-26"], metric: "assists", viz: "table" },
      { questions: ["Top minutes dot plot 2025-26", "Más minutos gráfico de puntos 2025-26"], metric: "minutes", viz: "dot_plot" },
      { questions: ["Top FPL points table 2025-26", "Más puntos FPL tabla 2025-26"], metric: "points", viz: "table" },
      { questions: ["Expected goals 2025-26", "Goles esperados 2025-26"], metric: "xg", viz: "bar" },
    ];
    for (const example of expected) {
      for (const [localeIndex, locale] of [LOCALES.en, LOCALES.es].entries()) {
        const q = example.questions[localeIndex]!;
        const html = homeBody(catalog, locale);
        expect(html).toContain(`<form method="post" action="/${locale.code}/ask">`);
        const proposal = parseRuleBased(q, catalog);
        const parsed = parseIntent(proposal.intent);
        const supportedIntent = parsed.ok && proposal.confidence === "high" && proposal.notes.length === 0 &&
          !validateQuerySemantics(parsed.intent) && !validateExecutionSupport(parsed.intent) &&
          parsed.intent.metric === example.metric && parsed.intent.viz === example.viz &&
          parsed.intent.entity_type === "player" && parsed.intent.entity_id === "all" &&
          parsed.intent.season === "2025-26" && parsed.intent.competition === "PL" &&
          parsed.intent.dimensions.length === 0 && Object.keys(parsed.intent.filters).length === 0 &&
          parsed.intent.limit === 10;
        const feasibility = supportedIntent ? catalog.checkFeasibility(parsed.intent, locale.code) : null;
        const supported = supportedIntent && feasibility !== null &&
          (feasibility.state === "available" || feasibility.state === "computable_now_queued");
        if (supported) {
          expect(html).toContain(`value="${q}"`);
          expect(html).toContain(`<button type="submit">${q}</button>`);
        } else {
          expect(html).not.toContain(`value="${q}"`);
          expect(html).not.toContain(`<button type="submit">${q}</button>`);
          expect(html).not.toContain(`disabled>${q}</button>`);
        }
      }
    }
    for (const [locale, question] of [
      [LOCALES.en, "Top assists 2025-26"],
      [LOCALES.es, "Máximas asistencias 2025-26"],
    ] as const) {
      const html = homeBody(catalog, locale);
      expect(html).not.toContain(`value="${question}"`);
      expect(html).not.toContain(`<button type="submit">${question}</button>`);
      expect(html).not.toContain(`disabled>${question}</button>`);
    }
  });

  it("omits infeasible examples and escapes labels and questions", () => {
    const empty = new Catalog({ ...(compiled as unknown as CompiledCatalog), coverage: [] });
    const html = homeBody(empty, LOCALES.en);
    expect(html).not.toContain("Example questions");
    expect(html).toContain('action="/en/ask"');
    expect(homeBody(catalog, LOCALES.en)).toContain('value="Top FPL points table 2025-26"');
    expect(homeBody(catalog, LOCALES.es)).toContain("Preguntas de ejemplo");
  });
});
