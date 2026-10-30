import { describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";

vi.mock("jose", async (original) => ({
  ...await original<typeof import("jose")>(),
  jwtVerify: vi.fn(async () => ({ payload: { sub: "owner", email: "owner@example.invalid" } })),
}));

const state = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
vi.mock("../worker/src/core/cl-history", async (original) => ({
  ...await original<typeof import("../worker/src/core/cl-history")>(),
  clHistoryRead: vi.fn(async () => ({
    result: { snapshot_id: "a".repeat(64), entries: state.rows as never },
    sourcesJson: JSON.stringify({ "openfootball:CL:2024-25": "b".repeat(64) }),
  })),
}));
vi.mock("../worker/src/core/db", async (original) => ({
  ...await original<typeof import("../worker/src/core/db")>(),
  currentSnapshot: vi.fn(async () => "a".repeat(64)),
  currentPublication: vi.fn(async () => ({ snapshotId: "a".repeat(64), preparedAt: "2026-10-23T00:00:00.000Z", loadedAt: "2026-10-23T00:00:00.000Z", sources: [{ id: "openfootball_cl", status: "observed" }] })),
}));

import app from "../worker/src/index";

const env = { ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64), ACCESS_OWNER_EMAILS: "owner@example.invalid", DB: { prepare: () => ({ first: async () => null }) } } as unknown as Env;
const headers = { "cf-access-jwt-assertion": "synthetic", Origin: "https://site.invalid", "Sec-Fetch-Site": "same-origin" };

describe("Champions League history CSV export", () => {
  it("downloads newest-first visible aggregates, leaves gaps empty, and includes lineage credit", async () => {
    state.rows = [
      { status: "observed", row: { season: "2024-25", played: 2, won: 1, drawn: 0, lost: 1, goals: 3, goals_against: 0, snapshot_id: "a".repeat(64), stage_reached: "group_stage" } },
      { status: "gap", season: "2023-24" },
    ];
    const response = await app.request("https://site.invalid/en/seasons/champions-league?format=csv", { headers }, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe([
      '"Season","Stage reached","Played","Won","Drawn","Lost","Goals for","Goals against","Attribution"',
      '"2024-25","Group stage","2","1","0","1","3","0","openfootball"',
      '"2023-24","","","","","","","",""',
    ].join("\r\n") + "\r\n");
  });

  it("neutralizes formula-leading values in every exported text cell", async () => {
    state.rows = [{ status: "gap", season: "@cmd" }];
    const response = await app.request("https://site.invalid/es/seasons/champions-league?format=csv", { headers }, env);
    const csv = await response.text();
    expect(csv).toContain('"Temporada","Fase alcanzada","Jugados","Ganados","Empatados","Perdidos","Goles a favor","Goles en contra","Atribución"');
    expect(csv).toContain('"\'@cmd","","","","","","","",""');
  });

  it("localizes known stages and leaves unknown, formula-leading, and unattributed stage cells empty", async () => {
    state.rows = [
      { status: "observed", row: { season: "2024-25", played: 1, won: 1, drawn: 0, lost: 0, goals: 1, goals_against: 0, stage_reached: "group_stage", lineage: ["openfootball:CL:2024-25"] } },
      { status: "observed", row: { season: "2023-24", played: 1, won: 1, drawn: 0, lost: 0, goals: 1, goals_against: 0, stage_reached: "not_a_stage", lineage: ["openfootball:CL:2023-24"] } },
      { status: "observed", row: { season: "2022-23", played: 1, won: 1, drawn: 0, lost: 0, goals: 1, goals_against: 0, stage_reached: "=cmd", lineage: ["openfootball:CL:2022-23"] } },
      { status: "observed", row: { season: "2021-22", played: 1, won: 1, drawn: 0, lost: 0, goals: 1, goals_against: 0, stage_reached: "-x", lineage: ["openfootball:CL:2021-22"] } },
      { status: "observed", row: { season: "2020-21", played: 1, won: 1, drawn: 0, lost: 0, goals: 1, goals_against: 0, stage_reached: "@SUM(A1)", lineage: ["openfootball:CL:2020-21"] } },
      { status: "observed", row: { season: "2019-20", played: 1, won: 1, drawn: 0, lost: 0, goals: 1, goals_against: 0, stage_reached: "group_stage" } },
      { status: "observed", row: { season: "2018-19", played: 1, won: 1, drawn: 0, lost: 0, goals: 1, goals_against: 0, stage_reached: null, lineage: ["openfootball:CL:2018-19"] } },
    ];
    const csv = await (await app.request("https://site.invalid/es/seasons/champions-league?format=csv", { headers }, env)).text();
    const enCsv = await (await app.request("https://site.invalid/en/seasons/champions-league?format=csv", { headers }, env)).text();
    expect(csv).toContain('"2024-25","Fase de grupos","1"');
    expect(csv).toContain('"2023-24","","","","","","","",""');
    for (const season of ["2022-23", "2021-22", "2020-21", "2019-20", "2018-19"]) expect(csv).toContain(`"${season}","","","","","","","",""`);
    expect(enCsv).toContain('"2024-25","Group stage","1","1","0","0","1","0","openfootball"');
    expect(enCsv).toContain('"2019-20","","","","","","","",""');
  });

  it.each(["\t=cmd", "\r=cmd"]) ("prefixes an apostrophe to a season beginning with a tab or carriage return", async (season) => {
    state.rows = [{ status: "gap", season }];
    const response = await app.request("https://site.invalid/en/seasons/champions-league?format=csv", { headers }, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`"'${season}"`);
  });

  it("rejects a cross-origin GET to the CSV URL", async () => {
    const response = await app.request("https://site.invalid/en/seasons/champions-league?format=csv", {
      headers: { ...headers, Origin: "https://attacker.invalid", "Sec-Fetch-Site": "cross-site" },
    }, env);
    expect(response.status).toBe(403);
  });
});
