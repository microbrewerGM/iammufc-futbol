import { describe, expect, it } from "vitest";
import { adaptArrivalManagerAnswer } from "../worker/src/core/arrival-manager-answer";

const base = () => ({
  version: 1,
  as_of: "2026-07-02",
  snapshot_id: "snap-1",
  coverage: "partial",
  population_count: 2,
  lineage: ["source:one"],
  rows: [
    { player: "Alex Player", manager: "Coach One", entry_type: "effective_arrival", entry_date: "2026-06-01", status: "assigned", reason: null, coverage: "complete", as_of: "2026-07-02", snapshot_id: "snap-1", lineage: ["source:one"] },
    { player: "Unknown Player", manager: null, entry_type: null, entry_date: null, status: "unknown", reason: "tenure_missing", coverage: "partial", as_of: "2026-07-02", snapshot_id: "snap-1", lineage: ["source:one"] },
  ],
});

describe("arrival manager answer adapter", () => {
  it("adapts valid partial answers and keeps unknown rows visible", () => {
    const model = adaptArrivalManagerAnswer(base(), { "source:one": "Validated source credit", unused: "Unrelated" });
    expect(model.error).toBeUndefined();
    expect(model.result?.coverage).toBe("partial");
    expect(model.players).toEqual({ "answer-row:0": "Alex Player", "answer-row:1": "Unknown Player" });
    expect(model.managers).toEqual({ "answer-manager:Coach One": "Coach One" });
    expect(model.result?.assigned).toHaveLength(1);
    expect(model.result?.unknown).toMatchObject([{ member_id: "answer-row:1", reason: "tenure_missing" }]);
    expect(model.entries["answer-row:0"]).toEqual({ event_type: "effective_arrival", date: { earliest: "2026-06-01", latest: "2026-06-01", precision: "day" } });
    expect(model.credits).toEqual({ "source:one": "Validated source credit" });
  });

  it.each([
    ["malformed", { ...base(), extra: true }],
    ["wrong version", { ...base(), version: 2 }],
    ["row snapshot mismatch", { ...base(), rows: [{ ...base().rows[0], snapshot_id: "other" }] }],
    ["row date mismatch", { ...base(), rows: [{ ...base().rows[0], as_of: "2026-07-01" }] }],
  ])("fails closed for %s", (_name, input) => {
    const model = adaptArrivalManagerAnswer(input, { "source:one": "Credit" });
    expect(model.error).toBeTruthy();
    expect(model.result).toBeUndefined();
    expect(model.players).toEqual({});
    expect(model.managers).toEqual({});
    expect(model.credits).toEqual({});
  });

  it("fails closed when the expected request or snapshot does not match", () => {
    const answer = base();
    const request = { version: 1 as const, family: "arrival_manager" as const, as_of: "2026-07-02", population: "first_team_available" as const,
      joining_basis: "effective_first_team_spell_entry" as const, academy_basis: "documented_first_team_promotion" as const, visualization: "table" as const };
    for (const expected of [{ request: { ...request, as_of: "2026-07-01" } }, { snapshot_id: "other-snapshot" }]) {
      const model = adaptArrivalManagerAnswer(answer, {}, expected);
      expect(model.error).toBeTruthy(); expect(model.result).toBeUndefined(); expect(model.players).toEqual({});
    }
  });

  it("suppresses every private field when the caller reports denied rights", () => {
    const model = adaptArrivalManagerAnswer(base(), { "source:one": "Private credit" }, { denied: true });
    expect(model.result?.feasibility).toBe("no_rights");
    expect(model.players).toEqual({}); expect(model.managers).toEqual({}); expect(model.entries).toEqual({}); expect(model.credits).toEqual({});
    expect(model.result?.assigned).toEqual([]); expect(model.result?.unknown).toEqual([]); expect(model.result?.lineage).toEqual([]);
  });

  it("does not expose labels or identifiers for missing coverage", () => {
    const input = { ...base(), coverage: "missing", population_count: 0, rows: [] };
    const model = adaptArrivalManagerAnswer(input, {});
    expect(model.result?.coverage).toBe("missing");
    expect(model.players).toEqual({});
    expect(model.managers).toEqual({});
    expect(model.result?.assigned).toEqual([]);
    expect(model.result?.unknown).toEqual([]);
  });

  it("rejects missing coverage that carries rows", () => {
    const input = { ...base(), coverage: "missing", rows: [base().rows[0]], population_count: 1 };
    const model = adaptArrivalManagerAnswer(input, {});
    expect(model.error).toBeTruthy();
    expect(model.result).toBeUndefined();
    expect(model.players).toEqual({});
  });

  it.each([
    ["assigned row without manager", { ...base(), rows: [{ ...base().rows[0], manager: null }] }],
    ["unknown row with manager", { ...base(), rows: [{ ...base().rows[1], manager: "Coach One" }] }],
    ["assigned row with null entry", { ...base(), rows: [{ ...base().rows[0], entry_date: null }] }],
    ["population count mismatch", { ...base(), population_count: 3 }],
    ["non-finite count", { ...base(), population_count: Infinity }],
    ["row label containing raw HTML", { ...base(), rows: [{ ...base().rows[0], player: "<img src=x onerror=alert(1)>" }] }],
    ["row label containing ampersand", { ...base(), rows: [{ ...base().rows[0], player: "Alex & Sam" }] }],
    ["row label containing quote", { ...base(), rows: [{ ...base().rows[0], manager: 'Coach "One"' }] }],
    ["row label longer than 80 characters", { ...base(), rows: [{ ...base().rows[0], player: "A".repeat(81) }] }],
  ])("rejects inconsistent or unsafe %s", (_name, input) => {
    const model = adaptArrivalManagerAnswer(input, {});
    expect(model.error).toBeTruthy(); expect(model.result).toBeUndefined(); expect(model.players).toEqual({});
  });

  it("keeps an unknown player's label when manager is unknown", () => {
    const input = { ...base(), rows: [base().rows[1]], population_count: 1 };
    expect(adaptArrivalManagerAnswer(input, {}).players).toEqual({ "answer-row:0": "Unknown Player" });
  });

  it("rejects polluted prototypes, getters, and accessor-backed array entries without invoking getters", () => {
    const polluted = Object.assign(Object.create({ polluted: true }), base());
    let calls = 0;
    const getter = base();
    Object.defineProperty(getter, "as_of", { enumerable: true, get() { calls++; throw new Error("getter called"); } });
    const arrayGetter = base();
    Object.defineProperty(arrayGetter.rows, "0", { enumerable: true, get() { calls++; throw new Error("row getter called"); } });
    for (const input of [polluted, getter, arrayGetter]) {
      const model = adaptArrivalManagerAnswer(input, {});
      expect(model.error).toBeTruthy(); expect(model.players).toEqual({});
    }
    expect(calls).toBe(0);
  });

  it("uses only bounded credits from export lineage and rejects HTML or oversized credits", () => {
    const good = adaptArrivalManagerAnswer(base(), { "source:one": "Trusted source" });
    expect(good.credits).toEqual({ "source:one": "Trusted source" });
    expect(adaptArrivalManagerAnswer(base(), { "source:one": "<b>bad</b>" }).error).toBeTruthy();
    expect(adaptArrivalManagerAnswer(base(), { "source:one": "x".repeat(241) }).error).toBeTruthy();
    const rowOnly = { ...base(), lineage: [], rows: base().rows };
    expect(adaptArrivalManagerAnswer(rowOnly, { "source:one": "Row only" }).credits).toEqual({});
  });

  it("validates expected requests and fails closed on request getters", () => {
    let calls = 0;
    const request = Object.defineProperty({ version: 1, family: "arrival_manager", as_of: "2026-07-02", population: "first_team_available", joining_basis: "effective_first_team_spell_entry", academy_basis: "documented_first_team_promotion", visualization: "table" }, "as_of", { enumerable: true, get() { calls++; throw new Error("request getter"); } });
    const model = adaptArrivalManagerAnswer(base(), {}, { request: request as never });
    expect(model.error).toBeTruthy(); expect(calls).toBe(0);
  });
});
