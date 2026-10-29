import { describe, expect, it } from "vitest";
import { parseIntent, validateArrivalIntent } from "../worker/src/core/validate-intent";

describe("arrival manager intent validation", () => {
  it("accepts only a confirmed dated arrival-manager proposal", () => {
    const result = validateArrivalIntent("Which current players joined under which manager?", "en", "2026-10-20", true);
    expect(result).toMatchObject({ status: "accepted", route: "/en/discover/arrivals", request: { family: "arrival_manager", as_of: "2026-10-20" } });
  });
  it("requires confirmation and resolves dates without creating answer links", () => {
    for (const [question, locale, date, confirmed] of [
      ["Which current players joined under which manager?", "en", "2026-10-20", false],
      ["Which current players joined under which manager?", "en", null, true],
      ["Show current players grouped by the manager in charge when they joined as of 2026-10-20", "en", "2026-10-19", true],
      ["Show players grouped by manager", "en", "2026-10-20", true],
    ] as [string, "en" | "es", string | null, boolean][]) {
      const result = validateArrivalIntent(question, locale, date, confirmed);
      expect(result.status).toBe(confirmed ? "clarification" : "confirmation_required");
      expect(result).not.toHaveProperty("route");
    }
  });
  it("keeps English and Spanish intent identity locale independent", () => {
    const en = validateArrivalIntent("Which current players joined under which manager?", "en", "2026-10-20", true);
    const es = validateArrivalIntent("¿Qué jugadores actuales llegaron con cada entrenador?", "es", "2026-10-20", true);
    expect(en).toMatchObject({ status: "accepted" });
    expect(es).toMatchObject({ status: "accepted", route: "/es/discover/arrivals" });
    if (en.status === "accepted" && es.status === "accepted") expect(en.canonical).toBe(es.canonical);
  });
  it("retains the ordinary QueryIntent boundary and rejects SQL-shaped values", () => {
    expect(parseIntent({ metric: "goals", season: "2025-26", sql: "select * from players" })).toMatchObject({ ok: false });
  });
});
