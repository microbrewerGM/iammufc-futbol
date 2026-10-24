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
  DB: { prepare: () => ({ first: async () => ({ count: 1 }), bind: () => ({ first: async () => ({ count: 1 }) }) }) } } as unknown as Env;
const headers = { "cf-access-jwt-assertion": "synthetic", Origin: "https://site.invalid" };
const clear = vi.spyOn(Catalog.prototype, "outputCapability").mockReturnValue("clear");
const query = "?opponent_id=club%3A1001&seasons=2023-24&seasons=2024-25";

beforeEach(() => { vi.clearAllMocks(); clear.mockReturnValue("clear"); });

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
  it("rejects invalid, duplicate, overlong and unapproved selections before SQL", async () => {
    for (const suffix of ["?opponent_id=club%3A9999&seasons=2023-24", "?opponent_id=club%3A1001&seasons=1900-01",
      "?opponent_id=club%3A1001&seasons=2023-24&seasons=2023-24", "?opponent_id=club%3A1001&" + Array.from({ length: 17 }, (_, i) => `seasons=20${String(i).padStart(2, "0")}-21`).join("&")]) {
      expect((await app.request(`https://site.invalid/es/opponents/history${suffix}`, { headers }, env)).status).toBe(400);
    }
    expect(seasonSplitFacts).not.toHaveBeenCalled();
    expect(enforceBudget).not.toHaveBeenCalled();
  });
  it("fails closed when the output capability is not clear", async () => {
    clear.mockReturnValue("partial");
    const response = await app.request(`https://site.invalid/es/opponents/history${query}`, { headers }, env);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("no está disponible temporalmente");
    expect(seasonSplitFacts).not.toHaveBeenCalled();
  });
});
