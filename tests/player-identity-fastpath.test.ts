import { describe, expect, it, vi } from "vitest";

import { resolvePlayerIdentity, type Env } from "../worker/src/core/db";

type Row = Record<string, unknown>;

function captureEnv(results: Row[]) {
  const sql: string[] = [];
  const binds: unknown[][] = [];
  const prepare = vi.fn((query: string) => {
    sql.push(query);
    return {
      bind: (...args: unknown[]) => {
        binds.push(args);
        return { all: async () => ({ results }) };
      },
    };
  });
  return { env: { DB: { prepare } } as unknown as Env, sql, binds };
}

describe("player identity person-id fast path", () => {
  it("resolves an exact person id without any LIKE query", async () => {
    const { env, sql, binds } = captureEnv([{ person_id: "fpl:code:141746", web_name: "Latest" }]);
    await expect(resolvePlayerIdentity(env, "fpl:code:141746")).resolves.toEqual({
      person_id: "fpl:code:141746",
      web_name: "Latest",
    });
    expect(sql).toHaveLength(1);
    expect(sql[0]).not.toMatch(/like/i);
    expect(sql[0]).toContain("i.person_id = ?");
    expect(binds[0]).toEqual(["fpl:code:141746", "PL"]);
  });

  it("returns null for an unknown person id and still skips LIKE", async () => {
    const { env, sql } = captureEnv([]);
    await expect(resolvePlayerIdentity(env, "fpl:code:999999999")).resolves.toBeNull();
    expect(sql).toHaveLength(1);
    expect(sql[0]).not.toMatch(/like/i);
  });

  it("keeps the substring path for a loose alias", async () => {
    const { env, sql } = captureEnv([
      { person_id: "fpl:code:101", web_name: "Fernandes", exact_match: 1 },
    ]);
    await expect(resolvePlayerIdentity(env, "Fernandes")).resolves.toEqual({
      person_id: "fpl:code:101",
      web_name: "Fernandes",
    });
    expect(sql[0]).toMatch(/like/i);
  });

  it("keeps failing closed on an ambiguous alias and the short-needle guard", async () => {
    const { env } = captureEnv([
      { person_id: "fpl:code:101", web_name: "Fletcher", exact_match: 1 },
      { person_id: "fpl:code:202", web_name: "Fletcher", exact_match: 1 },
    ]);
    await expect(resolvePlayerIdentity(env, "Fletcher")).resolves.toBeNull();
    const guard = captureEnv([]);
    await expect(resolvePlayerIdentity(guard.env, "ab")).resolves.toBeNull();
    expect(guard.sql).toHaveLength(0);
  });
});
