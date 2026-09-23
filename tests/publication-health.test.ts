import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, PublicationState } from "../worker/src/core/db";

vi.mock("jose", async (original) => ({
  ...await original<typeof import("jose")>(),
  jwtVerify: vi.fn(async () => ({ payload: { sub: "owner", email: "owner@example.invalid" } })),
}));

vi.mock("../worker/src/core/db", async (original) => ({
  ...await original<typeof import("../worker/src/core/db")>(),
  currentSnapshot: vi.fn(),
  currentPublication: vi.fn(),
}));

import app from "../worker/src/index";
import { currentPublication, currentSnapshot } from "../worker/src/core/db";

const snapshot = "a".repeat(64);
const env = {
  ACCESS_ISSUER: "https://example.cloudflareaccess.com",
  ACCESS_AUD: "a".repeat(64),
  ACCESS_OWNER_EMAILS: "owner@example.invalid",
} as Env;
const auth = { "cf-access-jwt-assertion": "synthetic" };
const publication: PublicationState = {
  snapshotId: snapshot,
  preparedAt: "2026-09-23T12:00:00.000Z",
  loadedAt: "2026-09-23T12:00:01.000Z",
  sources: [
    { id: "fpl", status: "observed", coverageThrough: "2025-26", retrievedAt: "2026-09-23T12:00:00.000Z", sourceAsOf: null },
    { id: "football_data_couk", status: "observed", coverageThrough: "2025-26", retrievedAt: "2026-09-23T12:00:00.000Z", sourceAsOf: null },
    { id: "openfootball_cl", status: "observed", coverageThrough: "2023-24", retrievedAt: "2026-09-23T12:00:00.000Z", sourceAsOf: null },
  ],
};

beforeEach(() => {
  vi.mocked(currentSnapshot).mockResolvedValue(snapshot);
  vi.mocked(currentPublication).mockResolvedValue(publication);
});

async function health() {
  return app.request("https://site.invalid/api/health", { headers: auth }, env);
}

describe("curated publication health", () => {
  it("returns an exact allowlisted current response", async () => {
    const response = await health();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual([
      "ai_bound", "coverage_cells", "coverage_through", "data_state", "last_successful_refresh_at",
      "metrics", "ok", "snapshot_id", "snapshot_prepared_at", "sources",
    ].sort());
    expect(body).toMatchObject({ ok: true, data_state: "current", snapshot_id: snapshot, coverage_through: "2025-26" });
    expect(JSON.stringify(body)).not.toMatch(/source_status_json|row_counts|sources_json|private/);
  });

  it("keeps optional-source unavailability usable and explicit", async () => {
    vi.mocked(currentPublication).mockResolvedValue({
      ...publication,
      sources: publication.sources.map((source) =>
        source.id === "openfootball_cl"
          ? { ...source, status: "unavailable", coverageThrough: null, retrievedAt: null }
          : source,
      ),
    });
    const body = await (await health()).json<{ ok: boolean; data_state: string; sources: Array<{ id: string; status: string }> }>();
    expect(body.ok).toBe(true);
    expect(body.data_state).toBe("degraded");
    expect(body.sources.find((source) => source.id === "openfootball_cl")?.status).toBe("unavailable");
  });

  it.each([
    [null, null, "unavailable"],
    [snapshot, null, "inconsistent"],
    [snapshot, { ...publication, snapshotId: "b".repeat(64) }, "inconsistent"],
    ["invalid", publication, "inconsistent"],
  ] as const)("sanitizes unusable state %#", async (current, state, expected) => {
    vi.mocked(currentSnapshot).mockResolvedValue(current);
    vi.mocked(currentPublication).mockResolvedValue(state);
    const body = await (await health()).json<Record<string, unknown>>();
    expect(body).toMatchObject({ ok: false, data_state: expected, sources: [] });
    expect(body.snapshot_prepared_at).toBeNull();
    expect(body.last_successful_refresh_at).toBeNull();
    if (current === "invalid") expect(body.snapshot_id).toBeNull();
  });

  it.each([
    ["en", "Data freshness", "Last successful load:"],
    ["es", "Actualización de los datos", "Última carga correcta:"],
  ])("renders localized freshness on /%s", async (locale, heading, loadLabel) => {
    const response = await app.request(`https://site.invalid/${locale}`, { headers: auth }, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const markup = await response.text();
    expect(markup).toContain(heading);
    expect(markup).toContain(loadLabel);
    expect(markup).toContain("2026-09-23T12:00:01.000Z");
  });

  it("renders an explicit warning without dates when publication metadata mismatches", async () => {
    vi.mocked(currentPublication).mockResolvedValue({ ...publication, snapshotId: "b".repeat(64) });
    const response = await app.request("https://site.invalid/en", { headers: auth }, env);
    const markup = await response.text();
    expect(markup).toContain("Freshness metadata does not match");
    expect(markup).not.toContain("2026-09-23T12:00:01.000Z");
  });
});
