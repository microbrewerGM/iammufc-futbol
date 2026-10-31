import { describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";
import { LOCALES } from "../worker/src/core/locale";

vi.mock("jose", async (original) => ({
  ...await original<typeof import("jose")>(),
  jwtVerify: vi.fn(async () => ({ payload: { sub: "owner", email: "owner@example.invalid" } })),
}));

const readState = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], sourceHashes: { "openfootball:CL:2024-25": "b".repeat(64), "openfootball:CL:2023-24": "c".repeat(64) } as Record<string, string> }));
vi.mock("../worker/src/core/cl-history", async (original) => ({
  ...await original<typeof import("../worker/src/core/cl-history")>(),
  clHistoryRead: vi.fn(async () => ({ result: { snapshot_id: "a".repeat(64), entries: readState.rows as never }, sourcesJson: JSON.stringify(readState.sourceHashes) })),
}));
vi.mock("../worker/src/core/db", async (original) => ({
  ...await original<typeof import("../worker/src/core/db")>(),
  currentSnapshot: vi.fn(async () => "a".repeat(64)),
  currentPublication: vi.fn(async () => ({ snapshotId: "a".repeat(64), preparedAt: "2026-10-23T00:00:00.000Z", loadedAt: "2026-10-23T00:00:00.000Z", sources: [{ id: "openfootball_cl", status: "observed" }] })),
  seasonSquadRows: vi.fn(async () => []),
  seasonRecordRow: vi.fn(async () => null),
  seasonHistoryRows: vi.fn(async () => []),
}));

const snapshotDb = {
  prepare: vi.fn(() => ({ first: vi.fn(async () => ({ snapshot_id: "a".repeat(64), sources_json: JSON.stringify(readState.sourceHashes) })) })),
};

import app from "../worker/src/index";

const env = { ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64), ACCESS_OWNER_EMAILS: "owner@example.invalid" } as Env;
Object.assign(env, { DB: snapshotDb });
const headers = { "cf-access-jwt-assertion": "synthetic", Origin: "https://site.invalid", "Sec-Fetch-Site": "same-origin" };
const row = { season: "2024-25", played: 2, won: 1, drawn: 0, lost: 1, goals: 3, goals_against: 0, snapshot_id: "a".repeat(64) };

describe("Champions League totals row through the route mapping", () => {
  it.each(["en", "es"] as const)("renders the totals row on a realistic response in %s", async (locale) => {
    const strings = LOCALES[locale].strings.clHistory;
    readState.rows = [{ status: "observed", row } as unknown as Record<string, unknown>, { status: "gap", season: "2023-24" }];
    const body = await (await app.request(`https://site.invalid/${locale}/seasons/champions-league`, { headers }, env)).text();
    const label = strings.observedSeasons.replace("{n}", "1");
    expect(body).toContain(`<tfoot><tr><th scope="row">${label} <span>${strings.seasonsExcluded.replace("{n}", "1")}</span></th><td></td><td>2</td><td>1</td><td>0</td><td>1</td><td>3</td><td>0</td></tr></tfoot>`);
  });

  it.each([["en", "Stage reached", "Group stage", "Source attribution unavailable for some data."], ["es", "Fase alcanzada", "Fase de grupos", "Atribución de fuente no disponible para algunos datos."]] as const)(
    "maps observed and unavailable stages through the %s route while retaining the gap",
    async (locale, stageHeader, groupLabel, unavailable) => {
      const strings = LOCALES[locale].strings.clHistory;
      readState.rows = [
        { status: "observed", row: { ...row, stage_reached: "group_stage" } } as unknown as Record<string, unknown>,
        { status: "observed", row: { ...row, season: "2023-24", stage_reached: null } } as unknown as Record<string, unknown>,
        { status: "gap", season: "2025-26" },
      ];
      const response = await app.request(`https://site.invalid/${locale}/seasons/champions-league`, { headers }, env);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain(`<th scope="col">${strings.season}</th><th scope="col">${stageHeader}</th>`);
      expect(body).toContain(`<td>${groupLabel}</td><td>2</td>`);
      expect(body).toContain(`<td><span aria-label="${unavailable}">—</span> <span>${unavailable}</span></td><td>2</td>`);
      const headersCount = (body.match(/<th scope="col">/g) ?? []).length;
      expect(headersCount).toBe(8);
      expect(body).toContain(`<tr><th scope="row">2025-26</th><td colspan="${headersCount - 1}"><span aria-label="${strings.gap}">—</span> <span>${strings.gap}</span></td></tr>`);
    },
  );
});
