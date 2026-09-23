import { describe, expect, it } from "vitest";
import { withDefaults } from "../worker/src/core/intent";
import { parseIntent, validateExecutionSupport, validateQuerySemantics } from "../worker/src/core/validate-intent";

const base = { metric: "goals", season: "2024-25", entity_id: "all" };

describe("runtime intent shape", () => {
  it("rejects inherited fields that defaults would otherwise consume", () => {
    const inherited = Object.assign(Object.create({ entity_id: 5 }), { metric: "goals", season: "2024-25" });
    expect(parseIntent(inherited).ok).toBe(false);
  });

  it.each([null, [], "query", 5, {}, { ...base, metric: null }, { ...base, metric: " " },
    { ...base, season: 2024 }, { ...base, season: "" }, { ...base, entity_id: 5 },
    { ...base, competition: null }, { ...base, competition: " " },
    { ...base, entity_type: "unknown" }, { ...base, viz: "pie" },
    { ...base, dimensions: null }, { ...base, dimensions: [5] },
    { ...base, filters: [] }, { ...base, filters: { position: 5 } },
    { ...base, limit: 0 }, { ...base, limit: 51 }, { ...base, limit: 1.5 },
    { ...base, limit: "5" }, { ...base, limit: NaN }, { ...base, limit: Infinity },
    { ...base, metric: "x".repeat(129) }, { ...base, entity_id: "x".repeat(129) },
  ])("rejects malformed input %j", (raw) => {
    expect(parseIntent(raw).ok).toBe(false);
  });

  it("rejects unknown fields rather than silently dropping semantics", () => {
    expect(parseIntent({ ...base, position: "GK" })).toEqual({ ok: false, issue: { code: "unsupported_field", field: "intent" } });
  });

  it("applies exactly the shared canonical defaults", () => {
    expect(parseIntent(base)).toEqual({ ok: true, intent: withDefaults(base) });
  });

  it("keeps the empty identity default without silently choosing all players", () => {
    const raw = { metric: "goals", season: "2024-25" };
    const parsed = parseIntent(raw);
    expect(parsed).toEqual({ ok: true, intent: withDefaults(raw) });
    if (parsed.ok) expect(validateExecutionSupport(parsed.intent)).toEqual({ code: "unsupported_execution", field: "entity_id" });
    const season = parseIntent({ ...raw, entity_type: "season" });
    expect(season.ok).toBe(true);
    if (season.ok) expect(validateExecutionSupport(season.intent)).toBeNull();
  });

  it("preserves explicit competition, named identity, entity type and limit", () => {
    const explicit = { ...base, competition: "CL", entity_id: "A.Player", entity_type: "player" as const, limit: 50, viz: "bar" as const };
    expect(parseIntent(explicit)).toEqual({ ok: true, intent: withDefaults(explicit) });
    expect(parseIntent({ ...base, entity_type: "season", entity_id: "", limit: 1 })).toEqual({
      ok: true, intent: withDefaults({ ...base, entity_type: "season", entity_id: "", limit: 1 }),
    });
  });

  it("preserves well-shaped unsupported fields for an explicit semantic refusal", () => {
    const raw = { ...base, filters: { position: "GK" }, dimensions: ["position"] };
    const parsed = parseIntent(raw);
    expect(parsed).toEqual({ ok: true, intent: withDefaults(raw) });
    if (parsed.ok) expect(validateQuerySemantics(parsed.intent)).toEqual({ code: "unsupported_semantics", field: "dimensions" });
  });
});

describe("supported execution contract", () => {
  it.each(["goals", "assists", "minutes", "points", "xg"])("permits player metric %s with supported renderers", (metric) => {
    for (const viz of ["table", "bar"] as const) {
      expect(validateExecutionSupport(withDefaults({ ...base, metric, viz }))).toBeNull();
    }
  });

  it.each(["", "all"])("permits season goals with identity %j", (entity_id) => {
    expect(validateExecutionSupport(withDefaults({ ...base, entity_type: "season", entity_id }))).toBeNull();
  });

  it.each([{ entity_id: "" }, { entity_id: " " }, { filters: { position: "GK" } },
    { dimensions: ["position"] }, { entity_type: "season", entity_id: "A.Player" },
    { entity_type: "season", metric: "assists" }, { entity_type: "match" },
    { entity_type: "opponent" }, { entity_type: "competition" }, { metric: "unknown" },
    { viz: "line" }, { viz: "shot_map" }, { viz: "pass_map" }, { viz: "heatmap" },
  ])("refuses unsupported execution %j", (overrides) => {
    expect(validateExecutionSupport(withDefaults({ ...base, ...overrides } as Parameters<typeof withDefaults>[0]))).not.toBeNull();
  });
});
