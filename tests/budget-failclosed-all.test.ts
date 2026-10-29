import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";
import { withDefaults } from "../worker/src/core/intent";

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
  allPlayerNames: vi.fn(async () => []),
  saveQuestionHistory: vi.fn(async () => {}),
  runQuery: vi.fn(async () => ({ rows: [{ label: "Synthetic", value: 2 }], snapshot_id: "synthetic", unit: "goals" })),
}));

import app from "../worker/src/index";
import { logQueryAggregate, readQueryCache, runQuery } from "../worker/src/core/db";

const realDb = await vi.importActual<typeof import("../worker/src/core/db")>("../worker/src/core/db");
const intent = withDefaults({ metric: "goals", season: "2024-25", entity_type: "player", entity_id: "all", viz: "bar" });
const auth = { "cf-access-jwt-assertion": "synthetic", Origin: "https://site.invalid" };
const query = new URLSearchParams({ metric: "goals", season: "2024-25", entity_type: "player", entity_id: "all", viz: "bar" });

function fixture(options: { d1Fails?: boolean; count?: unknown; kvCount?: number } = {}) {
  const first = vi.fn(async () => {
    if (options.d1Fails) throw new Error("synthetic storage failure");
    return { count: "count" in options ? options.count : 1 };
  });
  const all = vi.fn(async () => ({ results: [await first()], meta: { duration: 1, rows_read: 1 } }));
  const prepare = vi.fn(() => ({ bind: vi.fn(() => ({ first, all })) }));
  const env = {
    ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    ACCESS_AUD: "a".repeat(64), ACCESS_OWNER_EMAILS: "owner@example.invalid",
    DB: { prepare },
    CFG: { get: async () => String(options.kvCount ?? 0), put: async () => {} },
  } as unknown as Env;
  return { env, first, all, prepare };
}
const api = (env: Env) => app.request("https://site.invalid/api/query", {
  method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(intent),
}, env);
const ask = (env: Env) => app.request("https://site.invalid/en/ask", {
  method: "POST", headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ q: "top scorers 2024-25" }).toString(),
}, env);
const q = (env: Env) => app.request(`https://site.invalid/en/q?${query}`, { headers: auth }, env);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readQueryCache).mockResolvedValue({ result: null, outcome: "miss" });
});

describe("budget fails closed on every compute route", () => {
  it("/q denies on D1 write failure with KV below threshold", async () => {
    const f = fixture({ d1Fails: true, kvCount: 5 });
    const response = await q(f.env);
    expect(response.status).toBe(503);
    expect(f.all).toHaveBeenCalledOnce();
    expect(runQuery).not.toHaveBeenCalled();
  });
  it("/q over the hard limit still shows the budget page with 429-class refusal, not the outage", async () => {
    const response = await q(fixture({ count: 1001 }).env);
    expect(await response.text()).toContain("budget_exceeded");
    expect(runQuery).not.toHaveBeenCalled();
  });
  it("/ask denies on D1 write failure with KV below threshold", async () => {
    const f = fixture({ d1Fails: true, kvCount: 5 });
    const response = await ask(f.env);
    expect(response.status).toBe(503);
    expect(f.all).toHaveBeenCalledOnce();
    expect(runQuery).not.toHaveBeenCalled();
  });
  it("/q cache hit is served without touching budget storage", async () => {
    const f = fixture({ d1Fails: true });
    vi.mocked(readQueryCache).mockResolvedValue({ outcome: "hit", result: {
      rows: [{ label: "Cached", value: 3 }], snapshot_id: "synthetic", unit: "goals",
    } });
    const response = await q(f.env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Cached");
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it("/api/query: outage is 503 budget_unavailable, over-limit is 429 budget_exceeded", async () => {
    const outage = await api(fixture({ d1Fails: true }).env);
    expect(outage.status).toBe(503);
    expect(await outage.json()).toMatchObject({ error: "budget_unavailable", message: expect.any(String) });
    const over = await api(fixture({ count: 1001 }).env);
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ error: "budget_exceeded", message: expect.any(String) });
  });
  it("aggregate outcome for an outage is distinct from budget_exceeded", async () => {
    await api(fixture({ d1Fails: true }).env);
    await api(fixture({ count: 1001 }).env);
    const outcomes = vi.mocked(logQueryAggregate).mock.calls.map(call => call[4]);
    expect(outcomes).toEqual(["refused", "budget_exceeded"]);
  });
  it("clears a stale denial reason on entry and fails closed by default", async () => {
    const denial: { reason?: "over_limit" | "unavailable" } = { reason: "over_limit" };
    expect(await realDb.enforceBudget(fixture({ count: 1 }).env, { denial })).toBe(true);
    expect(denial.reason).toBeUndefined();
    expect(await realDb.enforceBudget(fixture({ d1Fails: true }).env, { denial })).toBe(false);
    expect(denial.reason).toBe("unavailable");
    expect(await realDb.enforceBudget(fixture({ d1Fails: true }).env, { failClosed: false })).toBe(true);
  });
  it.each([NaN,Infinity, null, "1"])("non-finite count %j denies regardless of policy", async (count) => {
    for (const failClosed of [true, false, undefined]) {
      const denial: { reason?: "over_limit" | "unavailable" } = {};
      expect(await realDb.enforceBudget(fixture({ count }).env, { failClosed, denial })).toBe(false);
      expect(denial.reason).toBe("unavailable");
    }
  });
});
