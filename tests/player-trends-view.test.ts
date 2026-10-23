import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import { calculatePer90Leaders, calculatePlayerTrends, type PlayerTrendsRequest } from "../worker/src/core/player-trends";
import { playerTrendsBody } from "../worker/src/views/player-trends";

const a = "fpl:code:1";
const b = "fpl:code:2";
const meta = { snapshot_id: "snapshot-1", person_ids: [a, b], seasons: ["2023-24", "2024-25", "2025-26"] };
const request: PlayerTrendsRequest = { schema_version: 1, competition: "PL", person_ids: [a], seasons: meta.seasons, metric: "goals", normalization: "per90", min_minutes: 450, viz: "line" };
const row = (person_id: string, season: string, total: number | null, minutes: number | null, lineage = "source:goals") => ({ person_id, season, competition: "PL" as const, metric: "goals" as const, definition: "goals" as const, total, minutes, snapshot_id: meta.snapshot_id, lineage: [lineage] });

describe("playerTrendsBody", () => {
  it("renders an accessible chart, table fallback, explicit gap and lineage attribution in English", () => {
    const result = calculatePlayerTrends(request, meta, [row(a, "2023-24", 0, 900), row(a, "2024-25", 2, 900), row(a, "2025-26", 3, 300)]);
    const html = playerTrendsBody({ ...result, people: [{ person_id: a, label: "<Alex>" }], credits: { "source:goals": "League source" } }, {}, LOCALES.en);
    expect(html).toContain("<svg");
    expect(html).toContain("aria-label=\"Player trends: &lt;Alex&gt;; Goals; 2023-24–2025-26; &lt;Alex&gt; 2025-26: Below minimum minutes.");
    expect(html).toContain("<table>");
    expect(html).toContain("Data unavailable");
    expect(html).toContain("<td>0</td>");
    expect(html).toContain("Below minimum minutes");
    expect(html).toContain("&lt;Alex&gt;");
    expect(html).toContain("League source");
    expect(html).toContain("Goals total");
    expect(html).not.toContain("source:goals");
  });

  it("breaks chart segments at missing and below-threshold cells and never plots invalid support", () => {
    const gap = calculatePlayerTrends(request, meta, [
      row(a, "2023-24", 1, 900),
      row(a, "2024-25", 9, 0),
      row(a, "2025-26", 3, 900),
    ]);
    const html = playerTrendsBody({ ...gap, people: [{ person_id: a, label: "Alex" }], credits: {} }, {}, LOCALES.en);
    expect(html.match(/<polyline/g)).toBeNull();
    expect(html).toContain("2024-25: No positive minutes");

    const threshold = calculatePlayerTrends(request, meta, [
      row(a, "2023-24", 1, 900),
      row(a, "2024-25", 2, 300),
      row(a, "2025-26", 3, 900),
    ]);
    const thresholdHtml = playerTrendsBody({ ...threshold, people: [{ person_id: a, label: "Alex" }], credits: {} }, {}, LOCALES.en);
    expect(thresholdHtml.match(/<polyline/g)).toBeNull();

    const totalRequest: PlayerTrendsRequest = { ...request, normalization: "total", min_minutes: 0 };
    const invalidTotal = calculatePlayerTrends(totalRequest, meta, [
      row(a, "2023-24", 1, 900), row(a, "2024-25", 99, 0), row(a, "2025-26", 3, 900),
    ]);
    const invalidHtml = playerTrendsBody({ ...invalidTotal, people: [{ person_id: a, label: "Alex" }], credits: {} }, {}, LOCALES.en);
    expect(invalidHtml.match(/<polyline/g)).toBeNull();
    expect(invalidHtml).not.toContain("cx=\"50.00\" cy=\"20.00\"");
  });

  it("renders Spanish labels and leaderboard exclusions", () => {
    const result = calculatePlayerTrends(request, meta, [row(a, "2023-24", 2, 900), row(a, "2024-25", 3, 900)]);
    const leaders = calculatePer90Leaders(meta, "2024-25", "goals", 450, [row(a, "2024-25", 3, 900), row(b, "2024-25", 1, 200)]);
    const html = playerTrendsBody({ ...result, people: [{ person_id: a, label: "Ana" }, { person_id: b, label: "Bea" }], credits: {}, leaders }, {}, LOCALES.es);
    expect(html).toContain("Evolución de jugadores");
    expect(html).toContain("Temporada");
    expect(html).toContain("Datos no disponibles");
    expect(html).toContain("Clasificación por 90 minutos");
    expect(html).toContain("Por debajo del mínimo de minutos");
    expect(html).toContain("Jugadores excluidos");
    expect(html).toContain('role="region" tabindex="0" aria-label="Jugadores excluidos"');
    expect(html).toContain("Atribución de fuente no disponible");
  });

  it("uses the passed strings and avoids plotting a one-point trend", () => {
    const one: PlayerTrendsRequest = { ...request, seasons: ["2024-25"] };
    const result = calculatePlayerTrends(one, meta, [row(a, "2024-25", 1, 900)]);
    const html = playerTrendsBody({ ...result, people: [{ person_id: a, label: "Alex" }], credits: {} }, { heading: "Custom trend", goals: "Custom goals", table: "Custom data table" }, LOCALES.en);
    expect(html).toContain("Custom trend");
    expect(html).toContain("Custom goals");
    expect(html).toContain("Custom data table");
    expect(html).toContain("Not enough points for a trend");
    expect(html).not.toContain("<svg");
  });

  it("does not emit a figure for a series with fewer than two supported points", () => {
    const multi: PlayerTrendsRequest = { ...request, person_ids: [a, b] };
    const result = calculatePlayerTrends(multi, meta, [
      row(a, "2023-24", 1, 900), row(a, "2024-25", 2, 900),
      row(b, "2023-24", 1, 900), row(b, "2024-25", 2, 100),
    ]);
    const html = playerTrendsBody({ ...result, people: [{ person_id: a, label: "Alex" }, { person_id: b, label: "Bea" }], credits: {} }, {}, LOCALES.en);
    expect(html.match(/<figure>/g)).toHaveLength(1);
    expect(html).toContain("Not enough points for a trend");
  });
});
