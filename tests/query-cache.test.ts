import { describe, expect, it, vi } from "vitest";

import {
  logQueryAggregate,
  readQueryCache,
  writeQueryCache,
  type Env,
  type QueryResult,
} from "../worker/src/core/db";
import { withDefaults } from "../worker/src/core/intent";

const KEY = "a".repeat(64);
const SNAPSHOT = "b".repeat(64);
const RESULT: QueryResult = {
  rows: [{ label: "Synthetic", value: 4, secondary: "FW", route_key: "fpl:code:1" }],
  snapshot_id: SNAPSHOT,
  unit: "goals",
};
const INTENT = withDefaults({
  metric: "goals",
  entity_type: "player",
  entity_id: "all",
  season: "2024-25",
  viz: "bar",
});

function readEnv(row: unknown, failure = false): Env {
  const first = failure ? vi.fn(async () => { throw new Error("storage detail"); }) : vi.fn(async () => row);
  const bind = vi.fn(() => ({ first }));
  return { DB: { prepare: vi.fn(() => ({ bind })) } } as unknown as Env;
}

describe("content-addressed query cache", () => {
  it("accepts only a strict exact-snapshot payload", async () => {
    const env = readEnv({ schema_version: 1, result_json: JSON.stringify(RESULT) });
    await expect(readQueryCache(env, KEY, SNAPSHOT, INTENT)).resolves.toEqual({ outcome: "hit", result: RESULT });
  });

  it.each([
    { schema_version: 2, result_json: JSON.stringify(RESULT) },
    { schema_version: 1, result_json: "not-json" },
    { schema_version: 1, result_json: JSON.stringify({ ...RESULT, extra: true }) },
    { schema_version: 1, result_json: JSON.stringify({ ...RESULT, snapshot_id: "c".repeat(64) }) },
    { schema_version: 1, result_json: JSON.stringify({ ...RESULT, unit: "assists" }) },
    { schema_version: 1, result_json: JSON.stringify({ ...RESULT, rows: Array.from({ length: 11 }, () => ({ label: "x", value: 1, route_key: "fpl:code:1" })) }) },
    { schema_version: 1, result_json: JSON.stringify({ ...RESULT, rows: [{ label: "x", value: 1, route_key: "free-form" }] }) },
    { schema_version: 1, result_json: JSON.stringify({ ...RESULT, rows: [{ label: "x", value: 1, extra: true }] }) },
    { schema_version: 1, result_json: JSON.stringify({ ...RESULT, rows: Array.from({ length: 51 }, () => ({ label: "x", value: 1 })) }) },
  ])("treats malformed rows as misses: %j", async (row) => {
    await expect(readQueryCache(readEnv(row), KEY, SNAPSHOT, INTENT)).resolves.toEqual({ outcome: "miss", result: null });
  });

  it("degrades read errors and absent snapshots without exposing errors", async () => {
    await expect(readQueryCache(readEnv(null, true), KEY, SNAPSHOT, INTENT)).resolves.toEqual({ outcome: "unavailable", result: null });
    await expect(readQueryCache(readEnv(null), KEY, null, INTENT)).resolves.toEqual({ outcome: "not_applicable", result: null });
  });

  it("upserts a validated payload and makes write failure non-fatal", async () => {
    const run = vi.fn(async () => ({}));
    const bind = vi.fn(() => ({ run }));
    const env = { DB: { prepare: vi.fn(() => ({ bind })) } } as unknown as Env;
    await expect(writeQueryCache(env, KEY, SNAPSHOT, RESULT, INTENT)).resolves.toBe(true);
    expect(bind).toHaveBeenCalledWith(KEY, SNAPSHOT, JSON.stringify(RESULT));

    const failed = { DB: { prepare: vi.fn(() => { throw new Error("storage detail"); }) } } as unknown as Env;
    await expect(writeQueryCache(failed, KEY, SNAPSHOT, RESULT, INTENT)).resolves.toBe(false);
  });
});

describe("privacy-safe query demand", () => {
  it("upserts only finite aggregate dimensions", async () => {
    const run = vi.fn(async () => ({}));
    const bind = vi.fn(() => ({ run }));
    const env = { DB: { prepare: vi.fn(() => ({ bind })) } } as unknown as Env;
    const intent = withDefaults({ metric: "goals", entity_type: "player", entity_id: "all", season: "2024-25", viz: "bar" });
    await logQueryAggregate(env, intent, "available", "hit", "success", "es", "query_page");
    expect(bind).toHaveBeenCalledWith("goals", "player_ranking", "bar", "available", "hit", "success", "es", "query_page");
    expect(JSON.stringify(bind.mock.calls)).not.toContain("2024-25");
  });

  it("maps arbitrary metric text to a finite other bucket", async () => {
    const run = vi.fn(async () => ({}));
    const bind = vi.fn(() => ({ run }));
    const env = { DB: { prepare: vi.fn(() => ({ bind })) } } as unknown as Env;
    const intent = withDefaults({ metric: "user supplied text", entity_type: "player", entity_id: "all", season: "2024-25", viz: "bar" });
    await logQueryAggregate(env, intent, "no_data", "not_applicable", "refused", "api", "query_api");
    expect(bind).toHaveBeenCalledWith("other", "player_ranking", "bar", "no_data", "not_applicable", "refused", "api", "query_api");
    expect(JSON.stringify(bind.mock.calls)).not.toContain("user supplied text");
  });

  it.each([
    ["progressive_passes", "match", "match"],
    ["goals", "opponent", "opponent"],
    ["goals", "competition", "competition"],
  ] as const)("retains bounded unmet demand for %s/%s", async (metric, entityType, family) => {
    const run = vi.fn(async () => ({}));
    const bind = vi.fn(() => ({ run }));
    const env = { DB: { prepare: vi.fn(() => ({ bind })) } } as unknown as Env;
    const intent = withDefaults({ metric, entity_type: entityType, entity_id: "all", season: "2024-25", viz: "bar" });
    await logQueryAggregate(env, intent, "no_data", "not_applicable", "refused", "api", "query_api");
    expect(bind).toHaveBeenCalledWith(metric, family, "bar", "no_data", "not_applicable", "refused", "api", "query_api");
  });
});
