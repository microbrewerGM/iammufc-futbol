import { describe, expect, it } from "vitest";
import { championsLeagueHistoryBody, type ChampionsLeagueHistoryStrings } from "../worker/src/views/cl-history";

const strings: ChampionsLeagueHistoryStrings = {
  heading: "Champions League history", caption: "Recorded matches; records may be incomplete", season: "Season",
  stage: "Stage reached", stages: { group_stage: "Group stage", league_phase: "League phase", knockout_playoff: "Knockout play-off", round_of_16: "Round of 16", quarter_final: "Quarter-final", semi_final: "Semi-final", final: "Final", winner: "Winner" },
  played: "Played", won: "Won", drawn: "Drawn", lost: "Lost", goalsFor: "Goals for", goalsAgainst: "Goals against",
  gap: "No recorded matches", partial: "partial", outsideCoverage: "Outside coverage", noResults: "No results",
  unavailable: "Temporarily unavailable", snapshotDate: "Data snapshot", sources: "Sources and snapshot",
  attributionUnavailable: "Source attribution unavailable for some data.", observedSeasons: "Recorded seasons ({n})",
  seasonsExcluded: "Not totalled: {n}",
};
const spanish: ChampionsLeagueHistoryStrings = {
  ...strings, heading: "Historial de la Liga de Campeones", caption: "Partidos registrados; datos incompletos",
  season: "Temporada", stage: "Fase alcanzada", stages: { group_stage: "Fase de grupos", league_phase: "Fase liga", knockout_playoff: "Eliminatoria previa", round_of_16: "Octavos de final", quarter_final: "Cuartos de final", semi_final: "Semifinal", final: "Final", winner: "Campeón" }, played: "Jugados", won: "Ganados", drawn: "Empatados", lost: "Perdidos",
  goalsFor: "Goles a favor", goalsAgainst: "Goles en contra", gap: "Sin partidos registrados", partial: "parcial",
  outsideCoverage: "Fuera de cobertura", noResults: "Sin resultados", unavailable: "No disponible",
  snapshotDate: "Fecha de datos", sources: "Fuentes y versión de datos",
  attributionUnavailable: "Atribución de fuente no disponible para algunos datos.",
  observedSeasons: "Temporadas registradas ({n})", seasonsExcluded: "No sumadas: {n}",
};

describe("Champions League history row source associations", () => {
  it.each([["en", strings], ["es", spanish]] as const)("associates each row with its credits and lists shared credits once in %s", (locale, copy) => {
    const html = championsLeagueHistoryBody({
      entries: [
        { state: "observed", row: { season: "2024-25", played: 1, won: 1, drawn: 0, lost: 0, goals: 2, goals_against: 0, lineage: ["source:a", "source:shared"] } },
        { state: "partial", row: { season: "2025-26", played: 2, won: 1, drawn: 1, lost: 0, goals: 3, goals_against: 1, lineage: ["source:b", "source:shared"] } },
      ],
      credits: { "source:a": "First source", "source:b": "Second source", "source:shared": "Shared source" },
    }, copy, locale);

    expect(html).toContain('<tr aria-describedby="cl-history-source-0 cl-history-source-1"><th scope="row"><a href="/' + locale + '/season/2024-25">2024-25</a> <span class="cl-history-row-sources">');
    expect(html).toContain('<tr aria-describedby="cl-history-source-2 cl-history-source-1"><th scope="row"><a href="/' + locale + '/season/2025-26">2025-26</a> <span class="cl-history-row-sources">');
    expect(html.match(/id="cl-history-source-1"/g)).toHaveLength(1);
    expect(html.match(/>Shared source<\/p>/g)).toHaveLength(1);
  });

  it("withholds unresolved rows and escapes credit text", () => {
    const html = championsLeagueHistoryBody({
      entries: [
        { state: "observed", row: { season: "2024-25", played: 1, won: 1, drawn: 0, lost: 0, goals: 2, goals_against: 0, lineage: ["source:known"] } },
        { state: "observed", row: { season: "2025-26", played: 9, won: 9, drawn: 0, lost: 0, goals: 99, goals_against: 0, lineage: ["source:missing"] } },
      ],
      credits: { "source:known": "<b>Known & trusted</b>" },
    }, strings, "en");

    expect(html).toContain("<td>1</td><td>1</td><td>0</td><td>0</td><td>2</td><td>0</td>");
    expect(html).toContain(strings.attributionUnavailable);
    expect(html).not.toContain("<td>9</td>");
    expect(html).toContain("&lt;b&gt;Known &amp; trusted&lt;/b&gt;");
    expect(html).not.toContain("<b>Known & trusted</b>");
  });
});
