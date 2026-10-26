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
  currentPublication: vi.fn(async () => ({
    snapshotId: "a".repeat(64), preparedAt: "2026-01-01T00:00:00.000Z", loadedAt: "2026-01-01T00:00:00.000Z", sources: [],
  })),
  seasonSplitFacts: vi.fn(async (_env: unknown, snapshot: string, seasons: string[]) => ({
    catalog: { snapshot_id: snapshot, seasons: seasons.map((season) => ({ season, coverage: "complete" as const })) },
    rows: [{ season: seasons[0], competition: "PL" as const, venue: "home" as const, opponent_id: "club:1",
      played: 1, won: 1, drawn: 0, lost: 0, goals_for: 2, goals_against: 0, snapshot_id: snapshot, lineage: ["football_data_couk"] }],
  })),
}));

import app from "../worker/src/index";
import compiled from "../worker/src/generated/catalog.json";
import { enforceBudget, seasonSplitFacts } from "../worker/src/core/db";

const env = {
  ACCESS_ISSUER: "https://example.cloudflareaccess.com",
  ACCESS_AUD: "a".repeat(64),
  ACCESS_OWNER_EMAILS: "owner@example.invalid",
  DB: { prepare: () => ({ first: async () => ({ count: 1 }), bind: () => ({ first: async () => ({ count: 1 }) }) }) },
} as unknown as Env;
const headers = { "cf-access-jwt-assertion": "synthetic", Origin: "https://site.invalid" };
const { Catalog } = await import("../worker/src/core/feasibility");
const capability = vi.spyOn(Catalog.prototype, "outputCapability").mockReturnValue("clear");
const newest = [...new Set(compiled.coverage.filter((c) => c.competition === "PL").map((c) => c.season))].sort().at(-1)!;

beforeEach(() => { vi.clearAllMocks(); capability.mockReturnValue("clear"); });

describe("seasons explore default season", () => {
  it.each(["en", "es"])("preselects the newest clear season in %s", async (locale) => {
    const response = await app.request(`https://site.invalid/${locale}/seasons/explore`, { headers }, env);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain(`rel="canonical" href="/${locale}/seasons/explore?schema_version=1&amp;competition=PL&amp;seasons=${newest}&amp;group_by=venue"`);
    expect(body).toContain(`name="seasons" value="${newest}" checked>`);
    expect(body.match(/name="seasons" value="[^"]+" checked>/g)).toHaveLength(1);
    expect(vi.mocked(seasonSplitFacts).mock.calls[0]![2]).toEqual([newest]);
    expect(enforceBudget).toHaveBeenCalledTimes(1);
  });

  it("explicit seasons override the default", async () => {
    const response = await app.request("https://site.invalid/en/seasons/explore?seasons=2019-20", { headers }, env);
    const body = await response.text();
    expect(body).toContain("seasons=2019-20&amp;group_by=venue");
    expect(body).not.toContain(`seasons=${newest}`);
    expect(vi.mocked(seasonSplitFacts).mock.calls[0]![2]).toEqual(["2019-20"]);
    expect(enforceBudget).toHaveBeenCalledTimes(1);
  });

  it("keeps parse errors as 400", async () => {
    const response = await app.request("https://site.invalid/en/seasons/explore?seasons=1900-01", { headers }, env);
    expect(response.status).toBe(400);
    expect(enforceBudget).not.toHaveBeenCalled();
    expect(seasonSplitFacts).not.toHaveBeenCalled();
  });

  it("keeps existing behavior when no season is clear", async () => {
    capability.mockReturnValue("unknown");
    const response = await app.request("https://site.invalid/en/seasons/explore", { headers }, env);
    expect(response.status).toBe(400);
    expect(enforceBudget).not.toHaveBeenCalled();
    expect(seasonSplitFacts).not.toHaveBeenCalled();
  });
});
