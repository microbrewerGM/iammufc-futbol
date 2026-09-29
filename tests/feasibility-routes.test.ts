import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Catalog, type FeasibilityState } from "../worker/src/core/feasibility";
import type { Env } from "../worker/src/core/db";

// Use the real Access middleware and same-origin checks; signature tests live
// in auth.test.ts. All claims and data here are synthetic.
vi.mock("jose", async (original) => ({
  ...await original<typeof import("jose")>(),
  jwtVerify: vi.fn(async () => ({ payload: { sub: "owner", email: "owner@example.invalid" } })),
}));
vi.mock("../worker/src/core/db", async (original) => ({
  ...await original<typeof import("../worker/src/core/db")>(),
  currentSnapshot: vi.fn(async () => "synthetic"),
  logQueryAggregate: vi.fn(async () => {}),
  readQueryCache: vi.fn(async () => ({ result: null, outcome: "miss" })),
  writeQueryCache: vi.fn(async () => false),
  enforceBudget: vi.fn(async () => true),
  runQuery: vi.fn(async () => ({ rows: [{ label: "Synthetic", value: 2 }], snapshot_id: "synthetic" })),
}));
import app from "../worker/src/index";
import { enforceBudget, readQueryCache, runQuery, writeQueryCache } from "../worker/src/core/db";

const env = {
  ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64),
  ACCESS_OWNER_EMAILS: "owner@example.invalid",
} as Env;
const headers = { "cf-access-jwt-assertion": "synthetic", Origin: "https://site.invalid", "content-type": "application/json" };
const intent = { metric: "goals", entity_type: "player", entity_id: "all", season: "2024-25", competition: "PL", viz: "bar" };

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("feasibility execution gate", () => {
  it.each<FeasibilityState>(["no_data", "no_rights"])("does not read cache, execute or charge %s", async (state) => {
    vi.spyOn(Catalog.prototype, "checkFeasibility").mockReturnValue({ state, reason: "Synthetic refusal", cost_class: "expensive" });
    const api = await app.request("https://site.invalid/api/query", { method: "POST", headers, body: JSON.stringify(intent) }, env);
    expect(api.status).toBe(200);
    expect(await api.json()).toMatchObject({ feasibility: { state }, rows: [] });
    for (const locale of ["en", "es"]) {
      const response = await app.request(`https://site.invalid/${locale}/q?metric=goals&season=2024-25&viz=bar&entity_id=all`, { headers }, env);
      const markup = await response.text();
      expect(response.status).toBe(200);
      expect(markup).toContain(`<p class="state">${state}</p>`);
      expect(markup).toContain("Synthetic refusal");
      expect(markup).not.toContain("<svg");
      expect(markup).not.toContain("query returned nothing");
    }
    expect(enforceBudget).not.toHaveBeenCalled();
    expect(runQuery).not.toHaveBeenCalled();
    expect(readQueryCache).not.toHaveBeenCalled();
    expect(writeQueryCache).not.toHaveBeenCalled();
  });

  it("checks an expensive request for an existing artifact but does not compute a miss", async () => {
    vi.spyOn(Catalog.prototype, "checkFeasibility").mockReturnValue({
      state: "computable_but_expensive", reason: "Synthetic deferral", cost_class: "expensive",
    });
    const response = await app.request("https://site.invalid/api/query", {
      method: "POST", headers, body: JSON.stringify(intent),
    }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ feasibility: { state: "computable_but_expensive" }, rows: [] });
    expect(readQueryCache).toHaveBeenCalledOnce();
    expect(enforceBudget).not.toHaveBeenCalled();
    expect(runQuery).not.toHaveBeenCalled();
    expect(writeQueryCache).not.toHaveBeenCalled();
  });

  it("serves an existing expensive artifact only after the current rights check", async () => {
    vi.spyOn(Catalog.prototype, "checkFeasibility").mockImplementation((_intent, _locale, artifactExists) =>
      artifactExists
        ? { state: "available", reason: "Cached", cost_class: "cheap" }
        : { state: "computable_but_expensive", reason: "Synthetic deferral", cost_class: "expensive" },
    );
    vi.mocked(readQueryCache).mockResolvedValueOnce({
      outcome: "hit",
      result: { rows: [{ label: "Cached", value: 3 }], snapshot_id: "synthetic", unit: "goals" },
    });
    const response = await app.request("https://site.invalid/api/query", {
      method: "POST", headers, body: JSON.stringify(intent),
    }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ feasibility: { state: "available" }, rows: [{ label: "Cached", value: 3 }] });
    expect(enforceBudget).not.toHaveBeenCalled();
    expect(runQuery).not.toHaveBeenCalled();
  });

  it.each<FeasibilityState>(["available", "computable_now_queued"])("still executes %s", async (state) => {
    vi.spyOn(Catalog.prototype, "checkFeasibility").mockReturnValue({ state, reason: "Synthetic usable coverage", cost_class: "cheap" });
    const response = await app.request("https://site.invalid/api/query", { method: "POST", headers, body: JSON.stringify(intent) }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ rows: [{ label: "Synthetic", value: 2 }] });
    expect(enforceBudget).toHaveBeenCalledOnce();
    expect(runQuery).toHaveBeenCalledOnce();
    const page = await app.request("https://site.invalid/en/q?metric=goals&season=2024-25&viz=bar&entity_id=all", { headers }, env);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<svg");
    expect(enforceBudget).toHaveBeenCalledTimes(2);
    expect(runQuery).toHaveBeenCalledTimes(2);
  });
});
