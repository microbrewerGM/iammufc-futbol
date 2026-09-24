import { describe, expect, it, vi } from "vitest";

import { Catalog, type CompiledCatalog } from "../worker/src/core/feasibility";
import { LOCALES } from "../worker/src/core/locale";
import { seasonHistoryRows, type Env } from "../worker/src/core/db";
import {
  buildSeasonComparison,
  eligibleLeagueSeasons,
  type SeasonHistoryRow,
} from "../worker/src/core/season-comparison";
import { seasonPageBody } from "../worker/src/views/pages";
import compiled from "../worker/src/generated/catalog.json" with { type: "json" };

const catalog = new Catalog(compiled as unknown as CompiledCatalog);
const row = (overrides: Partial<SeasonHistoryRow> = {}): SeasonHistoryRow => ({
  season: "2024-25",
  played: 38,
  won: 11,
  drawn: 9,
  lost: 18,
  goals: 44,
  goals_against: 54,
  snapshot_id: "snapshot-a",
  ...overrides,
});

describe("team-season comparison", () => {
  it("binds the PL competition before explicit seasons and avoids SQL for an empty set", async () => {
    const all = vi.fn(async () => ({ results: [row()] }));
    const bind = vi.fn(() => ({ all }));
    const prepare = vi.fn(() => ({ bind }));
    const env = { DB: { prepare } } as unknown as Env;
    expect(await seasonHistoryRows(env, [])).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();

    expect(await seasonHistoryRows(env, ["2024-25", "2023-24"])).toEqual([row()]);
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("competition = ? AND season IN (?, ?)"));
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("ORDER BY season DESC"));
    expect(bind).toHaveBeenCalledWith("PL", "2024-25", "2023-24");
  });
  it("selects covered PL seasons through the requested season without CL duplicates", () => {
    const seasons = eligibleLeagueSeasons(catalog, "2024-25");
    expect(seasons[0]).toBe("2024-25");
    expect(seasons.at(-1)).toBe("2016-17");
    expect(seasons).not.toContain("2025-26");
    expect(new Set(seasons).size).toBe(seasons.length);
    expect(eligibleLeagueSeasons(catalog, "2030-31")).toEqual([]);

    const blocked = structuredClone(compiled) as unknown as CompiledCatalog;
    const prior = blocked.coverage.find((cell) =>
      cell.metric === "goals" && cell.entity_type === "season" && cell.competition === "PL" && cell.season === "2023-24",
    );
    if (!prior) throw new Error("expected coverage cell");
    prior.redistributable = false;
    expect(eligibleLeagueSeasons(new Catalog(blocked), "2024-25")).toEqual([]);
  });

  it("derives auditable points and per-match rates", () => {
    const result = buildSeasonComparison([row()], ["2024-25"], catalog, "en");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]).toMatchObject({
      league_points: 42,
      points_per_match: 42 / 38,
      goals_per_match: 44 / 38,
      partial: false,
    });
  });

  it("marks partial rows and rejects zero or more-than-38-match records", () => {
    const partial = buildSeasonComparison(
      [row({ played: 10, won: 5, drawn: 2, lost: 3, goals: 16 })],
      ["2024-25"], catalog, "en",
    );
    expect(partial.ok && partial.rows[0]).toMatchObject({ league_points: 17, points_per_match: 1.7, goals_per_match: 1.6, partial: true });

    const zero = buildSeasonComparison(
      [row({ played: 0, won: 0, drawn: 0, lost: 0, goals: 0, goals_against: 0 })],
      ["2024-25"], catalog, "en",
    );
    expect(zero.ok).toBe(false);
    expect(buildSeasonComparison(
      [row({ played: 39, won: 20, drawn: 9, lost: 10 })],
      ["2024-25"], catalog, "en",
    ).ok).toBe(false);
  });

  it("fails closed on malformed records, missing rows, or mixed snapshots", () => {
    expect(buildSeasonComparison([row({ won: 20 })], ["2024-25"], catalog, "en").ok).toBe(false);
    expect(buildSeasonComparison([], ["2024-25"], catalog, "en").ok).toBe(false);
    expect(buildSeasonComparison(
      [row(), row({ season: "2023-24", snapshot_id: "snapshot-b", won: 18, drawn: 6, lost: 14 })],
      ["2024-25", "2023-24"], catalog, "en",
    ).ok).toBe(false);

    const mixedSourceData = structuredClone(compiled) as unknown as CompiledCatalog;
    const oldCell = mixedSourceData.coverage.find((cell) =>
      cell.metric === "goals" && cell.entity_type === "season" &&
      cell.competition === "PL" && cell.season === "2023-24",
    );
    if (!oldCell) throw new Error("expected synthetic coverage cell");
    oldCell.source_id = "another_source";
    expect(buildSeasonComparison(
      [row(), row({ season: "2023-24", won: 18, drawn: 6, lost: 14 })],
      ["2024-25", "2023-24"], new Catalog(mixedSourceData), "en",
    ).ok).toBe(false);
  });

  it.each([
    ["en", "League season comparison", "1.11", "1.16", "Partial"],
    ["es", "Comparación de temporadas de liga", "1,11", "1,16", "Parcial"],
  ] as const)("renders an accessible localized %s table with stable links", (code, heading, ppg, gpg, partialLabel) => {
    const result = buildSeasonComparison(
      [row(), row({ season: "2023-24", played: 10, won: 5, drawn: 2, lost: 3, goals: 16 })],
      ["2024-25", "2023-24"], catalog, code,
    );
    const html = seasonPageBody("2024-25", [], row(), catalog, LOCALES[code], null, result);
    expect(html).toContain(heading);
    expect(html).toContain(`>${ppg}</td>`);
    expect(html).toContain(`>${gpg}</td>`);
    expect(html).toContain(partialLabel);
    expect(html).toContain('class="team-season-table" tabindex="0" role="region"');
    expect(html).toContain(`href="/${code}/season/2023-24"`);
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('<caption class="sr-only">');
    expect(html).toContain('<th scope="col">');
    expect(html).toContain("Football-Data.co.uk");
    expect(html).not.toContain("decline");
    expect(html).not.toContain("declive");
  });

  it("renders a mandatory localized attribution returned by lineage", () => {
    const data = structuredClone(compiled) as unknown as CompiledCatalog;
    for (const cell of data.coverage.filter((candidate) =>
      candidate.metric === "goals" && candidate.entity_type === "season" && candidate.competition === "PL",
    )) {
      cell.attribution_text = "Credit required";
      cell.attribution_text_es = "Crédito obligatorio";
    }
    const result = buildSeasonComparison([row()], ["2024-25"], new Catalog(data), "es");
    expect(seasonPageBody("2024-25", [], row(), new Catalog(data), LOCALES.es, null, result)).toContain("Crédito obligatorio");
  });
});
