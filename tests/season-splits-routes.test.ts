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
  seasonSplitFacts: vi.fn(async (_env: unknown, snapshot: string, seasons: string[]) => ({
    catalog: { snapshot_id: snapshot, seasons: seasons.map((season) => ({ season, coverage: "complete" as const })) },
    rows: [{ season: seasons[0], competition: "PL" as const, venue: "home" as const, opponent_id: "club:1",
      played: 1, won: 1, drawn: 0, lost: 0, goals_for: 2, goals_against: 0, snapshot_id: snapshot, lineage: ["football_data_couk"] }],
  })),
}));

import app from "../worker/src/index";
import { enforceBudget, currentPublication, seasonSplitFacts } from "../worker/src/core/db";

const env = {
  ACCESS_ISSUER: "https://example.cloudflareaccess.com",
  ACCESS_AUD: "a".repeat(64),
  ACCESS_OWNER_EMAILS: "owner@example.invalid",
  DB: { prepare: () => ({ first: async () => ({ count: 1 }), bind: () => ({ first: async () => ({ count: 1 }) }) }) },
} as unknown as Env;
const headers = { "cf-access-jwt-assertion": "synthetic", Origin: "https://site.invalid" };
const { Catalog } = await import("../worker/src/core/feasibility");
const clearCatalog = vi.spyOn(Catalog.prototype, "outputCapability").mockReturnValue("clear");

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
      const sources = body.match(/<section aria-label="(?:Sources and snapshot|Fuentes y versión de datos)">[\s\S]*?<\/section>/)?.[0];
      expect(sources).toContain("Football-Data.co.uk");
      expect(sources).not.toMatch(/Source attribution unavailable|Atribución de fuente no disponible/);
      expect(body).toContain(`rel="canonical" href="/${locale}/seasons/explore?schema_version=1&amp;competition=PL&amp;seasons=2024-25&amp;group_by=venue"`);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    },
  );

  it.each(["en", "es"])("blocks cross-site %s season reads before budget or D1", async (locale) => {
    for (const method of ["GET", "HEAD"]) {
      for (const path of [`/${locale}/seasons/explore`, `/${locale}/%73easons/explore`, `/${locale}/seasons/%65xplore`]) {
        for (const proof of [{ Origin: "https://foreign.invalid" }, { "Sec-Fetch-Site": "cross-site" }, {}] as Record<string, string>[]) {
          const prepare = vi.fn(() => { throw new Error("unexpected D1 read"); });
          const response = await app.request(`https://site.invalid${path}?seasons=2024-25`, {
            method, headers: { "cf-access-jwt-assertion": "synthetic", ...proof },
          }, { ...env, DB: { prepare } } as unknown as Env);
          expect(response.status).toBe(403);
          expect(prepare).not.toHaveBeenCalled();
          expect(enforceBudget).not.toHaveBeenCalled();
          expect(currentPublication).not.toHaveBeenCalled();
          expect(seasonSplitFacts).not.toHaveBeenCalled();
        }
      }
    }
  });

  it.each(["en", "es"])("allows same-origin %s navigation", async (locale) => {
    const response = await app.request(`https://site.invalid/${locale}/seasons/explore?seasons=2024-25`, {
      headers: { "cf-access-jwt-assertion": "synthetic", "Sec-Fetch-Site": "same-origin" },
    }, env);
    expect(response.status).toBe(200);
    expect(enforceBudget).toHaveBeenCalledTimes(1);
    expect(seasonSplitFacts).toHaveBeenCalledTimes(1);
  });

  it.each(["en", "es"])("preserves distinct localized asset credits in the %s result", async (locale) => {
    const { decodeCompiledCatalog } = await import("../worker/src/core/catalog-contract");
    const original = decodeCompiledCatalog((await import("../worker/src/generated/catalog.json")).default).coverage;
    const cell = original.find((cell) => cell.source_id === "football_data_couk")!;
    const coverage = vi.spyOn(Catalog.prototype, "coverage", "get").mockReturnValue([
      ...original,
      { ...cell, attribution_asset: "synthetic-extra", attribution_text: "Extra asset <credit>", attribution_text_es: "Recurso adicional <crédito>" },
      { ...cell, attribution_asset: "synthetic-duplicate", attribution_text: "Extra asset <credit>", attribution_text_es: "Recurso adicional <crédito>" },
    ]);
    try {
      const response = await app.request(`https://site.invalid/${locale}/seasons/explore?seasons=2024-25`, { headers }, env);
      expect(response.status).toBe(200);
      const section = (await response.text()).match(/<section aria-label="(?:Sources and snapshot|Fuentes y versión de datos)">[\s\S]*?<\/section>/)?.[0] ?? "";
      expect(section).toContain("Football-Data.co.uk");
      const extra = locale === "es" ? "Recurso adicional &lt;crédito&gt;" : "Extra asset &lt;credit&gt;";
      expect(section.split(extra)).toHaveLength(2);
      expect(section).not.toMatch(/<credit>|<crédito>|Source attribution unavailable|Atribución de fuente no disponible/);
    } finally { coverage.mockRestore(); }
  });

  it("rejects duplicate and unsupported dimensions", async () => {
    expect((await app.request("https://site.invalid/en/seasons/explore?seasons=2024-25&seasons=2024-25", { headers }, env)).status).toBe(400);
    expect((await app.request("https://site.invalid/en/seasons/explore?seasons=2024-25&filters=x", { headers }, env)).status).toBe(400);
  });

  it("charges budget only for a bounded aggregate read", async () => {
    const budget = vi.mocked((await import("../worker/src/core/db")).enforceBudget);
    clearCatalog.mockReturnValue("unknown");
    await app.request("https://site.invalid/en/seasons/explore", { headers }, env);
    expect(budget).not.toHaveBeenCalled();
    expect(seasonSplitFacts).not.toHaveBeenCalled();
    clearCatalog.mockReturnValue("clear");
    await app.request("https://site.invalid/en/seasons/explore?seasons=2024-25&seasons=2024-25", { headers }, env);
    expect(budget).not.toHaveBeenCalled();
    await app.request("https://site.invalid/en/seasons/explore", { headers }, env);
    expect(budget).toHaveBeenCalledTimes(1);
    expect(seasonSplitFacts).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    await app.request("https://site.invalid/en/seasons/explore?seasons=2024-25", { headers }, env);
    expect(budget).toHaveBeenCalledTimes(1);
  });
});
