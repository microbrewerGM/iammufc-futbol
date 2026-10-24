import { describe, expect, it } from "vitest";

import { per90 } from "../worker/src/core/rates";

describe("per-90 rate edge cases", () => {
  it("pins the 90-minute boundary and unrounded fractional rates", () => {
    expect(per90(7, 90)).toBe(7);
    expect(per90(1, 270)).toBe(1 / 3);
    expect(per90(1, 7)).toBe(90 / 7);
  });

  it("handles very large safe integer totals and minutes", () => {
    const largestSafeInteger = Number.MAX_SAFE_INTEGER;

    expect(per90(largestSafeInteger, largestSafeInteger)).toBe(90);
    expect(per90(largestSafeInteger, 90)).toBe(largestSafeInteger);
  });
});
