import { describe, expect, it, vi } from "vitest";
import { currentPublication, type Env } from "../worker/src/core/db";

const snapshot = "a".repeat(64);
const observed = (season = "2025-26") => ({
  status: "observed",
  coverage_through: season,
  retrieved_at: "2026-09-23T12:00:00+00:00",
});
const validSources = {
  fpl: observed(),
  football_data_couk: observed(),
  openfootball_cl: { status: "unavailable", coverage_through: null, retrieved_at: null },
};

function environment(row: unknown, failure = false): Env {
  const first = failure ? vi.fn(async () => { throw new Error("private"); }) : vi.fn(async () => row);
  return {
    DB: { prepare: vi.fn(() => ({ first })) },
  } as unknown as Env;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    snapshot_id: snapshot,
    prepared_at: "2026-09-23T12:00:00+00:00",
    loaded_at: "2026-09-23T12:00:01.000Z",
    source_status_json: JSON.stringify(validSources),
    ...overrides,
  };
}

describe("publication-state parser", () => {
  it("returns only normalized allowlisted metadata in stable source order", async () => {
    await expect(currentPublication(environment(row()))).resolves.toEqual({
      snapshotId: snapshot,
      preparedAt: "2026-09-23T12:00:00.000Z",
      loadedAt: "2026-09-23T12:00:01.000Z",
      sources: [
        { id: "fpl", status: "observed", coverageThrough: "2025-26", retrievedAt: "2026-09-23T12:00:00.000Z", sourceAsOf: null },
        { id: "football_data_couk", status: "observed", coverageThrough: "2025-26", retrievedAt: "2026-09-23T12:00:00.000Z", sourceAsOf: null },
        { id: "openfootball_cl", status: "unavailable", coverageThrough: null, retrievedAt: null, sourceAsOf: null },
      ],
    });
  });

  it.each([
    null,
    row({ snapshot_id: "invalid" }),
    row({ prepared_at: "not-a-date" }),
    row({ prepared_at: "2026-09-23T13:00:00.000Z", loaded_at: "2026-09-23T12:00:00.000Z" }),
    row({ source_status_json: "{" }),
    row({ source_status_json: JSON.stringify({ ...validSources, extra: observed() }) }),
    row({ source_status_json: JSON.stringify({ fpl: observed(), football_data_couk: observed() }) }),
    row({ source_status_json: JSON.stringify({ ...validSources, fpl: { ...observed(), extra: true } }) }),
    row({ source_status_json: JSON.stringify({ ...validSources, fpl: { ...observed(), status: "withheld" } }) }),
    row({ source_status_json: JSON.stringify({ ...validSources, fpl: { ...observed(), coverage_through: null } }) }),
    row({ source_status_json: JSON.stringify({ ...validSources, openfootball_cl: { ...observed(), status: "unavailable" } }) }),
    ...["invalid", 123, {}].map((retrieved_at) =>
      row({
        source_status_json: JSON.stringify({
          ...validSources,
          openfootball_cl: { status: "unavailable", coverage_through: null, retrieved_at },
        }),
      }),
    ),
  ])("returns null for malformed metadata %#", async (invalid) => {
    await expect(currentPublication(environment(invalid))).resolves.toBeNull();
  });

  it("contains database failures and never returns their message", async () => {
    await expect(currentPublication(environment(null, true))).resolves.toBeNull();
  });
});
