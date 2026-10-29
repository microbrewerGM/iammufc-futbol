import { describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";
import { LOCALES } from "../worker/src/core/locale";

vi.mock("jose", async (original) => ({
  ...await original<typeof import("jose")>(),
  jwtVerify: vi.fn(async () => ({ payload: { sub: "owner", email: "owner@example.invalid" } })),
}));

const readState = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], fail: false, seasons: ["2024-25", "2023-24"] as string[], sourceHashes: { "openfootball:CL:2024-25": "b".repeat(64) } as Record<string, string> }));
vi.mock("../worker/src/core/cl-history", async (original) => ({
  ...await original<typeof import("../worker/src/core/cl-history")>(),
  clHistoryRead: vi.fn(async () => {
    if (readState.fail) throw new Error("synthetic database failure");
    return { result: { snapshot_id: "a".repeat(64), entries: readState.rows as never }, sourcesJson: JSON.stringify(readState.sourceHashes) };
  }),
}));
const decoded = vi.hoisted(() => ({ catalog: undefined as undefined | { coverage: unknown[] } }));
vi.mock("../worker/src/core/catalog-contract", async (original) => {
  const actual = await original<typeof import("../worker/src/core/catalog-contract")>();
  return { ...actual, decodeCompiledCatalog: ((value: unknown) => { const out = actual.decodeCompiledCatalog(value as never); decoded.catalog = out as never; return out; }) as typeof actual.decodeCompiledCatalog };
});
vi.mock("../worker/src/core/db", async (original) => ({
  ...await original<typeof import("../worker/src/core/db")>(),
  currentSnapshot: vi.fn(async () => "a".repeat(64)),
  currentPublication: vi.fn(async () => ({ snapshotId: "a".repeat(64), preparedAt: "2026-10-23T00:00:00.000Z", loadedAt: "2026-10-23T00:00:00.000Z", sources: [{ id: "openfootball_cl", status: "observed" }] })),
  seasonSquadRows: vi.fn(async () => []),
  seasonRecordRow: vi.fn(async () => null),
  seasonHistoryRows: vi.fn(async () => []),
}));

const snapshotDb = vi.hoisted(() => ({
  prepare: vi.fn(() => ({ first: vi.fn(async () => ({ snapshot_id: "a".repeat(64), sources_json: JSON.stringify(readState.sourceHashes) })) })),
}));

import app from "../worker/src/index";

const env = { ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64), ACCESS_OWNER_EMAILS: "owner@example.invalid" } as Env;
Object.assign(env, { DB: snapshotDb });
const headers = { "cf-access-jwt-assertion": "synthetic" };
const row = { season: "2024-25", played: 2, won: 1, drawn: 0, lost: 1, goals: 3, goals_against: 0, snapshot_id: "a".repeat(64) };

describe("Champions League history routes", () => {
  it.each([["en", "Champions League history"], ["es", "Historial de la Liga de Campeones"]] as const)("renders %s with linked observed totals", async (locale, heading) => {
    readState.fail = false;
    readState.rows = [{ status: "observed", row } as unknown as Record<string, unknown>, { status: "gap", season: "2023-24" }];
    readState.sourceHashes = { "openfootball:CL:2024-25": "b".repeat(64) };
    const response = await app.request(`https://site.invalid/${locale}/seasons/champions-league`, { headers }, env);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain(heading);
    expect(body).toContain(">3</td>");
    expect(body).toContain(locale === "es" ? '<a href="/es/season/2024-25">2024-25</a> <span>(Parcial)</span>' : '<a href="/en/season/2024-25">2024-25</a> <span>(Partial)</span>');
    expect(body).toContain(locale === "es" ? "Fecha de los datos" : "Data snapshot");
    expect((await app.request(`https://site.invalid/${locale}/season/2024-25`, { headers }, env)).status).toBe(200);
    expect(await (await app.request(`https://site.invalid/${locale}/season/2024-25`, { headers }, env)).text()).toContain(`href="/${locale}/seasons/champions-league"`);
  });

  it("renders the no-results state for in-coverage seasons with no rows", async () => {
    readState.fail = false;
    readState.rows = readState.seasons.map((season) => ({ status: "gap", season }));
    const response = await app.request("https://site.invalid/en/seasons/champions-league", { headers }, env);
    const text = await response.text();
    expect(text).toContain(LOCALES.en.strings.clHistory.noResults);
    expect(text).toContain(LOCALES.en.strings.clHistory.gap);
    expect(text).toContain("2024-25");
    expect(text).not.toContain(LOCALES.en.strings.clHistory.outsideCoverage);
  });

  it("keeps the outside-coverage state when the catalog has zero CL seasons", async () => {
    readState.fail = false;
    readState.rows = [];
    const cat = decoded.catalog!;
    const saved = [...cat.coverage];
    cat.coverage.length = 0;
    try {
      const text = await (await app.request("https://site.invalid/en/seasons/champions-league", { headers }, env)).text();
      expect(text).toContain(LOCALES.en.strings.clHistory.outsideCoverage);
      expect(text).not.toContain(LOCALES.en.strings.clHistory.noResults);
    } finally {
      cat.coverage.push(...saved);
    }
  });

  it("withholds an observed row without its expected publication lineage key", async () => {
    readState.fail = false;
    readState.rows = [{ status: "observed", row } as unknown as Record<string, unknown>];
    readState.sourceHashes = {};
    const body = await (await app.request("https://site.invalid/en/seasons/champions-league", { headers }, env)).text();
    expect(body).toContain("Source attribution unavailable for some data.");
    expect(body).not.toContain(">3</td>");
  });

  it("checks publication and snapshot metadata before serving empty coverage", async () => {
    readState.fail = false;
    readState.rows = [];
    readState.sourceHashes = {};
    const { currentPublication } = await import("../worker/src/core/db");
    vi.mocked(currentPublication).mockResolvedValueOnce(null);
    const body = await (await app.request("https://site.invalid/en/seasons/champions-league", { headers }, env)).text();
    expect(body).toContain("temporarily unavailable");
    expect(body).not.toContain("outside current coverage");
  });

  it("renders the temporary-unavailable state on a query failure", async () => {
    readState.fail = true;
    const response = await app.request("https://site.invalid/es/seasons/champions-league", { headers }, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("no está disponible temporalmente");
    readState.fail = false;
  });
});
