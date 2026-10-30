import { describe, expect, it } from "vitest";

import { ppgOf, winPctOf } from "../worker/src/core/manager-era-rates";

describe("manager era rates", () => {
  it("rounds points per game to two decimals and win percentage to one", () => {
    expect(ppgOf(9, 3)).toBe(3.00);
    expect(ppgOf(1, 3)).toBe(0.33);
    expect(winPctOf(1, 3)).toBe(33.3);
  });

  it("rounds positive ties half up", () => {
    expect(ppgOf(1, 8)).toBe(0.13);
    expect(winPctOf(1, 8)).toBe(12.5);
  });

  it("returns null for an era with no played fixtures", () => {
    expect(ppgOf(0, 0)).toBeNull();
    expect(winPctOf(0, 0)).toBeNull();
  });

  it("rejects negative, fractional, and NaN counts", () => {
    for (const invalid of [-1, 1.5, Number.NaN]) {
      expect(() => ppgOf(invalid, 3)).toThrow();
      expect(() => ppgOf(1, invalid)).toThrow();
      expect(() => winPctOf(invalid, 3)).toThrow();
      expect(() => winPctOf(1, invalid)).toThrow();
    }
  });

  it("keeps fixture points consistent with results and within the maximum", () => {
    const fixture = { played: 3, won: 1, drawn: 1, lost: 1 };
    const points = 3 * fixture.won + fixture.drawn;

    expect(fixture.won + fixture.drawn + fixture.lost).toBe(fixture.played);
    expect(points).toBe(4);
    expect(points).toBeLessThanOrEqual(3 * fixture.played);
    expect(ppgOf(points, fixture.played)).toBe(1.33);
  });
});
