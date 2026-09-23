import { describe, expect, it, vi } from "vitest";
import { runQuery, type Env } from "../worker/src/core/db";
import { withDefaults, type QueryIntent } from "../worker/src/core/intent";

describe("executor defense", () => {
  it.each([
    { entity_type: "season", metric: "assists" },
    { entity_type: "match" },
    { filters: { position: "GK" } },
    { dimensions: ["position"] },
    { viz: "line" },
    { entity_id: "" },
  ])("refuses unsupported direct calls before SQL: %j", async (override) => {
    const prepare = vi.fn();
    const intent = withDefaults({
      metric: "goals",
      season: "2024-25",
      entity_id: "all",
      ...override,
    } as Parameters<typeof withDefaults>[0]);
    await expect(runQuery({ DB: { prepare } } as unknown as Env, intent)).rejects.toThrow(
      "unsupported_query",
    );
    expect(prepare).not.toHaveBeenCalled();
  });

  it("refuses malformed typed-boundary input before SQL", async () => {
    const prepare = vi.fn();
    await expect(
      runQuery(
        { DB: { prepare } } as unknown as Env,
        { metric: "goals", season: "2024-25", entity_id: 8 } as unknown as QueryIntent,
      ),
    ).rejects.toThrow("unsupported_query");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("preserves the supported player ranking path", async () => {
    const all = vi.fn(async () => ({
      results: [{ label: "Synthetic", value: 2, secondary: "FW" }],
    }));
    const bind = vi.fn((_season: string, _competition: string, _limit: number) => ({ all }));
    const prepare = vi.fn((query: string) =>
      query.includes("FROM snapshots")
        ? { first: async () => ({ snapshot_id: "synthetic" }) }
        : { bind },
    );
    const intent = withDefaults({
      metric: "goals",
      season: "2024-25",
      entity_id: "all",
      competition: "PL",
      viz: "bar",
      limit: 3,
    });
    await expect(runQuery({ DB: { prepare } } as unknown as Env, intent)).resolves.toEqual({
      rows: [{ label: "Synthetic", value: 2, secondary: "FW" }],
      snapshot_id: "synthetic",
      unit: "goals",
    });
    expect(bind).toHaveBeenCalledWith("2024-25", "PL", 3);
  });
});
