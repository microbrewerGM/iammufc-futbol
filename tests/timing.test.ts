import { afterEach, describe, expect, it, vi } from "vitest";

import { enforceBudget, resolvePlayerIdentity, type Env } from "../worker/src/core/db";
import { readOpponentHistory } from "../worker/src/core/opponent-history";

afterEach(() => vi.restoreAllMocks());

function d1Env(results: unknown[] = []) {
  return {
    CFG: { get: vi.fn(async () => null), put: vi.fn(async () => {}) },
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          all: vi.fn(async () => ({ results, meta: { duration: 2.5, rows_read: 3, changes: 99 } })),
        })),
      })),
    },
  } as unknown as Env;
}

async function expectReadTiming<T>(read: (env: Env) => Promise<T>, query: string, expected: T, results: unknown[] = []) {
  const env = d1Env(results);
  const loggingEnv = d1Env(results);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const result = await read(env);
  expect(result).toEqual(expected);
  expect(log).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith({ query, duration: 2.5, rows_read: 3 });
  expect(log.mock.calls[0]).toEqual([{ query, duration: 2.5, rows_read: 3 }]);

  log.mockImplementation(() => { throw new Error("sink unavailable"); });
  await expect(read(loggingEnv)).resolves.toEqual(result);
}

describe("D1 read timing", () => {
  it("records budget reads and preserves the result when logging fails", async () => {
    await expectReadTiming((readEnv) => enforceBudget(readEnv), "enforceBudget", true, [{ count: 1 }]);
  });

  it("records person-id identity reads without exposing the person id", async () => {
    await expectReadTiming(
      (env) => resolvePlayerIdentity(env, "fpl:code:141746"),
      "resolvePlayerIdentity",
      { person_id: "fpl:code:141746", web_name: "Fernandes" },
      [{ person_id: "fpl:code:141746", web_name: "Fernandes" }],
    );
  });

  it("records alias identity reads without exposing the alias", async () => {
    await expectReadTiming(
      (env) => resolvePlayerIdentity(env, "Fernandes"),
      "resolvePlayerIdentity",
      { person_id: "fpl:code:141746", web_name: "Fernandes" },
      [{ person_id: "fpl:code:141746", web_name: "Fernandes", exact_match: 1 }],
    );
  });

  it("records opponent history reads without exposing request data", async () => {
    const seasons = ["2024-25"];
    const request = { schema_version: 1, competition: "PL", seasons, group_by: "opponent", venue: null, opponent_id: "club:1001" };
    const catalog = { snapshot_id: "a".repeat(64), seasons: [{ season: seasons[0], coverage: "complete" }] };
    const env = d1Env();
    const loggingEnv = d1Env();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await readOpponentHistory(env, request, catalog);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]).toEqual([{ query: "readOpponentHistory", duration: 2.5, rows_read: 3 }]);
    log.mockImplementation(() => { throw new Error("sink unavailable"); });
    await expect(readOpponentHistory(loggingEnv, request, catalog)).resolves.toEqual(result);
  });
});
