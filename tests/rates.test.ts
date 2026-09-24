import { describe, expect, it } from "vitest";

import { per90 } from "../worker/src/core/rates";

describe("per-90 rate", () => {
  it("computes valid rates without turning missingness into zero", () => {
    expect(per90(2, 180)).toBe(1);
    expect(per90(0, 450)).toBe(0);
    expect(per90(null, 450)).toBeNull();
    expect(per90(2, null)).toBeNull();
    expect(per90(2, 0)).toBeNull();
    expect(per90(-1, 90)).toBeNull();
    expect(per90(Infinity, 90)).toBeNull();
  });
});
