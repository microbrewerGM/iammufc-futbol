import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";

vi.mock("jose", async (original) => ({ ...await original<typeof import("jose")>(), jwtVerify: vi.fn(async (token: string) => {
  if (token !== "synthetic") throw new Error("denied");
  return { payload: { sub: "owner", email: "owner@example.invalid" } };
}) }));
vi.mock("../worker/src/core/db", async (original) => ({ ...await original<typeof import("../worker/src/core/db")>(),
  enforceBudget: vi.fn(async () => true), currentSnapshot: vi.fn(async () => "a".repeat(64)),
  currentPublication: vi.fn(async () => ({ snapshotId: "a".repeat(64), preparedAt: "2026-01-01T00:00:00.000Z", loadedAt: "2026-01-01T00:00:00.000Z", sources: [] })),
  seasonSplitFacts: vi.fn(async (_env: unknown, snapshot: string, seasons: string[]) => ({ catalog: { snapshot_id: snapshot, seasons: seasons.map(season => ({ season, coverage: "complete" as const })) }, rows: [] })),
}));
vi.mock("../worker/src/core/opponent-history", async (original) => ({ ...await original<typeof import("../worker/src/core/opponent-history")>(),
  readOpponentHistory: vi.fn(async (_env: unknown, request: any, metadata: any) => ({ request, snapshot_id: metadata.snapshot_id,
    seasons: request.seasons.map((season: string) => ({ season, coverage: "complete", status: "no_matches" })),
    status: "no_matches", partial: false, contributing_seasons: [] })),
}));

import app from "../worker/src/index";
import { enforceBudget, seasonSplitFacts } from "../worker/src/core/db";
import { readOpponentHistory } from "../worker/src/core/opponent-history";
import { Catalog } from "../worker/src/core/feasibility";

const env = { ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64), ACCESS_OWNER_EMAILS: "owner@example.invalid",
  DB: { prepare: vi.fn(() => ({ first: async () => ({ count: 1 }), bind: () => ({ first: async () => ({ count: 1 }) }) })) } } as unknown as Env;
const headers = { "cf-access-jwt-assertion": "synthetic", Origin: "https://site.invalid" };
const clear = vi.spyOn(Catalog.prototype, "outputCapability").mockReturnValue("clear");
const actualCoverage = Object.getOwnPropertyDescriptor(Catalog.prototype, "coverage")!.get!;
const coverage = vi.spyOn(Catalog.prototype, "coverage", "get");
const query = "?opponent_id=club%3A1001&seasons=2023-24&seasons=2024-25";

beforeEach(() => { vi.clearAllMocks(); clear.mockReturnValue("clear"); coverage.mockImplementation(function (this: Catalog) { return actualCoverage.call(this); }); });

