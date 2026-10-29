import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";

const labels = new Map([["club:1001", "Arsenal"], ["club:1014", "Liverpool"], ["club:1015", "Manchester City"]]);
vi.mock("jose", async (original) => ({ ...await original<typeof import("jose")>(), jwtVerify: vi.fn(async () => ({ payload: { sub: "owner", email: "owner@example.invalid" } })) }));
vi.mock("../worker/src/core/db", async (original) => ({ ...await original<typeof import("../worker/src/core/db")>(),
  enforceBudget: vi.fn(async () => true), currentSnapshot: vi.fn(async () => "a".repeat(64)),
  currentPublication: vi.fn(async () => ({ snapshotId: "a".repeat(64), preparedAt: "2026-01-01T00:00:00.000Z", loadedAt: "2026-01-01T00:00:00.000Z", sources: [] })),
  readOpponentLabels: vi.fn(async (_env: unknown, _snapshot: string, ids: readonly string[]) => new Map(ids.flatMap(id => labels.has(id) ? [[id, labels.get(id)!] as const] : []))),
  seasonSplitFacts: vi.fn(async (_env: unknown, snapshot: string, seasons: string[]) => ({ catalog: { snapshot_id: snapshot, seasons: seasons.map(season => ({ season, coverage: "complete" as const })) }, rows: [] })),
}));
vi.mock("../worker/src/core/opponent-history", async (original) => ({ ...await original<typeof import("../worker/src/core/opponent-history")>(),
  readOpponentHistory: vi.fn(async (_env: unknown, request: any, metadata: any) => ({ request, snapshot_id: metadata.snapshot_id,
    seasons: request.seasons.map((season: string) => ({ season, coverage: "complete", status: "no_matches" })),
    status: "no_matches", partial: false, contributing_seasons: [] })),
}));

import app from "../worker/src/index";
import { currentPublication, currentSnapshot, enforceBudget, readOpponentLabels, seasonSplitFacts } from "../worker/src/core/db";
import { APPROVED_OPPONENT_IDS } from "../worker/src/core/opponent-history";
import { Catalog } from "../worker/src/core/feasibility";
import { LOCALES } from "../worker/src/core/locale";

const env = { ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64), ACCESS_OWNER_EMAILS: "owner@example.invalid",
  DB: { prepare: vi.fn(() => ({ first: async () => ({ count: 1 }), bind: () => ({ first: async () => ({ count: 1 }) }) })) } } as unknown as Env;
const headers = { "cf-access-jwt-assertion": "synthetic", Origin: "https://site.invalid" };
const clear = vi.spyOn(Catalog.prototype, "outputCapability").mockReturnValue("clear");
const snapshot = "a".repeat(64);

beforeEach(() => { vi.clearAllMocks(); clear.mockReturnValue("clear"); });

describe("opponent history selection form", () => {
  it.each(["en", "es"] as const)("renders a localized %s form without selection", async locale => {
    const response = await app.request(`https://site.invalid/${locale}/opponents/history`, { headers }, env);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain(`<html lang="${LOCALES[locale].htmlLang}">`);
    expect(body).toContain(locale === "en" ? "Choose an opponent and scope" : "Elige un rival y el alcance");
    expect(body).toContain('name="opponent_id"');
    const optionIds = [...body.matchAll(/<option value="(club:\d+)"(?: selected)?>([^<]+)<\/option>/g)];
    expect(new Set(optionIds.map(([, id]) => id))).toEqual(APPROVED_OPPONENT_IDS);
    expect(readOpponentLabels).toHaveBeenCalledWith(env, snapshot, [...APPROVED_OPPONENT_IDS]);
    expect(optionIds.find(([, id]) => id === "club:1001")?.[2]).toBe("Arsenal");
    expect(optionIds.find(([, id]) => id === "club:1014")?.[2]).toBe("Liverpool");
    expect(optionIds.find(([, id]) => id === "club:1015")?.[2]).toBe("Manchester City");
    const sortedFirst = [...APPROVED_OPPONENT_IDS].sort((a, b) =>
      (labels.get(a) ?? a).localeCompare(labels.get(b) ?? b) || a.localeCompare(b))[0];
    expect(optionIds[0]?.[1]).toBe(sortedFirst);
    expect(optionIds[0]?.[0]).toContain(" selected>");
    expect(body).toMatch(/name="seasons" value="\d{4}-\d{2}" checked/);
    expect(body).toContain('value="all" selected');
    expect(body).toContain(locale === "en" ? "All venues" : "Todas las localías");
    expect(seasonSplitFacts).not.toHaveBeenCalled();
  });

  it("checks the budget before empty-query D1 reads and returns the selected path refusal status", async () => {
    vi.mocked(enforceBudget).mockResolvedValueOnce(false);
    const emptyResponse = await app.request("https://site.invalid/en/opponents/history", { headers }, env);
    expect(emptyResponse.status).toBe(503);
    expect(enforceBudget).toHaveBeenCalledWith(env, { failClosed: true });
    expect(currentPublication).not.toHaveBeenCalled();
    expect(readOpponentLabels).not.toHaveBeenCalled();
    expect(currentSnapshot).not.toHaveBeenCalled();
    expect(seasonSplitFacts).not.toHaveBeenCalled();

    vi.mocked(enforceBudget).mockResolvedValueOnce(false);
    const selectedResponse = await app.request(
      "https://site.invalid/en/opponents/history?opponent_id=club%3A1001&seasons=2023-24",
      { headers }, env,
    );
    expect(selectedResponse.status).toBe(emptyResponse.status);
    expect(enforceBudget).toHaveBeenLastCalledWith(env, { failClosed: true });
    expect(currentPublication).not.toHaveBeenCalled();
    expect(readOpponentLabels).not.toHaveBeenCalled();
    expect(currentSnapshot).not.toHaveBeenCalled();
    expect(seasonSplitFacts).not.toHaveBeenCalled();
  });

  it.each(["en", "es"] as const)("preserves the %s selection and venue in the canonical result URL", async locale => {
    const params = new URLSearchParams({ schema_version: "1", competition: "PL", group_by: "opponent", venue: "away", opponent_id: "club:1014" });
    params.append("seasons", "2023-24");
    params.append("seasons", "2024-25");
    const response = await app.request(`https://site.invalid/${locale}/opponents/history?${params}`, { headers }, env);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(seasonSplitFacts).toHaveBeenCalledWith(env, snapshot, ["2023-24", "2024-25"], { venue: "away", opponent_id: "club:1014" });
    expect(body).toContain(`<link rel="canonical" href="/${locale}/opponents/history?schema_version=1&amp;competition=PL&amp;group_by=opponent&amp;seasons=2023-24&amp;seasons=2024-25&amp;venue=away&amp;opponent_id=club%3A1014">`);
    expect(body).toContain('value="club:1014" selected>');
    expect(body).toContain('name="seasons" value="2023-24" checked');
    expect(body).toContain('name="seasons" value="2024-25" checked');
    expect(body).toContain('value="away" selected');
    expect(currentSnapshot).toHaveBeenCalled();
  });
});
