import { describe, expect, it } from "vitest";
import compiled from "../worker/src/generated/catalog.json" with { type: "json" };
import { Catalog, type CompiledCatalog } from "../worker/src/core/feasibility";
import { LOCALES, type Locale } from "../worker/src/core/locale";
import { parseRuleBased } from "../worker/src/core/parser";
import { parseIntent, validateExecutionSupport, validateQuerySemantics } from "../worker/src/core/validate-intent";
import { exampleQuestion, homeBody } from "../worker/src/views/pages";

const catalog = new Catalog(compiled as unknown as CompiledCatalog);
const exampleKeys = ["exampleGoals", "exampleAssistsTable", "exampleMinutesDots", "examplePointsTable", "exampleXg"] as const;
const expected = [
  { key: "exampleGoals", metric: "goals", viz: "bar" },
  { key: "exampleAssistsTable", metric: "assists", viz: "table" },
  { key: "exampleMinutesDots", metric: "minutes", viz: "dot_plot" },
  { key: "examplePointsTable", metric: "points", viz: "table" },
  { key: "exampleXg", metric: "xg", viz: "bar" },
] as const;
const locales = [LOCALES.en, LOCALES.es];

function question(locale: Locale, key: (typeof exampleKeys)[number], season: string): string {
  return `${locale.strings[key]} ${season}`;
}

function isSupported(q: string, metric: string, viz: string, locale: Locale): boolean {
  const proposal = parseRuleBased(q, catalog);
  const parsed = parseIntent(proposal.intent);
  if (!parsed.ok || proposal.confidence !== "high" || proposal.notes.length ||
    validateQuerySemantics(parsed.intent) || validateExecutionSupport(parsed.intent) ||
    parsed.intent.metric !== metric || parsed.intent.viz !== viz ||
    parsed.intent.entity_type !== "player" || parsed.intent.entity_id !== "all" ||
    parsed.intent.season !== "2025-26" || parsed.intent.competition !== "PL" ||
    parsed.intent.dimensions.length || Object.keys(parsed.intent.filters).length || parsed.intent.limit !== 10) return false;
  const result = catalog.checkFeasibility(parsed.intent, locale.code);
  return result.state === "available" || result.state === "computable_now_queued";
}

describe("ask examples gallery", () => {
  it("renders exactly each locale-key example that passes parsing and feasibility", () => {
    let assistsSupported = true;
    for (const locale of locales) {
      const html = homeBody(catalog, locale);
      expect(html).toContain(`<form method="post" action="/${locale.code}/ask">`);
      for (const example of expected) {
        const q = question(locale, example.key, "2025-26");
        const supported = isSupported(q, example.metric, example.viz, locale);
        if (example.key === "exampleAssistsTable") assistsSupported &&= supported;
        expect(html.includes(`name="q" value="${q}"`)).toBe(supported);
        expect(html.includes(`<button type="submit">${q}</button>`)).toBe(supported);
        expect(html).not.toContain(`disabled>${q}</button>`);
      }
    }
    expect(assistsSupported).toBe(true);
  });

  it("requires every gallery locale key in both languages", () => {
    for (const key of exampleKeys) {
      expect(LOCALES.en.strings[key], `missing EN ${key}`).toBeTruthy();
      expect(LOCALES.es.strings[key], `missing ES ${key}`).toBeTruthy();
    }
  });

  it("omits infeasible examples and keeps the ask form usable", () => {
    const empty = new Catalog({ ...(compiled as unknown as CompiledCatalog), coverage: [] });
    const html = homeBody(empty, LOCALES.en);
    expect(html).not.toContain("Example questions");
    expect(html).toContain('action="/en/ask"');
  });

  it("escapes hostile question text in the value and accessible submit name", () => {
    const hostile = `Top goals 2025-26\"><script>alert(1)</script>&`;
    const html = exampleQuestion(LOCALES.en, hostile);
    const escaped = `Top goals 2025-26&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;`;
    expect(html).toContain(`<input type="hidden" name="q" value="${escaped}">`);
    expect(html).toContain(`<button type="submit">${escaped}</button>`);
    expect(html).not.toContain(hostile);
  });

  it("keeps keyboard focus order aligned with the visual order", () => {
    const html = homeBody(catalog, LOCALES.en);
    const exampleForms = [...html.matchAll(/<li><form method="post" action="\/en\/ask">[\s\S]*?<button type="submit">([\s\S]*?)<\/button>[\s\S]*?<\/form><\/li>/g)]
      .map((match) => match[1]);
    expect(exampleForms).toEqual(expected
      .map((example) => question(LOCALES.en, example.key, "2025-26"))
      .filter((q, index) => isSupported(q, expected[index]!.metric, expected[index]!.viz, LOCALES.en)));
    const chatInput = html.indexOf('<input type="text" name="q"');
    const firstExample = html.indexOf('<li><form method="post" action="/en/ask">');
    expect(chatInput).toBeGreaterThanOrEqual(0);
    expect(firstExample).toBeGreaterThan(chatInput);
  });
});
