import { describe, expect, it } from "vitest";
import { championsLeagueHistoryBody, type ChampionsLeagueHistoryStrings, type ChampionsLeagueHistoryView } from "../worker/src/views/cl-history";

const en: ChampionsLeagueHistoryStrings = {
  heading: "Champions League history", caption: "Recorded matches; records may be incomplete", season: "Season",
  played: "Played", won: "Won", drawn: "Drawn", lost: "Lost", goalsFor: "Goals for", goalsAgainst: "Goals against",
  gap: "No recorded matches available; this does not establish non-participation",
  outsideCoverage: "Champions League history is outside current coverage", partial: "partial", noResults: "No recorded Champions League results are available", unavailable: "History is temporarily unavailable",
  snapshotDate: "Data snapshot", sources: "Sources and snapshot", attributionUnavailable: "Source attribution unavailable for some data.",
};
const es: ChampionsLeagueHistoryStrings = { ...en, heading: "Historial de la Liga de Campeones", caption: "Partidos registrados; los datos pueden estar incompletos", season: "Temporada", played: "Jugados", won: "Ganados", drawn: "Empatados", lost: "Perdidos", goalsFor: "Goles a favor", goalsAgainst: "Goles en contra", gap: "No hay partidos registrados disponibles; esto no demuestra que el equipo no participara", outsideCoverage: "El historial de la Liga de Campeones está fuera de la cobertura actual", partial: "parcial", noResults: "No hay resultados registrados de la Liga de Campeones disponibles", unavailable: "El historial no está disponible temporalmente", snapshotDate: "Fecha de los datos", sources: "Fuentes y versión de datos", attributionUnavailable: "Atribución de fuente no disponible para algunos datos." };
const row = { season: "2025-26", played: 2, won: 1, drawn: 0, lost: 1, goals: 3, goals_against: 0, lineage: ["openfootball:CL:2025-26"] };
const model = (): ChampionsLeagueHistoryView => ({ entries: [{ state: "partial", row }, { state: "observed", row: { ...row, season: "2023-24" } }, { state: "gap", season: "2024-25" }, { state: "out_of_coverage", season: "2026-27" }], credits: { "openfootball:CL:2025-26": "OpenFootball credit" }, snapshotDate: "2026-10-23" });

describe("Champions League history view", () => {
  it.each([["en", en], ["es", es]] as const)("renders localized headings and table semantics in %s", (_code, strings) => {
    const body = championsLeagueHistoryBody(model(), strings);
    expect(body).toContain(`<h1>${strings.heading}</h1>`);
    expect(body).toContain(`<caption>${strings.caption}</caption>`);
    expect(body.match(/<th scope="col">/g)).toHaveLength(7);
    expect(body).toContain('role="region" tabindex="0"');
    expect(body).toContain("OpenFootball credit");
    expect(body).toContain("2026-10-23");
  });
  it.each([["en", en], ["es", es]] as const)("keeps zero, gaps, partial rows, and out-of-coverage seasons distinct in %s", (_code, strings) => {
    const body = championsLeagueHistoryBody(model(), strings);
    expect(body).toContain("<td>2</td><td>1</td><td>0</td><td>1</td><td>3</td><td>0</td>");
    expect(body).toContain(`2025-26 <span>(${strings.partial})</span>`);
    expect(body).toContain(strings.gap);
    expect(body).not.toContain("2026-27");
    const out = championsLeagueHistoryBody({ entries: [{ state: "out_of_coverage", season: "2026-27" }], credits: {} }, strings);
    expect(out).toContain(strings.outsideCoverage);
    expect(out).not.toContain("<table");
  });
  describe.each([["en", en], ["es", es]] as const)("missing states in %s", (_code, strings) => {
    it.each([undefined, [], ["missing-ref"]])("withholds observed numbers when lineage is missing or unresolved (%s)", (lineage) => {
      const value: ChampionsLeagueHistoryView = { entries: [{ state: "observed", row: { ...row, lineage } }], credits: {} };
      const body = championsLeagueHistoryBody(value, strings);
      expect(body).toContain(strings.attributionUnavailable);
      expect(body).not.toMatch(/<td>\d+<\/td>/);
    });
    it("keeps each in-coverage season visible when all recorded results are missing", () => {
      // The reader emits one gap per covered season even when its query returns no rows.
      const seasons = ["2024-25", "2025-26"];
      const value: ChampionsLeagueHistoryView = {
        entries: seasons.map((season) => ({ state: "gap", season })), credits: {},
      };
      const body = championsLeagueHistoryBody(value, strings);
      expect(body).toContain(`<p role="status">${strings.noResults}</p>`);
      expect(body).toContain("<table>");
      for (const season of seasons) {
        expect(body).toContain(`<tr><th scope="row">${season}</th><td colspan="6"><span aria-label="${strings.gap}">—</span> <span>${strings.gap}</span></td></tr>`);
      }
      expect(body).not.toMatch(/<td>\d+<\/td>/);
      expect(body).not.toContain(strings.outsideCoverage);
      expect(body).not.toContain(strings.attributionUnavailable);
    });
    it("renders zero covered CL seasons as outside coverage", () => {
      const body = championsLeagueHistoryBody({ entries: [], credits: {} }, strings);
      expect(body).toContain(`<p role="status">${strings.outsideCoverage}</p>`);
      expect(body).not.toContain(strings.noResults);
      expect(body).not.toContain("<table");
    });
  });
  it("renders all four season states as distinct typed entries", () => {
    const body = championsLeagueHistoryBody(model(), en);
    expect(body).toContain("2025-26 <span>(partial)</span>");
    expect(body).toContain("2023-24</th><td>2</td>");
    expect(body).toContain(en.gap);
    expect(body).not.toContain("2026-27");
  });
  it("escapes supplied values and attributes lineage credit", () => {
    const value = model();
    value.entries = [{ state: "observed", row: { ...row, season: '<script>alert("x")</script>' } }];
    value.credits = { "openfootball:CL:2025-26": '<script>credit</script>' };
    const body = championsLeagueHistoryBody(value, en);
    expect(body).not.toMatch(/<script\b/);
    expect(body).toContain("&lt;script&gt;");
    expect(body).toContain("&lt;script&gt;credit&lt;/script&gt;");
  });
  it("reports gaps-only and temporary unavailable states", () => {
    expect(championsLeagueHistoryBody({ entries: [{ state: "gap", season: "2024-25" }], credits: {} }, es)).toContain(es.noResults);
    expect(championsLeagueHistoryBody({ entries: [], credits: {}, unavailable: true }, es)).toContain(es.unavailable);
  });
});
