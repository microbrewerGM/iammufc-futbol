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
  currentSnapshot: vi.fn(async () => "snapshot-a"),
  seasonSquadRows: vi.fn(async () => []),
  seasonRecordRow: vi.fn(async (_env: unknown, season: string, competition = "PL") =>
    competition === "PL" && ["2024-25", "2015-16", "2014-15"].includes(season)
      ? season === "2014-15"
        ? { season, played: 38, won: 20, drawn: 10, lost: 8, goals: 62, goals_against: 37 }
        : season === "2015-16"
        ? { season, played: 38, won: 19, drawn: 9, lost: 10, goals: 49, goals_against: 35 }
        : { season, played: 38, won: 11, drawn: 9, lost: 18, goals: 44, goals_against: 54 }
      : null,
  ),
  seasonHistoryRows: vi.fn(async (_env: unknown, seasons: string[]) =>
    seasons.map((season, index) => season === "2014-15"
      ? {
          season, played: 38, won: 20, drawn: 10, lost: 8,
          goals: 62, goals_against: 37, snapshot_id: "snapshot-a",
        }
      : season === "2015-16"
      ? {
          season, played: 38, won: 19, drawn: 9, lost: 10,
          goals: 49, goals_against: 35, snapshot_id: "snapshot-a",
        }
      : {
          season,
          played: 38,
          won: season === "2024-25" ? 11 : 20,
          drawn: season === "2024-25" ? 9 : 8,
          lost: season === "2024-25" ? 18 : 10,
          goals: season === "2024-25" ? 44 : 60 - index,
          goals_against: 40,
          snapshot_id: "snapshot-a",
        }),
  ),
}));

import app from "../worker/src/index";
import { seasonHistoryRows } from "../worker/src/core/db";

const env = {
  ACCESS_ISSUER: "https://example.cloudflareaccess.com",
  ACCESS_AUD: "a".repeat(64),
  ACCESS_OWNER_EMAILS: "owner@example.invalid",
} as Env;
const headers = { "cf-access-jwt-assertion": "synthetic" };

beforeEach(() => vi.clearAllMocks());

describe("authenticated team-season comparison", () => {
  it("denies anonymous access before reading history", async () => {
    expect((await app.request("https://site.invalid/en/season/2024-25", {}, env)).status).toBe(403);
    expect(seasonHistoryRows).not.toHaveBeenCalled();
  });

  it.each([
    ["en", "League season comparison", "1.11"],
    ["es", "Comparación de temporadas de liga", "1,11"],
  ] as const)("renders the stable localized %s page", async (locale, heading, rate) => {
    const response = await app.request(`https://site.invalid/${locale}/season/2024-25`, { headers }, env);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain(heading);
    expect(body).toContain(`>${rate}</td>`);
    expect(body).toContain(`href="/${locale === "en" ? "es" : "en"}/season/2024-25"`);
    expect(body).not.toContain("2025-26</a>");
    expect(seasonHistoryRows).toHaveBeenCalled();
  });

  it("withholds the comparison for an uncovered selected season", async () => {
    const response = await app.request("https://site.invalid/en/season/2030-31", { headers }, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("comparison is unavailable");
    expect(seasonHistoryRows).toHaveBeenCalledWith(env, []);
  });

  it.each([
    ["en", "1.74", "1.29"],
    ["es", "1,74", "1,29"],
  ] as const)("serves the exact authenticated 2015-16 %s page", async (locale, ppg, gpg) => {
    const response = await app.request(`https://site.invalid/${locale}/season/2015-16`, { headers }, env);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain(`>${ppg}</td>`);
    expect(body).toContain(`>${gpg}</td>`);
    expect(body).toContain("Football-Data.co.uk");
    expect(body).toContain(locale === "en"
      ? "No squad data integrated for 2015-16."
      : "No hay datos de plantilla integrados para 2015-16.");
  });

  it.each([
    ["en", "1.84", "1.63"],
    ["es", "1,84", "1,63"],
  ] as const)("serves the exact authenticated 2014-15 %s page", async (locale, ppg, gpg) => {
    const response = await app.request(`https://site.invalid/${locale}/season/2014-15`, { headers }, env);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain(`>${ppg}</td>`);
    expect(body).toContain(`>${gpg}</td>`);
    expect(body).toContain("Football-Data.co.uk");
    expect(body).toContain(locale === "en"
      ? "No squad data integrated for 2014-15."
      : "No hay datos de plantilla integrados para 2014-15.");
  });
});
