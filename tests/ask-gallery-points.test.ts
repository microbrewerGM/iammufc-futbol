import { describe, expect, it } from "vitest";
import compiled from "../worker/src/generated/catalog.json" with { type: "json" };
import { Catalog, type CompiledCatalog } from "../worker/src/core/feasibility";
import { LOCALES, type Locale } from "../worker/src/core/locale";
import { parseRuleBased } from "../worker/src/core/parser";
import { parseIntent, validateExecutionSupport, validateQuerySemantics } from "../worker/src/core/validate-intent";
import { homeBody } from "../worker/src/views/pages";

const source = compiled as unknown as CompiledCatalog;
const locales = [LOCALES.en, LOCALES.es];

function supportedSeason(catalog: Catalog, locale: Locale): string | undefined {
  return catalog.seasonsFor("points", "player", "box_score").find((season) => {
    const question = `${locale.strings.examplePointsTable} ${season}`;
    const proposal = parseRuleBased(question, catalog);
    const parsed = parseIntent(proposal.intent);
    if (!parsed.ok || proposal.confidence !== "high" || proposal.notes.length ||
      validateQuerySemantics(parsed.intent) || validateExecutionSupport(parsed.intent) ||
      parsed.intent.metric !== "points" || parsed.intent.viz !== "table" ||
      parsed.intent.entity_type !== "player" || parsed.intent.entity_id !== "all" ||
      parsed.intent.season !== season || parsed.intent.competition !== "PL" ||
      parsed.intent.dimensions.length || Object.keys(parsed.intent.filters).length || parsed.intent.limit !== 10) return false;
    const result = catalog.checkFeasibility(parsed.intent, locale.code);
    return result.state === "available" || result.state === "computable_now_queued";
  });
}

describe("ask gallery FPL points example", () => {
  it("shows the newest supported points season in English and Spanish", () => {
    const catalog = new Catalog(source);
    for (const locale of locales) {
      const season = supportedSeason(catalog, locale);
      expect(season).toBeTruthy();
      const html = homeBody(catalog, locale);
      const question = `${locale.strings.examplePointsTable} ${season}`;
      expect(html).toContain(`name="q" value="${question}"`);
      expect(html).toContain(`<button type="submit">${question}</button>`);
      expect(source.coverage.some((cell) => cell.metric === "points" && cell.season === season && cell.source_id === "fpl")).toBe(true);
    }
  });

  it("omits points example when no FPL points season passes eligibility", () => {
    const noFpl = new Catalog({ ...source, coverage: source.coverage.filter((cell) => cell.source_id !== "fpl") });
    expect(supportedSeason(noFpl, LOCALES.en)).toBeUndefined();
    expect(homeBody(noFpl, LOCALES.en)).not.toContain(LOCALES.en.strings.examplePointsTable);
    expect(homeBody(noFpl, LOCALES.es)).not.toContain(LOCALES.es.strings.examplePointsTable);
  });
});
