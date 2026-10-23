import { describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";

vi.mock("jose", async (original) => ({
  ...await original<typeof import("jose")>(),
  jwtVerify: vi.fn(async () => ({ payload: { sub: "owner", email: "owner@example.invalid" } })),
}));

const readState = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], fail: false, seasons: ["2024-25", "2023-24"] as string[] }));
vi.mock("../worker/src/core/cl-history", async (original) => ({
  ...await original<typeof import("../worker/src/core/cl-history")>(),
  clHistoryRows: vi.fn(async () => {
    if (readState.fail) throw new Error("synthetic database failure");
    return { snapshot_id: "a".repeat(64), entries: readState.rows as never };
  }),
}));
vi.mock("../worker/src/core/db", async (original) => ({
  ...await original<typeof import("../worker/src/core/db")>(),
  currentSnapshot: vi.fn(async () => "a".repeat(64)),
  currentPublication: vi.fn(async () => ({ snapshotId: "a".repeat(64), preparedAt: "2026-10-23T00:00:00.000Z", loadedAt: "2026-10-23T00:00:00.000Z", sources: [{ id: "openfootball_cl", status: "observed" }] })),
  seasonSquadRows: vi.fn(async () => []),
  seasonRecordRow: vi.fn(async () => null),
  seasonHistoryRows: vi.fn(async () => []),
}));

import app from "../worker/src/index";

const env = { ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64), ACCESS_OWNER_EMAILS: "owner@example.invalid" } as Env;
const headers = { "cf-access-jwt-assertion": "synthetic" };
const row = { season: "2024-25", played: 2, won: 1, drawn: 0, lost: 1, goals: 3, goals_against: 0, snapshot_id: "a".repeat(64) };

describe("Champions League history routes", () => {
  it.each([["en", "Champions League history"], ["es", "Historial de la Liga de Campeones"]] as const)("renders %s with linked observed totals", async (locale, heading) => {
    readState.fail = false;
    readState.rows = [{ status: "observed", row } as unknown as Record<string, unknown>, { status: "gap", season: "2023-24" }];
    const response = await app.request(`https://site.invalid/${locale}/seasons/champions-league`, { headers }, env);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain(heading);
    expect(body).toContain(">3</td>");
    expect(body).toContain(locale === "es" ? "Fecha de los datos" : "Data snapshot");
    expect((await app.request(`https://site.invalid/${locale}/season/2024-25`, { headers }, env)).status).toBe(200);
    expect(await (await app.request(`https://site.invalid/${locale}/season/2024-25`, { headers }, env)).text()).toContain(`href="/${locale}/seasons/champions-league"`);
  });

  it("renders the explicit empty-coverage state", async () => {
    readState.fail = false;
    readState.rows = [];
    const response = await app.request("https://site.invalid/en/seasons/champions-league", { headers }, env);
    expect(await response.text()).toContain("outside current coverage");
  });

  it("renders the temporary-unavailable state on a query failure", async () => {
    readState.fail = true;
    const response = await app.request("https://site.invalid/es/seasons/champions-league", { headers }, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("no está disponible temporalmente");
    readState.fail = false;
  });
});
