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
  runQuery: vi.fn(async () => ({ rows: [{ label: "Synthetic", value: 2 }], snapshot_id: "synthetic", unit: "goals" })),
}));

import app from "../worker/src/index";
import { readQueryCache, runQuery, writeQueryCache } from "../worker/src/core/db";

const intent = withDefaults({ metric: "goals", season: "2024-25", entity_type: "player", entity_id: "all", viz: "bar" });
const denied = { error: "budget_exceeded", message: "Daily compute budget spent. Try again after midnight UTC." };
const auth = { "cf-access-jwt-assertion": "synthetic", Origin: "https://site.invalid" };

function fixture(options: { d1Fails?: boolean; kvFails?: boolean; count?: number; kvCount?: number } = {}) {
  const first = vi.fn(async () => {
    if (options.d1Fails) throw new Error("synthetic storage failure");
    return { count: options.count ?? 1 };
  });
  const all = vi.fn(async () => ({ results: [await first()], meta: { duration: 1, rows_read: 1 } }));
  const bind = vi.fn(() => ({ first, all }));
  const prepare = vi.fn(() => ({ bind }));
  const env = {
    ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    ACCESS_AUD: "a".repeat(64), ACCESS_OWNER_EMAILS: "owner@example.invalid",
    DB: { prepare },
    CFG: {
      get: async () => {
        if (options.kvFails) throw new Error("synthetic KV failure");
        return String(options.kvCount ?? 0);
      },
      put: async () => {},
    },
  } as unknown as Env;
  return { env, first, all, bind, prepare };
}
function post(env: Env) {
  return app.request("https://site.invalid/api/query", {
    method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(intent),
  }, env);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readQueryCache).mockResolvedValue({ result: null, outcome: "miss" });
});

describe("API query authoritative compute budget", () => {
  it.each([false, true])("denies D1 failure with KV failure=%s before compute", async (kvFails) => {
    const f = fixture({ d1Fails: true, kvFails });
    const response = await post(f.env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "budget_unavailable", message: "Compute budget storage is unavailable. Try again shortly.",
    });
    expect(f.all).toHaveBeenCalledOnce();
    expect(runQuery).not.toHaveBeenCalled();
    expect(writeQueryCache).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it.each([1, 1000])("allows authoritative post-increment count %i", async (count) => {
    const f = fixture({ count });
    const response = await post(f.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ rows: [{ label: "Synthetic", value: 2 }], snapshot_id: "synthetic" });
    expect(runQuery).toHaveBeenCalledOnce();
    expect(f.prepare).toHaveBeenCalledWith(expect.stringContaining("RETURNING count"));
    expect(f.bind).toHaveBeenCalledWith(new Date().toISOString().slice(0, 10));
  });
  it("preserves hard-limit denial and JSON shape", async () => {
    const response = await post(fixture({ count: 1001 }).env);
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual(denied);
    expect(runQuery).not.toHaveBeenCalled();
  });
  it("keeps KV breaker denial ahead of D1", async () => {
    const f = fixture({ kvCount: 800 });
    const response = await post(f.env);
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual(denied);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(runQuery).not.toHaveBeenCalled();
  });
  it("serves a validated cache hit without budget storage or compute", async () => {
    const f = fixture({ d1Fails: true });
    vi.mocked(readQueryCache).mockResolvedValue({ outcome: "hit", result: {
      rows: [{ label: "Cached", value: 3 }], snapshot_id: "synthetic", unit: "goals",
    } });
    const response = await post(f.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ rows: [{ label: "Cached", value: 3 }] });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(runQuery).not.toHaveBeenCalled();
    expect(writeQueryCache).not.toHaveBeenCalled();
  });
  it.each(["en", "es"])("fails closed on %s /q when budget storage fails", async (locale) => {
    const f = fixture({ d1Fails: true });
    const query = new URLSearchParams({ metric: "goals", season: "2024-25", entity_type: "player", entity_id: "all", viz: "bar" });
    const response = await app.request(`https://site.invalid/${locale}/q?${query}`, { headers: auth }, f.env);
    expect(response.status).toBe(503);
    expect(runQuery).not.toHaveBeenCalled();
    expect(f.all).toHaveBeenCalledOnce();
  });
});
