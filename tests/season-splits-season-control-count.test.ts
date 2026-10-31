import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import { seasonSplitsBody, type SeasonSplitView } from "../worker/src/views/season-splits";
import { beforeEach, describe as routeDescribe, expect as routeExpect, it as routeIt, vi } from "vitest";
import type { Env } from "../worker/src/core/db";

vi.mock("jose", async (original) => ({ ...await original<typeof import("jose")>(), jwtVerify: vi.fn(async () => ({ payload: { sub: "owner", email: "owner@example.invalid" } })) }));
vi.mock("../worker/src/core/db", async (original) => ({
  ...await original<typeof import("../worker/src/core/db")>(),
  enforceBudget: vi.fn(async () => true), currentSnapshot: vi.fn(async () => "a".repeat(64)),
  currentPublication: vi.fn(async () => ({ snapshotId: "a".repeat(64), preparedAt: "2026-01-01T00:00:00.000Z", loadedAt: "2026-01-01T00:00:00.000Z", sources: [] })),
  seasonSplitFacts: vi.fn(async (_env: unknown, snapshot: string, seasons: string[]) => ({ catalog: { snapshot_id: snapshot, seasons: seasons.map(season => ({ season, coverage: "complete" as const })) }, rows: [] })),
}));
import app from "../worker/src/index";
import { Catalog } from "../worker/src/core/feasibility";

const env = { ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64), ACCESS_OWNER_EMAILS: "owner@example.invalid", DB: { prepare: () => ({ first: async () => ({ count: 1 }), bind: () => ({ first: async () => ({ count: 1 }) }) }) } } as unknown as Env;
const headers = { "cf-access-jwt-assertion": "synthetic", Origin: "https://site.invalid" };
const capability = vi.spyOn(Catalog.prototype, "outputCapability").mockReturnValue("clear");

const view = (seasons: string[]): SeasonSplitView => ({
  selection: { seasons, group_by: "opponent", venue: "", opponent_id: "" },
  seasons: ["2023-24", "2024-25", "2025-26"], opponents: [], credits: {},
});

describe("season picker selected count", () => {
  it.each([
    ["en", ["2024-25"], "Seasons (1 selected; choose 1–16)"],
    ["en", ["2023-24", "2025-26"], "Seasons (2 selected; choose 1–16)"],
    ["es", ["2024-25"], "Temporadas (1 seleccionadas; elige 1–16)"],
    ["es", ["2023-24", "2024-25", "2025-26"], "Temporadas (3 seleccionadas; elige 1–16)"],
  ] as const)("renders an accessible localized legend for %s selection", (code, selected, legend) => {
    const body = seasonSplitsBody(view([...selected]), LOCALES[code]);
    expect(body).toContain(`<legend>${legend}</legend>`);
    const checked = [...body.matchAll(/<input id="splits-season-\d+" type="checkbox" name="seasons" value="([^"]+)" checked>/g)].map(match => match[1]);
    expect(checked).toEqual(selected);
  });
});

routeDescribe("season picker selection after route validation errors", () => {
  beforeEach(() => capability.mockReturnValue("clear"));
  routeIt.each(["en", "es"] as const)("retains submitted valid seasons and count in %s", async code => {
    const response = await app.request(`https://site.invalid/${code}/seasons/explore?seasons=2024-25&seasons=not-a-season`, { headers }, env);
    const body = await response.text();
    routeExpect(response.status).toBe(400);
    routeExpect(body).toContain('role="alert"');
    routeExpect(body).toContain(code === "en" ? "Seasons (1 selected; choose 1–16)" : "Temporadas (1 seleccionadas; elige 1–16)");
    routeExpect(body).toMatch(/name="seasons" value="2024-25" checked>/);
    routeExpect(body).not.toMatch(/name="seasons" value="not-a-season" checked>/);
  });
});
