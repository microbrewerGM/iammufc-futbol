import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";

vi.mock("jose", async (original) => ({
  ...await original<typeof import("jose")>(),
  jwtVerify: vi.fn(async (token: string) => {
    if (token !== "synthetic") throw new Error("denied");
    return { payload: { sub: "owner", email: "owner@example.invalid" } };
  }),
}));

vi.mock("../worker/src/core/db", async (original) => ({
  ...await original<typeof import("../worker/src/core/db")>(),
  enforceBudget: vi.fn(async () => true),
  currentSnapshot: vi.fn(async () => "a".repeat(64)),
  currentPublication: vi.fn(async () => ({
    snapshotId: "a".repeat(64), preparedAt: "2026-01-01T00:00:00.000Z", loadedAt: "2026-01-01T00:00:00.000Z", sources: [],
  })),
  seasonSplitFacts: vi.fn(async (_env: unknown, snapshot: string, seasons: string[], coverage: { season: string; coverage: "complete" | "partial" | "missing" }[]) => ({
    catalog: { snapshot_id: snapshot, seasons: coverage },
    rows: [{ season: seasons[0], competition: "PL" as const, venue: "home" as const, opponent_id: "club:1",
      played: 1, won: 1, drawn: 0, lost: 0, goals_for: 2, goals_against: 0, snapshot_id: snapshot, lineage: ["football_data_couk"] }],
  })),
}));

import app from "../worker/src/index";
import { seasonSplitFacts } from "../worker/src/core/db";

const env = {
  ACCESS_ISSUER: "https://example.cloudflareaccess.com",
  ACCESS_AUD: "a".repeat(64),
  ACCESS_OWNER_EMAILS: "owner@example.invalid",
  DB: { prepare: () => ({ first: async () => ({ count: 1 }), bind: () => ({ first: async () => ({ count: 1 }) }) }) },
} as unknown as Env;
const headers = { "cf-access-jwt-assertion": "synthetic" };
const clearCatalog = vi.spyOn((await import("../worker/src/core/feasibility")).Catalog.prototype, "outputCapability").mockReturnValue("clear");

beforeEach(() => { vi.clearAllMocks(); clearCatalog.mockReturnValue("clear"); });

describe("season splits exploration routes", () => {
  it("requires authentication before any aggregate read", async () => {
    for (const locale of ["en", "es"]) {
      expect((await app.request(`https://site.invalid/${locale}/seasons/explore`, {}, env)).status).toBe(403);
    }
    expect(seasonSplitFacts).not.toHaveBeenCalled();
  });

  it("keeps the explicit capability gate closed without reading rows", async () => {
    clearCatalog.mockReturnValue("unknown");
    const response = await app.request("https://site.invalid/en/seasons/explore?seasons=2024-25", { headers }, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("capability is not published");
    expect(seasonSplitFacts).not.toHaveBeenCalled();
  });

  it.each([["en", "Explore season performance"], ["es", "Explorar el rendimiento por temporada"]] as const)(
    "renders the protected localized %s route with source and canonical selection",
    async (locale, heading) => {
      const response = await app.request(`https://site.invalid/${locale}/seasons/explore?seasons=2024-25&group_by=venue`, { headers }, env);
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain(heading);
      expect(body).toContain("Football-Data.co.uk");
      expect(body).toContain(`rel="canonical" href="/${locale}/seasons/explore?schema_version=1&amp;competition=PL&amp;seasons=2024-25&amp;group_by=venue"`);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    },
  );

  it("rejects duplicate and unsupported dimensions", async () => {
    expect((await app.request("https://site.invalid/en/seasons/explore?seasons=2024-25&seasons=2024-25", { headers }, env)).status).toBe(400);
    expect((await app.request("https://site.invalid/en/seasons/explore?seasons=2024-25&filters=x", { headers }, env)).status).toBe(400);
  });

  it("charges budget only for a bounded aggregate read", async () => {
    const budget = vi.mocked((await import("../worker/src/core/db")).enforceBudget);
    await app.request("https://site.invalid/en/seasons/explore", { headers }, env);
    expect(budget).not.toHaveBeenCalled();
    await app.request("https://site.invalid/en/seasons/explore?seasons=2024-25&seasons=2024-25", { headers }, env);
    expect(budget).not.toHaveBeenCalled();
    await app.request("https://site.invalid/en/seasons/explore?seasons=2024-25", { headers }, env);
    expect(budget).toHaveBeenCalledTimes(1);
  });
});
