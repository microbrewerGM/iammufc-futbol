import { describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";
import { LOCALES } from "../worker/src/core/locale";
import { executeComparison } from "../worker/src/core/comparison";
import { Catalog, type CompiledCatalog } from "../worker/src/core/feasibility";
import compiled from "../worker/src/generated/catalog.json";
import { comparisonPage } from "../worker/src/views/comparison";

vi.mock("jose", async (original) => ({
  ...await original<typeof import("jose")>(),
  jwtVerify: vi.fn(async (token: string) => {
    if (token !== "synthetic") throw new Error("denied");
    return { payload: { sub: "owner", email: "owner@example.invalid" } };
  }),
}));

import app from "../worker/src/index";

const row = (id: string, label: string, goals: number, assists: number, minutes: number) => ({
  player_id: id, label, goals, assists, minutes, snapshot_id: "synthetic",
});
// Alpha: 2G/0A in 180 (1.00 / 0.00); Beta: 1G/4A in 360 (0.25 / 1.00);
// Gamma: 9G/9A in 90 (below the 100-minute minimum).
const fixture = [
  row("fpl:1:2024-25", "Synthetic Alpha", 2, 0, 180),
  row("fpl:2:2024-25", "Synthetic Beta", 1, 4, 360),
  row("fpl:3:2024-25", "Synthetic Gamma", 9, 9, 90),
];

function setup() {
  const prepare = vi.fn((query: string) => ({
    bind: vi.fn(() => ({
      all: vi.fn(async () => ({
        results: fixture.map((r) => ({
          player_id: r.player_id, label: r.label, minutes: r.minutes, snapshot_id: r.snapshot_id,
          goals: r.goals, assists: r.assists,
          total: query.includes("s.assists AS total") ? r.assists : r.goals,
        })),
      })),
    })),
  }));
  const env = {
    ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    ACCESS_AUD: "a".repeat(64),
    ACCESS_OWNER_EMAILS: "owner@example.invalid",
    DB: { prepare },
  } as unknown as Env;
  return { env, prepare };
}
const headers = { "cf-access-jwt-assertion": "synthetic" };
const get = async (env: Env, path: string) => {
  const res = await app.request(`https://site.invalid${path}`, { headers }, env);
  return { status: res.status, body: await res.text() };
};

describe("compare goals + assists per 90", () => {
  it("renders both per-90 columns in EN and ES with correct values", async () => {
    const { env } = setup();
    const coreResult = await executeComparison(
      env,
      new Catalog(compiled as unknown as CompiledCatalog),
      { season: "2024-25", metric: "goals", minMinutes: 100 },
    );
    expect(coreResult.ok && coreResult.rows[0]?.goalsRate).toBe(1);
    expect(coreResult.ok && coreResult.rows[0]?.assistsRate).toBe(0);
    const q = "season=2024-25&metric=goals&min_minutes=100";
    const en = await get(env, `/en/compare?${q}`);
    expect(en.status).toBe(200);
    expect(en.body).toContain("Goals per 90");
    expect(en.body).toContain("FPL assists per 90");
    expect(en.body).toContain("Synthetic Alpha</th><td>180</td><td>2</td><td>1.00</td><td>0</td><td>0.00</td>");
    expect(en.body).toContain("Synthetic Beta</th><td>360</td><td>1</td><td>0.25</td><td>4</td><td>1.00</td>");
    const es = await get(env, `/es/compare?${q}`);
    expect(es.body).toContain("Goles por 90");
    expect(es.body).toContain("Asistencias FPL por 90");
    expect(es.body).toContain("Synthetic Beta</th><td>360</td><td>1</td><td>0,25</td><td>4</td><td>1,00</td>");
    expect(en.body).toContain("<caption>");
  });

  it("switches rank with metric=assists and keeps min-minutes exclusion", async () => {
    const { env } = setup();
    const goals = (await get(env, "/en/compare?season=2024-25&metric=goals&min_minutes=100")).body;
    const assists = (await get(env, "/en/compare?season=2024-25&metric=assists&min_minutes=100")).body;
    expect(goals.indexOf("Synthetic Alpha")).toBeLessThan(goals.indexOf("Synthetic Beta"));
    expect(assists.indexOf("Synthetic Beta")).toBeLessThan(assists.indexOf("Synthetic Alpha"));
    expect(assists).toContain('value="assists" selected');
    expect(assists).toContain("Goals per 90");
    expect(assists).toContain("FPL assists per 90");
    for (const body of [goals, assists]) expect(body).not.toContain("Synthetic Gamma");
    const all = (await get(env, "/en/compare?season=2024-25&metric=goals&min_minutes=0")).body;
    expect(all).toContain("Synthetic Gamma");
  });

  it("uses one bounded SELECT for both metrics and charges no budget", async () => {
    const { env, prepare } = setup();
    await get(env, "/en/compare?season=2024-25&metric=goals&min_minutes=100");
    const queries = prepare.mock.calls.map((c) => c[0]);
    expect(queries).toHaveLength(1);
    expect(queries.filter((q) => q.includes("budget_counter"))).toHaveLength(0);
    expect(queries[0]).toContain("s.goals AS goals");
    expect(queries[0]).toContain("s.assists AS assists");
  });

  it("shows a refusal, not zeros, when the other metric has no coverage", async () => {
    const result = {
      ok: true as const, snapshot: "synthetic", key: "k", attribution: "attr", otherCovered: false, otherAttribution: null,
      rows: [{ player_id: "p1", label: "Synthetic Alpha", total: 2, minutes: 180, rate: 1, other_total: null, other_rate: null, goalsRate: 1, assistsRate: null }],
    };
    for (const code of ["en", "es"] as const) {
      const body = await comparisonPage(
        { season: "2024-25", metric: "goals", minMinutes: 100 }, result, ["2024-25"], ["goals"], LOCALES[code],
      ).text();
      expect(body).toContain(code === "en" ? "Unavailable: no coverage" : "No disponible: sin cobertura");
      expect(body).toContain("<td>2</td><td>1");
    }
  });
});
