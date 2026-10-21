import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";
import type { PlayerRangeRequest } from "../worker/src/core/player-range";

vi.mock("jose", async (original) => ({
  ...await original<typeof import("jose")>(),
  jwtVerify: vi.fn(async () => ({ payload: { sub: "range-user", email: "owner@example.invalid" } })),
}));

vi.mock("../worker/src/core/db", async (original) => ({
  ...await original<typeof import("../worker/src/core/db")>(),
  currentSnapshot: vi.fn(async () => "a".repeat(64)),
  enforceBudget: vi.fn(async () => true),
  savePlayerRangeHistory: vi.fn(async () => {}),
  playerRangeFacts: vi.fn(async (_env: Env, request: PlayerRangeRequest) => ({
    catalog: { snapshot_id: "a".repeat(64), person_ids: request.person_ids, seasons: request.seasons },
    labels: request.person_ids.map((person_id, i) => ({ person_id, label: `Player ${i + 1}` })),
    rows: request.person_ids.flatMap((person_id) => request.seasons.map((season) => ({
      person_id, season, competition: "PL" as const, metric: request.metric,
      definition: request.metric === "goals" ? "goals" as const : "fpl_assists" as const,
      total: 1, minutes: 90, snapshot_id: "a".repeat(64), lineage: ["fpl:synthetic"],
    }))),
  })),
  playerRangeIdentityCatalog: vi.fn(async (_env: Env, person_ids: string[], seasons: string[], snapshot_id: string) => ({ snapshot_id, person_ids: person_ids.filter((id) => ids.includes(id)), seasons })),
}));

import app from "../worker/src/index";
import { currentSnapshot, enforceBudget, playerRangeFacts, playerRangeIdentityCatalog, savePlayerRangeHistory } from "../worker/src/core/db";

const ids = ["fpl:code:101", "fpl:code:202"];
const headers = { "cf-access-jwt-assertion": "synthetic" };
const env = { ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64),
  ACCESS_OWNER_EMAILS: "owner@example.invalid" } as Env;
const url = (locale = "en") => `https://site.invalid/${locale}/players/compare?schema_version=1&competition=PL&person_ids=${ids[0]}&person_ids=${ids[1]}&seasons=2024-25&metric=goals&normalization=total&min_minutes=0&viz=table`;

beforeEach(() => vi.clearAllMocks());

describe("bounded player range routes", () => {
  it("requires Access before any B13 data read", async () => {
    const response = await app.request(url(), {}, env);
    expect(response.status).toBe(403);
    expect(playerRangeFacts).not.toHaveBeenCalled();
    expect(playerRangeIdentityCatalog).not.toHaveBeenCalled();
  });

  it.each(["en", "es"])("renders the frozen comparison body and navigation in %s", async (locale) => {
    const response = await app.request(url(locale), { headers }, env);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain(`action="/${locale}/players/compare"`);
    expect(body).toContain(locale === "es" ? "Comparar jugadores" : "Compare players");
    expect(body).toContain("Player 1");
    expect(body).toContain(`href="/${locale}/players/compare"`);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(savePlayerRangeHistory).toHaveBeenCalledOnce();
    expect(vi.mocked(savePlayerRangeHistory).mock.calls[0]?.[2]).toContain("person_ids=fpl%3Acode%3A101");
  });

  it("rejects bounds, unknown people, unlisted seasons and duplicate scalar fields", async () => {
    for (const [index, query] of [
      "person_ids=fpl%3Acode%3A101&seasons=2024-25",
      `person_ids=${ids[0]}&person_ids=${ids[1]}&person_ids=fpl%3Acode%3A303&seasons=2024-25&seasons=2024-25&seasons=2024-25&seasons=2024-25&seasons=2024-25&seasons=2024-25&seasons=2024-25&seasons=2024-25&seasons=2024-25`,
      `person_ids=${ids[0]}&person_ids=fpl%3Acode%3A999&seasons=2024-25`,
      `person_ids=${ids[0]}&person_ids=${ids[1]}&seasons=1900-01`,
      `${new URL(url()).search.slice(1)}&metric=assists`,
    ].entries()) {
      const response = await app.request(`https://site.invalid/en/players/compare?${query}`, { headers }, env);
      expect(response.status, `invalid vector ${index}`).toBe(400);
    }
    expect(playerRangeFacts).not.toHaveBeenCalled();
  });

  it("uses explicit stable IDs and rejects a stale snapshot or exhausted budget", async () => {
    const response = await app.request(url(), { headers }, env);
    expect(response.status).toBe(200);
    expect(playerRangeFacts).toHaveBeenCalledOnce();
    expect(vi.mocked(playerRangeFacts).mock.calls[0]?.[1].person_ids).toEqual(ids);
    vi.mocked(enforceBudget).mockResolvedValueOnce(false);
    const limited = await app.request(url(), { headers }, env);
    expect(limited.status).toBe(429);
    vi.mocked(currentSnapshot).mockResolvedValueOnce(null);
    const unavailable = await app.request(url(), { headers }, env);
    expect(unavailable.status).toBe(503);
  });
});
