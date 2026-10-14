import { describe, expect, it, vi } from "vitest";
// The project intentionally omits Node typings; Vitest executes these tests in Node.
// @ts-expect-error Node's built-in module is available in the configured test runtime.
import { readFileSync } from "node:fs";

import {
  logQueryAggregate,
  queryCacheSlot,
  QUERY_CACHE_SLOT_COUNT,
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

function cacheRow(result: unknown = RESULT, artifactKey = KEY, snapshotId = SNAPSHOT) {
  return { artifact_key: artifactKey, snapshot_id: snapshotId, schema_version: 1, result_json: JSON.stringify(result) };
}

function slotCacheEnv(activeSnapshot = SNAPSHOT) {
  const rows = new Map<number, ReturnType<typeof cacheRow>>();
  const prepare = vi.fn((_sql: string) => ({
    bind: (...values: unknown[]) => ({
      first: async () => rows.get(values[0] as number) ?? null,
      run: async () => {
        const [slot, artifactKey, snapshotId, encoded, activeGuard] = values as [number, string, string, string, string];
        if (activeGuard !== activeSnapshot) return { success: true, meta: { changes: 0 } };
        rows.set(slot, cacheRow(JSON.parse(encoded), artifactKey, snapshotId));
        return { success: true, meta: { changes: 1 } };
      },
    }),
  }));
  return { env: { DB: { prepare } } as unknown as Env, rows, prepare };
}

describe("content-addressed query cache", () => {
  it("accepts only a strict exact-snapshot payload", async () => {
    const env = readEnv(cacheRow());
    await expect(readQueryCache(env, KEY, SNAPSHOT, INTENT)).resolves.toEqual({ outcome: "hit", result: RESULT });
  });

  it("maps valid 64-hex artifact keys deterministically into exactly 512 slots", () => {
    expect(queryCacheSlot(KEY)).toBe(queryCacheSlot(KEY));
    expect(queryCacheSlot("0".repeat(64))).toBe(0);
    expect(queryCacheSlot("f".repeat(64))).toBeGreaterThanOrEqual(0);
    expect(queryCacheSlot("f".repeat(64))).toBeLessThan(QUERY_CACHE_SLOT_COUNT);
    expect(queryCacheSlot("x".repeat(64))).toBeNull();
  });

  it("requires both the exact artifact key and snapshot in the selected slot", async () => {
    await expect(readQueryCache(readEnv(cacheRow(RESULT, "c".repeat(64))), KEY, SNAPSHOT, INTENT))
      .resolves.toEqual({ outcome: "miss", result: null });
    await expect(readQueryCache(readEnv(cacheRow(RESULT, KEY, "c".repeat(64))), KEY, SNAPSHOT, INTENT))
      .resolves.toEqual({ outcome: "miss", result: null });
  });

  it.each([
    { ...cacheRow(), schema_version: 2 },
    cacheRow("not-json"),
    cacheRow({ ...RESULT, extra: true }),
    cacheRow({ ...RESULT, snapshot_id: "c".repeat(64) }),
    cacheRow({ ...RESULT, unit: "assists" }),
    cacheRow({ ...RESULT, rows: Array.from({ length: 11 }, () => ({ label: "x", value: 1, route_key: "fpl:code:1" })) }),
    cacheRow({ ...RESULT, rows: [{ label: "x", value: 1, route_key: "free-form" }] }),
    cacheRow({ ...RESULT, rows: [{ label: "x", value: 1, extra: true }] }),
    cacheRow({ ...RESULT, rows: Array.from({ length: 51 }, () => ({ label: "x", value: 1 })) }),
  ])("treats malformed rows as misses: %j", async (row) => {
    await expect(readQueryCache(readEnv(row), KEY, SNAPSHOT, INTENT)).resolves.toEqual({ outcome: "miss", result: null });
  });

  it("degrades read errors and absent snapshots without exposing errors", async () => {
    await expect(readQueryCache(readEnv(null, true), KEY, SNAPSHOT, INTENT)).resolves.toEqual({ outcome: "unavailable", result: null });
    await expect(readQueryCache(readEnv(null), KEY, null, INTENT)).resolves.toEqual({ outcome: "not_applicable", result: null });
  });

  it("upserts a validated payload and makes write failure non-fatal", async () => {
    const run = vi.fn(async () => ({ success: true, meta: { changes: 1 } }));
    const bind = vi.fn(() => ({ run }));
    const env = { DB: { prepare: vi.fn(() => ({ bind })) } } as unknown as Env;
    await expect(writeQueryCache(env, KEY, SNAPSHOT, RESULT, INTENT)).resolves.toBe(true);
    expect(bind).toHaveBeenCalledWith(queryCacheSlot(KEY), KEY, SNAPSHOT, JSON.stringify(RESULT), SNAPSHOT);

    const failed = { DB: { prepare: vi.fn(() => { throw new Error("storage detail"); }) } } as unknown as Env;
    await expect(writeQueryCache(failed, KEY, SNAPSHOT, RESULT, INTENT)).resolves.toBe(false);
  });

  it("reports an atomic guard refusal as not stored", async () => {
    const run = vi.fn(async () => ({ success: true, meta: { changes: 0 } }));
    const env = { DB: { prepare: vi.fn(() => ({ bind: () => ({ run }) })) } } as unknown as Env;
    await expect(writeQueryCache(env, KEY, SNAPSHOT, RESULT, INTENT)).resolves.toBe(false);
  });

  it("misses after a colliding key overwrites the direct-mapped slot", async () => {
    const firstKey = `${"00000001"}${"a".repeat(56)}`;
    const secondKey = `${"00000201"}${"c".repeat(56)}`;
    expect(queryCacheSlot(firstKey)).toBe(queryCacheSlot(secondKey));
    const { env } = slotCacheEnv();
    await expect(writeQueryCache(env, firstKey, SNAPSHOT, RESULT, INTENT)).resolves.toBe(true);
    await expect(readQueryCache(env, firstKey, SNAPSHOT, INTENT)).resolves.toMatchObject({ outcome: "hit" });
    await expect(writeQueryCache(env, secondKey, SNAPSHOT, RESULT, INTENT)).resolves.toBe(true);
    await expect(readQueryCache(env, firstKey, SNAPSHOT, INTENT)).resolves.toEqual({ outcome: "miss", result: null });
    await expect(readQueryCache(env, secondKey, SNAPSHOT, INTENT)).resolves.toMatchObject({ outcome: "hit" });
  });

  it("does not cache a result after the active snapshot changes", async () => {
    const { env, prepare } = slotCacheEnv("c".repeat(64));
    await expect(writeQueryCache(env, KEY, SNAPSHOT, RESULT, INTENT)).resolves.toBe(false);
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("SELECT snapshot_id FROM snapshots"));
  });

  it("enforces the 512-slot range in the database schema", () => {
    const migration = readFileSync("infra/migrations/0004_cache_slots.sql", "utf8");
    expect(migration).toMatch(/slot\s+INTEGER PRIMARY KEY CHECK \(typeof\(slot\) = 'integer' AND slot >= 0 AND slot < 512\)/);
  });

  it("applies the cache migration before Worker or seed use and preserves publication verification", () => {
    const workflow = readFileSync(".github/workflows/deploy.yml", "utf8");
    const deploySection = workflow.split("  consume-private-seed:")[0];
    const consumerSection = workflow.split("  consume-private-seed:")[1];
    const localSeed = JSON.parse(readFileSync("package.json", "utf8")).scripts["d1:seed"] as string;
    expect(deploySection.indexOf("0004_cache_slots.sql")).toBeLessThan(deploySection.indexOf("Deploy Worker (dev)"));
    expect(consumerSection.indexOf("0004_cache_slots.sql")).toBeLessThan(consumerSection.indexOf("private-seed/0002_seed.sql"));
    expect(consumerSection.indexOf("private-seed/0002_seed.sql")).toBeLessThan(consumerSection.indexOf("Deploy Worker (dev)"));
    expect(localSeed.indexOf("0004_cache_slots.sql")).toBeLessThan(localSeed.indexOf("0002_seed.sql"));
    expect(consumerSection).toContain("verify_private_seed_run.py");
    expect(consumerSection).toContain("verify_private_seed_checksum.py");
    expect(consumerSection).toContain("artifact-ids: ${{ github.event.client_payload.private_artifact_id }}");
  });

  it("treats cache read and write failures as non-fatal", async () => {
    await expect(readQueryCache(readEnv(null, true), KEY, SNAPSHOT, INTENT))
      .resolves.toEqual({ outcome: "unavailable", result: null });
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
