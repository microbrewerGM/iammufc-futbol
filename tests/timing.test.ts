import { afterEach, describe, expect, it, vi } from "vitest";

import { recordReadTiming } from "../worker/src/core/timing";

afterEach(() => vi.restoreAllMocks());

describe("D1 timing sink", () => {
  it("emits only the query name and D1 timing metadata", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    recordReadTiming("resolvePlayerIdentity", { duration: 2.5, rows_read: 3 });
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith({ query: "resolvePlayerIdentity", duration: 2.5, rows_read: 3 });
  });

  it("does not throw when the sink fails", () => {
    vi.spyOn(console, "log").mockImplementation(() => { throw new Error("sink unavailable"); });
    expect(() => recordReadTiming("enforceBudget", { duration: 1, rows_read: 1 })).not.toThrow();
  });
});
