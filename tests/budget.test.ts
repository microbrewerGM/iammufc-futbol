/**
 * enforceBudget() has no D1/KV test harness yet -- @cloudflare/vitest-pool-workers
 * is deliberately deferred to the future route-test milestone (see
 * vitest.config.ts's own comment). These are hand-rolled, minimal stubs of
 * exactly the KV/D1 surface the function calls, not a general emulator --
 * enough to test the real logic (fast-path limit, hard-limit enforcement,
 * fail-open on storage error) without pulling in that infra early.
 */

import { describe, expect, it } from "vitest";

import { enforceBudget, type Env } from "../worker/src/core/db";

function fakeEnv(): Env {
  const kv = new Map<string, string>();
  const day = new Map<string, number>();

  const CFG = {
    get: async (key: string) => kv.get(key) ?? null,
    put: async (key: string, value: string) => {
      kv.set(key, value);
    },
  } as unknown as KVNamespace;

  const DB = {
    prepare: (sql: string) => {
      let bound: unknown[] = [];
      const stmt = {
        bind: (...args: unknown[]) => {
          bound = args;
          return stmt;
        },
        run: async () => {
          const key = String(bound[0]);
          day.set(key, (day.get(key) ?? 0) + 1);
          return { success: true } as unknown;
        },
        first: async <T>() => {
          const key = String(bound[0]);
          if (sql.includes("SELECT count")) {
            return { count: day.get(key) ?? 0 } as unknown as T;
          }
          return null;
        },
      };
      return stmt;
    },
  } as unknown as D1Database;

  return { DB, CFG };
}

describe("enforceBudget", () => {
  it("allows requests under the limit", async () => {
    const env = fakeEnv();
    expect(await enforceBudget(env)).toBe(true);
    expect(await enforceBudget(env)).toBe(true);
  });

  it("trips the KV fast-path once the daily count reaches the fast limit", async () => {
    const env = fakeEnv();
    for (let i = 0; i < 800; i++) {
      await enforceBudget(env);
    }
    // The 801st call must see kvCount >= 800 and refuse before touching D1.
    expect(await enforceBudget(env)).toBe(false);
  });

  it("D1 stays the authoritative gate even if KV is unavailable", async () => {
    const env = fakeEnv();
    (env.CFG as unknown as { get: () => never }).get = () => {
      throw new Error("KV down");
    };
    // Push D1's own count past the hard limit directly.
    for (let i = 0; i < 1000; i++) {
      await env.DB.prepare("INSERT INTO budget_counter (day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1")
        .bind(new Date().toISOString().slice(0, 10))
        .run();
    }
    expect(await enforceBudget(env)).toBe(false);
  });

  it("fails open when D1 itself is unavailable, rather than taking the site down", async () => {
    const env = fakeEnv();
    (env.DB as unknown as { prepare: () => never }).prepare = () => {
      throw new Error("D1 down");
    };
    expect(await enforceBudget(env)).toBe(true);
  });
});
