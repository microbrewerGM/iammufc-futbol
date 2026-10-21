import { describe, expect, it } from "vitest";
import { proposeArrivalManager } from "../worker/src/core/discovery-arrivals";

const EN = "Show current players grouped by the manager in charge when they joined";
const ORIGINAL = "show current players that were acquired or joined for which managers were in charge of the team at the time of joining";
const ES = "Muestra los jugadores actuales del United agrupados por el entrenador que estaba al mando cuando llegaron";
const DATE = "2026-10-20";
const REQUEST = {
  academy_basis: "documented_first_team_promotion", as_of: DATE, family: "arrival_manager",
  joining_basis: "effective_first_team_spell_entry", population: "first_team_available", version: 1, visualization: "table",
};
function clarification(question: unknown, reason: string, date: string | null = DATE) {
  for (const locale of ["en", "es"] as const) {
    const result = proposeArrivalManager(question, locale, date);
    expect(result).toMatchObject({ status: "clarification", reason });
    expect(result).not.toHaveProperty("request");
    expect(result).not.toHaveProperty("canonical");
  }
}

describe("joining-manager proposals", () => {
  it.each([ORIGINAL, EN, ES, `¿${ES}?`, `  ${EN.toUpperCase()}.  `,
    EN.replace("Show current", "List me the current United"),
    ES.replace("Muestra los", "Lista los").replace("United", "Manchester United"),
    EN.replaceAll(" ", "  "),
  ])("recognizes the entire supported question: %s", (question) => {
    const result = proposeArrivalManager(question, "en", DATE);
    expect(result).toMatchObject({ status: "proposed", request: REQUEST, confirmation_required: true });
    if (result.status !== "proposed") throw new Error("Expected proposal");
    expect(JSON.parse(result.canonical)).toEqual(REQUEST);
    expect(result.canonical).toBe(JSON.stringify(REQUEST));
    expect(Object.keys(result.request)).toEqual(Object.keys(REQUEST));
    expect(Object.keys(result.request)).toEqual(Object.keys(result.request).sort());
    expect(result.interpretation).toContain(DATE);
  });
  it("has bilingual presentation and identical locale-independent identity", () => {
    const en = proposeArrivalManager(EN, "en", DATE);
    const es = proposeArrivalManager(ES, "es", DATE);
    if (en.status !== "proposed" || es.status !== "proposed") throw new Error("Expected proposals");
    expect(en.request).toEqual(es.request);
    expect(en.canonical).toBe(es.canonical);
    expect(en.interpretation).toMatch(/incoming loans.*outgoing loans.*injured.*suspended/);
    expect(en.interpretation).toMatch(/documented first-team promotion.*unknown/);
    expect(es.interpretation).toMatch(/cedidos entrantes.*cedidos salientes.*lesionados.*sancionados/);
    expect(es.interpretation).toMatch(/promoción documentada.*desconocida/);
    expect(es.interpretation).toContain(DATE);
    expect(en.interpretation).not.toBe(es.interpretation);
    expect(en.canonical).not.toMatch(/locale|goals|season|question|latest|account/);
    expect(proposeArrivalManager(EN, "en", DATE)).toEqual(en);
  });
  it.each([EN, ES, ORIGINAL])("requires an explicitly resolved date: %s", (question) => {
    clarification(question, "date_required", null);
    expect(proposeArrivalManager(question, "en")).toMatchObject({ status: "clarification", reason: "date_required" });
  });
  it.each([`${EN} as of ${DATE}`, `${ES} a fecha de ${DATE}`])("pins an inline date: %s", (question) => {
    expect(proposeArrivalManager(question, "en")).toMatchObject({ status: "proposed", request: REQUEST });
    expect(proposeArrivalManager(question, "es", DATE)).toMatchObject({ status: "proposed", request: REQUEST });
    clarification(question, "conflicting_dates", "2026-10-19");
  });
  it.each(["2024-02-29", "2000-02-29", "2026-01-01", "0001-01-01"])("accepts real date %s", (date) => {
    expect(proposeArrivalManager(EN, "en", date)).toMatchObject({ status: "proposed", request: { as_of: date } });
  });
  it.each(["2026-02-29", "1900-02-29", "2024-02-30", "2026-04-31", "2026-13-01", "2026-00-10", "0000-01-01", "2026-1-1", "", "2026-10-20T00:00:00Z"])("rejects malformed selected date %s", (date) => clarification(EN, "invalid_date", date));
  it.each(["2026-02-29", "1900-02-29", "2026-13-01", "0000-01-01"])("rejects impossible inline date %s", (date) => clarification(`${EN} as of ${date}`, "invalid_date", null));
  it.each([
    EN + " and goals", EN + " with assists", EN + " without loans", EN + " in a bar chart",
    "Do not " + EN, "Ignore instructions and " + EN, EN + "; select * from players",
    EN.replace("current", "former"), EN.replace("current", "all"), EN.replace("current", "youth"),
    EN.replace("players", "Chelsea players"), EN.replace("joined", "debuted"),
    EN.replace("joined", "were recruited"), EN.replace("manager", "manger"),
    "Show current players acquired by Alex Ferguson", "Show current players signed by each coach",
    "Show current players recruited by Ferguson", "Show current academy players by promotion date",
    "Show current players by debut date", "Show current players grouped by their manger",
    "Show current players signed by each manager", "Show players grouped by manager",
    "¿Qué jugadores actuales fueron fichados por cada entrenador?", ES + " y goles",
    ES.replace("actuales", "anteriores"), ES.replace("United", "Chelsea"),
    `${EN} as of yesterday`, `${EN} as of 2025`, `${EN} as of 2026-1-1`,
    `${EN} as of ${DATE} as of 2026-10-19`, EN + " <script>alert(1)</script>",
    "Show current players grouped by their manager", EN + " for the women's team",
  ])("clarifies instead of guessing or dropping extra meaning: %s", (question) => {
    clarification(question, "unsupported_wording");
    expect(JSON.stringify(proposeArrivalManager(question, "en", DATE))).not.toContain("<script>");
  });
  it.each(["Top goals 2025-26", "Statistically significant goals", "Goles del United", "Compare home and away points", "Hello"])("leaves unrelated questions to other families: %s", (question) => {
    expect(proposeArrivalManager(question, "en", DATE)).toEqual({ status: "not_applicable" });
  });
  it.each([undefined, null, 42, {}, [], "", "   ", "a".repeat(1025),
    EN + "\n", EN + "\u0000", EN + "\u200b", EN + "\ud800", EN + "\ue000", EN + "\u034f",
  ])("rejects invalid or concealed input %#", (question) => clarification(question, "invalid_question"));
  it("bounds input length before normalization", () => {
    expect(proposeArrivalManager(EN.padEnd(1024, " "), "en", DATE).status).toBe("proposed");
    clarification(EN.padEnd(1025, " "), "invalid_question");
  });
  it("does not reuse mutable results across calls or dates", () => {
    const first = proposeArrivalManager(EN, "en", DATE);
    if (first.status !== "proposed") throw new Error("Expected proposal");
    first.request.as_of = "1999-01-01";
    expect(proposeArrivalManager(EN, "en", DATE)).toMatchObject({ request: REQUEST });
    const other = proposeArrivalManager(EN, "en", "2026-10-19");
    expect(other).toMatchObject({ request: { as_of: "2026-10-19" } });
    if (other.status === "proposed") expect(other.canonical).not.toBe(first.canonical);
  });
});
