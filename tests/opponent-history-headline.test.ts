import { describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";
import type { HistoryRecord, OpponentHistoryResult } from "../worker/src/core/opponent-history";
import { opponentHistoryBody } from "../worker/src/views/opponent-history";

vi.mock("jose", async (original) => ({ ...await original<typeof import("jose")>(), jwtVerify: vi.fn(async () => ({ payload: { sub: "owner", email: "owner@example.invalid" } })) }));
vi.mock("../worker/src/core/db", async (original) => ({ ...await original<typeof import("../worker/src/core/db")>(),
  enforceBudget: vi.fn(async () => true), currentSnapshot: vi.fn(async () => "a".repeat(64)),
  currentPublication: vi.fn(async () => ({ snapshotId: "a".repeat(64), preparedAt: "2026-01-01T00:00:00.000Z", loadedAt: "2026-01-01T00:00:00.000Z", sources: [] })),
  seasonSplitFacts: vi.fn(async (_env: unknown, snapshot: string, seasons: string[]) => ({ catalog: { snapshot_id: snapshot, seasons: seasons.map(season => ({ season, coverage: "complete" as const })) }, rows: [] })),
}));
const routeState = vi.hoisted(() => ({ result: undefined as unknown }));
vi.mock("../worker/src/core/opponent-history", async (original) => ({ ...await original<typeof import("../worker/src/core/opponent-history")>(),
  readOpponentHistory: vi.fn(async () => routeState.result),
}));

import app from "../worker/src/index";
import { Catalog } from "../worker/src/core/feasibility";

const record = (over: Partial<HistoryRecord> = {}): HistoryRecord => ({ played: 5, won: 2, drawn: 1, lost: 2, goals_for: 9, goals_against: 7, points: 7, goal_difference: 2,
  rate_denominator: 5, points_per_match: 1.4, goals_for_per_match: 1.8, goals_against_per_match: 1.4, win_rate: 0.4, lineage: [], ...over });
const request = { schema_version: 1, competition: "PL", seasons: ["2024-25"], group_by: "opponent", venue: null, opponent_id: "club:1001" } as OpponentHistoryResult["request"];
const result = (over: Partial<OpponentHistoryResult> = {}): OpponentHistoryResult => ({ request, snapshot_id: "a".repeat(64),
  seasons: [{ season: "2024-25", coverage: "complete", status: "available", record: record() }], combined: record(), status: "available", partial: false, contributing_seasons: ["2024-25"], ...over });
const body = (r: OpponentHistoryResult, locale: "en" | "es") => opponentHistoryBody({ result: r, credits: {} }, locale);
const EN = `<p id="h2h-record">5 played · 2 won · 1 drawn · 2 lost · 9–7</p>`;
const ES = `<p id="h2h-record">Jugados: 5 · Ganados: 2 · Empatados: 1 · Perdidos: 2 · Goles: 9–7</p>`;

describe("opponent history record headline", () => {
  it("renders exact EN and ES text before the table", () => {
    expect(body(result(), "en")).toContain(EN);
    expect(body(result(), "es")).toContain(ES);
    expect(body(result(), "en").indexOf(EN)).toBeLessThan(body(result(), "en").indexOf("<table"));
  });
  it("formats numbers with the locale formatter", () => {
    const big = result({ combined: record({ played: 12345, goals_for: 2500 }) });
    expect(body(big, "en")).toContain("12,345 played");
    expect(body(big, "es")).toContain("Jugados: 12.345");
  });
  it("renders counts of 1 without agreement issues", () => {
    const one = result({ combined: record({ played: 1, won: 1, drawn: 0, lost: 0, goals_for: 1, goals_against: 0 }) });
    expect(body(one, "es")).toContain(`<p id="h2h-record">Jugados: 1 · Ganados: 1 · Empatados: 0 · Perdidos: 0 · Goles: 1–0</p>`);
    expect(body(one, "en")).toContain(`<p id="h2h-record">1 played · 1 won · 0 drawn · 0 lost · 1–0</p>`);
  });
  it("says partial when combined is partial", () => {
    const partial = result({ partial: true, status: "partial" });
    expect(body(partial, "en")).toContain(`${EN.slice(0, -4)} · Recorded subtotal; some selected data is missing or partial</p>`);
    expect(body(partial, "es")).toContain(`${ES.slice(0, -4)} · Subtotal registrado; faltan datos seleccionados o son parciales</p>`);
  });
  it.each(["en", "es"] as const)("omits the headline without a combined record or with zero played in %s", locale => {
    expect(body(result({ combined: undefined, status: "missing_capability", partial: true }), locale)).not.toContain("h2h-record");
    expect(body(result({ combined: undefined, status: "partial", partial: true, seasons: [{ season: "2024-25", coverage: "partial", status: "missing_capability" }] }), locale)).not.toContain("h2h-record");
    expect(body(result({ combined: record({ played: 0, won: 0, drawn: 0, lost: 0, goals_for: 0, goals_against: 0 }), status: "no_matches" }), locale)).not.toContain("h2h-record");
  });
  it.each(["en", "es"] as const)("renders through the route mapping in %s", async locale => {
    routeState.result = result();
    vi.spyOn(Catalog.prototype, "outputCapability").mockReturnValue("clear");
    const env = { ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64), ACCESS_OWNER_EMAILS: "owner@example.invalid",
      DB: { prepare: vi.fn(() => ({ first: async () => ({ count: 1 }), bind: () => ({ first: async () => ({ count: 1 }) }) })) } } as unknown as Env;
    const response = await app.request(`https://site.invalid/${locale}/opponents/history?opponent_id=club%3A1001&seasons=2024-25`, { headers: { "cf-access-jwt-assertion": "synthetic", Origin: "https://site.invalid" } }, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(locale === "en" ? EN : ES);
  });
});
