/**
 * DEV-D1-BUDGET-WRITES: enforceBudget issues exactly one D1 statement
 * (INSERT ... ON CONFLICT ... RETURNING count), with unchanged allow/deny
 * outcomes, and the demand-aggregate write is deferred via waitUntil.
 * Stubs cover only the KV/D1 surface the code calls.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("jose", async (original) => ({
  ...await original<typeof import("jose")>(),
  jwtVerify: vi.fn(async () => ({ payload: { sub: "owner", email: "owner@example.invalid" } })),
}));

vi.mock("../worker/src/core/db", async (original) => ({
  ...await original<typeof import("../worker/src/core/db")>(),
  currentSnapshot: vi.fn(async () => "synthetic"),
  logQueryAggregate: vi.fn(async () => {}),
  readQueryCache: vi.fn(async () => ({ result: null, outcome: "not_applicable" })),
  writeQueryCache: vi.fn(async () => false),
  enforceBudget: vi.fn(async () => true),
  runQuery: vi.fn(async () => ({ rows: [{ label: "Synthetic", value: 2 }], snapshot_id: "synthetic", unit: "goals" })),
}));

import app from "../worker/src/index";
import { logQueryAggregate, type Env } from "../worker/src/core/db";

const realDb = await vi.importActual<typeof import("../worker/src/core/db")>("../worker/src/core/db");

function fakeEnv(opts: { d1Start?: number; kvStart?: number; kvFails?: boolean; d1Fails?: boolean } = {}) {
  const sql: string[] = [];
  let d1 = opts.d1Start ?? 0;
  const kv = new Map<string, string>();
  if (opts.kvStart !== undefined) kv.set(`budget:${new Date().toISOString().slice(0, 10)}`, String(opts.kvStart));
  const CFG = {
    get: async (k: string) => {
      if (opts.kvFails) throw new Error("KV down");
      return kv.get(k) ?? null;
    },
    put: async (k: string, v: string) => {
      if (opts.kvFails) throw new Error("KV down");
      kv.set(k, v);
    },
  } as unknown as KVNamespace;
  const DB = {
    prepare: (text: string) => {
      sql.push(text);
      const stmt = {
        bind: () => stmt,
        first: async () => {
          if (opts.d1Fails) throw new Error("D1 down");
          d1 += 1;
          return { count: d1 };
        },
        run: async () => {
          throw new Error("enforceBudget must not use run()");
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { env: { DB, CFG } as Env, sql };
}

describe("enforceBudget single D1 statement", () => {
  it.each([
    [0, true], [998, true], [999, true], [1000, false], [1500, false],
  ])("D1 count before call %i -> allowed=%s, one RETURNING statement", async (before, allowed) => {
    // Post-increment count is before+1; the 1000th request is allowed, the 1001st denied.
    const { env, sql } = fakeEnv({ d1Start: before });
    expect(await realDb.enforceBudget(env)).toBe(allowed);
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/INSERT INTO budget_counter[\s\S]*ON CONFLICT[\s\S]*RETURNING count/);
  });

  it("KV fast limit: 799 allowed with one D1 statement; 800 and 900 denied with none", async () => {
    const below = fakeEnv({ kvStart: 799 });
    expect(await realDb.enforceBudget(below.env)).toBe(true);
    expect(below.sql).toHaveLength(1);
    for (const kvStart of [800, 900]) {
      const e = fakeEnv({ kvStart });
      expect(await realDb.enforceBudget(e.env)).toBe(false);
      expect(e.sql).toHaveLength(0);
    }
  });

  it.each([[true, false], [false, true]])("D1 failure, failClosed=%s -> %s after one statement", async (failClosed, expected) => {
    const { env, sql } = fakeEnv({ d1Fails: true });
    expect(await realDb.enforceBudget(env, { failClosed })).toBe(expected);
    expect(sql).toHaveLength(1);
  });

  it.each([[true], [false]])("KV failure falls through to the D1 gate (failClosed=%s)", async (failClosed) => {
    const ok = fakeEnv({ kvFails: true, d1Start: 5 });
    expect(await realDb.enforceBudget(ok.env, { failClosed })).toBe(true);
    expect(ok.sql).toHaveLength(1);
    const over = fakeEnv({ kvFails: true, d1Start: 1000 });
    expect(await realDb.enforceBudget(over.env, { failClosed })).toBe(false);
    expect(over.sql).toHaveLength(1);
  });

  it.each([[true, false], [false, true]])("KV and D1 both failing, failClosed=%s -> %s", async (failClosed, expected) => {
    const { env } = fakeEnv({ kvFails: true, d1Fails: true });
    expect(await realDb.enforceBudget(env, { failClosed })).toBe(expected);
  });
});

describe("logQueryAggregate deferral", () => {
  const env = {
    ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    ACCESS_AUD: "a".repeat(64),
    ACCESS_OWNER_EMAILS: "owner@example.invalid",
  } as Env;
  const body = {
    metric: "goals", season: "2024-25", entity_type: "player", entity_id: "all",
    competition: "PL", viz: "bar", limit: 10,
  };
  const post = (ctx?: ExecutionContext) =>
    app.request("https://site.invalid/api/query", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": "synthetic", Origin: "https://site.invalid", "content-type": "application/json" },
      body: JSON.stringify(body),
    }, env, ctx);
  const ctxWith = (waitUntil: unknown) => ({ waitUntil, passThroughOnException: vi.fn() }) as unknown as ExecutionContext;

  beforeEach(() => vi.clearAllMocks());

  it("hands a never-settling aggregate write to waitUntil without awaiting it", async () => {
    vi.mocked(logQueryAggregate).mockImplementationOnce(() => new Promise<void>(() => {}));
    const waitUntil = vi.fn();
    const res = await post(ctxWith(waitUntil));
    expect(res.status).toBe(200);
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it("a rejecting aggregate write never changes the response", async () => {
    const baseline = await post();
    const baselineBody = await baseline.text();
    vi.mocked(logQueryAggregate).mockRejectedValueOnce(new Error("D1 down"));
    const waitUntil = vi.fn();
    const res = await post(ctxWith(waitUntil));
    expect(res.status).toBe(baseline.status);
    expect(await res.text()).toBe(baselineBody);
    await expect(waitUntil.mock.calls[0]?.[0]).resolves.toBeUndefined();
  });
});