describe("opponent history routes", () => {
  it("denies anonymous access before budget or data reads", async () => {
    for (const locale of ["en", "es"]) expect((await app.request(`https://site.invalid/${locale}/opponents/history${query}`, {}, env)).status).toBe(403);
    expect(enforceBudget).not.toHaveBeenCalled();
    expect(seasonSplitFacts).not.toHaveBeenCalled();
  });
  it.each(["en", "es"])("serves localized %s history for approved opponents", async locale => {
    const response = await app.request(`https://site.invalid/${locale}/opponents/history${query}`, { headers }, env);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain(locale === "en" ? "Opponent history" : "Historial contra rivales");
    expect(seasonSplitFacts).toHaveBeenCalledWith(env, "a".repeat(64), ["2023-24", "2024-25"], { venue: null, opponent_id: "club:1001" });
    expect(readOpponentHistory).toHaveBeenCalledTimes(1);
  });
  it.each(["en", "es"])("renders selected row attribution in %s", async locale => {
    vi.mocked(readOpponentHistory).mockResolvedValueOnce({
      request: { schema_version: 1, competition: "PL", seasons: ["2023-24", "2024-25"], group_by: "opponent", venue: null, opponent_id: "club:1001" },
      snapshot_id: "a".repeat(64), seasons: ["2023-24", "2024-25"].map(season => ({ season, coverage: "complete", status: "available", record: {
        played: 1, won: 1, drawn: 0, lost: 0, goals_for: 1, goals_against: 0, points: 3, goal_difference: 1, rate_denominator: 1,
        points_per_match: 3, goals_for_per_match: 1, goals_against_per_match: 0, win_rate: 1, lineage: ["football_data_couk"],
      } })), status: "available", partial: false, contributing_seasons: ["2023-24", "2024-25"],
    });
    vi.spyOn(Catalog.prototype, "coverage", "get").mockReturnValue(Array.from({ length: 2 }, (_, i) => ({
      metric: "played", entity_type: "team", granularity: "box_score" as const, season: i === 0 ? "2023-24" : "2024-25", competition: "PL",
      source_id: "football_data_couk", redistributable: true, cost_class: "cheap" as const, attribution_asset: "asset",
      attribution_text: "Fixture source credit EN", attribution_text_es: "Crédito de fuente ES", source_name: "Fixture source",
    })));
    const response = await app.request(`https://site.invalid/${locale}/opponents/history${query}`, { headers }, env);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain(locale === "en" ? "Fixture source credit EN" : "Crédito de fuente ES");
  });
  it("rejects malformed selections before SQL", async () => {
    const duplicate = await app.request(`https://site.invalid/es/opponents/history?opponent_id=club%3A1001&seasons=2023-24&seasons=2023-24`, { headers }, env);
    expect(duplicate.status).toBe(400);
    expect(await duplicate.text()).toContain("Selección de historial de rival no válida.");
    expect(env.DB.prepare).not.toHaveBeenCalled();

    for (const [suffix, status] of [
      ["?opponent_id=club%3A9999&seasons=2023-24", 400],
      ["?opponent_id=club%3A1016&seasons=2023-24", 400],
      ["?opponent_id=club%3A1001&seasons=1900-01", 400],
      ["?opponent_id=club%3A1001&seasons=2023-24&unexpected=1", 400],
      ["?opponent_id=club%3A1001&seasons=" + "x".repeat(2100), 400],
      ["?opponent_id=club%3A1001&" + Array.from({ length: 17 }, (_, i) => `seasons=20${String(i).padStart(2, "0")}-21`).join("&"), 400],
      ["?schema_version=" + "1".repeat(65) + "&opponent_id=club%3A1001&seasons=2023-24", 400],
      ["?competition=" + "P".repeat(65) + "&opponent_id=club%3A1001&seasons=2023-24", 400],
      ["?opponent_id=" + "x".repeat(65) + "&seasons=2023-24", 400],
    ] as const) {
      expect((await app.request(`https://site.invalid/es/opponents/history${suffix}`, { headers }, env)).status).toBe(status);
    }
    expect(seasonSplitFacts).not.toHaveBeenCalled();
    expect(enforceBudget).not.toHaveBeenCalled();
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });
  it("accepts exactly 16 selected seasons and rejects 17 before SQL", async () => {
    const seasons = Array.from({ length: 16 }, (_, i) => `${String(2000 + i).padStart(4, "0")}-${String((i + 1) % 100).padStart(2, "0")}`);
    coverage.mockReturnValue(Array.from({ length: 16 }, (_, i) => ({
      metric: "played", entity_type: "team", granularity: "box_score" as const, season: seasons[i]!, competition: "PL",
      source_id: "fixture_source", redistributable: true, cost_class: "cheap" as const, attribution_asset: "asset",
      attribution_text: "Fixture source credit EN", attribution_text_es: "Crédito de fuente ES", source_name: "Fixture source",
    })));
    const params = new URLSearchParams({ opponent_id: "club:1001" });
    seasons.forEach(season => params.append("seasons", season));
    const response = await app.request(`https://site.invalid/en/opponents/history?${params}`, { headers }, env);
    expect(response.status).toBe(200);
    expect(seasonSplitFacts).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    coverage.mockImplementation(function (this: Catalog) { return actualCoverage.call(this); });
    const tooMany = new URLSearchParams({ opponent_id: "club:1001" });
    [...seasons, seasons[0]!].forEach(season => tooMany.append("seasons", season));
    expect((await app.request(`https://site.invalid/en/opponents/history?${tooMany}`, { headers }, env)).status).toBe(400);
    expect(vi.mocked(env.DB.prepare)).not.toHaveBeenCalled();
  });
  it.each([["en", "Season splits capability is not published."], ["es", "La capacidad de desgloses por temporada no está publicada."]])("serves a 200 unpublished state in %s when the output capability is not clear", async (locale, message) => {
    clear.mockReturnValue("partial");
    const response = await app.request(`https://site.invalid/${locale}/opponents/history${query}`, { headers }, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).toContain(message);
    expect(enforceBudget).not.toHaveBeenCalled();
    expect(seasonSplitFacts).not.toHaveBeenCalled();
    expect(readOpponentHistory).not.toHaveBeenCalled();
    expect(vi.mocked(env.DB.prepare)).not.toHaveBeenCalled();
  });
});
