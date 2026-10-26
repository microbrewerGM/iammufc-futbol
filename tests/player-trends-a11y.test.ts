import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import { calculatePer90Leaders, calculatePlayerTrends, type PlayerTrendsRequest } from "../worker/src/core/player-trends";
import { playerTrendsBody } from "../worker/src/views/player-trends";

const a = "fpl:code:1";
const b = "fpl:code:2";
const meta = { snapshot_id: "snapshot-1", person_ids: [a, b], seasons: ["2024-25"] };
const request: PlayerTrendsRequest = { schema_version: 1, competition: "PL", person_ids: [a], seasons: meta.seasons, metric: "goals", normalization: "per90", min_minutes: 450, viz: "line" };
const row = (person_id: string, total: number, minutes: number) => ({ person_id, season: "2024-25", competition: "PL" as const, metric: "goals" as const, definition: "goals" as const, total, minutes, snapshot_id: meta.snapshot_id, lineage: ["source:goals"] });
const render = (rows: ReturnType<typeof row>[], locale: typeof LOCALES.en) => {
  const result = calculatePlayerTrends(request, meta, rows);
  const leaders = calculatePer90Leaders(meta, "2024-25", "goals", 450, rows);
  return playerTrendsBody({ ...result, people: [{ person_id: a, label: "Ana" }, { person_id: b, label: "Bea" }], credits: {}, leaders }, {}, locale);
};

describe("player trends table accessibility", () => {
  it.each([
    ["en", LOCALES.en, "Per-90 leaderboard", "Excluded players"],
    ["es", LOCALES.es, "Clasificación por 90 minutos", "Jugadores excluidos"],
  ])("captions leaderboard and excluded tables (%s)", (_n, locale, board, excluded) => {
    const html = render([row(a, 3, 900), row(b, 1, 200)], locale);
    expect(html).toContain(`<table><caption>${board}</caption>`);
    expect(html).toContain(`<table><caption>${excluded}</caption>`);
  });

  it.each([
    ["en", LOCALES.en, "No players have enough minutes to be ranked."],
    ["es", LOCALES.es, "Ningún jugador tiene minutos suficientes para clasificarse."],
  ])("renders a non-focusable status instead of an empty region when nothing ranks (%s)", (_n, locale, message) => {
    const html = render([row(a, 1, 100), row(b, 1, 200)], locale);
    expect(html).toContain(`<p role="status">${message}</p>`);
    expect(html).not.toMatch(/role="region" tabindex="0" aria-label="(Per-90 leaderboard|Clasificación por 90 minutos)"/);
    expect(html).toMatch(/<caption>(Excluded players|Jugadores excluidos)<\/caption>/);
  });
});
