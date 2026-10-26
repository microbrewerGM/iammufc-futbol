import { describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";

vi.mock("jose", async (original) => ({
  ...await original<typeof import("jose")>(),
  jwtVerify: vi.fn(async () => ({ payload: { sub: "owner", email: "owner@example.invalid" } })),
}));
vi.mock("../worker/src/core/db", async (original) => ({
  ...await original<typeof import("../worker/src/core/db")>(),
  currentPublication: vi.fn(async () => ({ snapshotId: "a".repeat(64), preparedAt: "2026-10-23T00:00:00.000Z", loadedAt: "2026-10-23T00:00:00.000Z", sources: [{ id: "openfootball_cl", status: "observed" }] })),
}));

import app from "../worker/src/index";

const SNAPSHOT = "a".repeat(64);
const LATEST_SQL = /FROM snapshots ORDER BY created_at DESC LIMIT 1/;

function fakeEnv() {
  const prepared: string[] = [];
  const DB = { prepare(sql: string) {
    prepared.push(sql);
    let bindings: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) { bindings = values; return statement; },
      async first() { return { snapshot_id: SNAPSHOT, sources_json: JSON.stringify({ "openfootball:CL:2025-26": "b".repeat(64) }) }; },
      async all() {
        const seasons = bindings.slice(1) as string[];
        return { results: seasons.slice(0, 1).map((season) => ({
          season, played: 6, won: 3, drawn: 2, lost: 1, goals: 9, goals_against: 5, snapshot_id: SNAPSHOT,
        })) };
      },
      async run() { return { success: true }; },
    };
    return statement;
  } };
  const env = { DB, ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64), ACCESS_OWNER_EMAILS: "owner@example.invalid" } as unknown as Env;
  return { env, prepared };
}
const headers = { "cf-access-jwt-assertion": "synthetic" };

describe("latest snapshot reads", () => {
  it("reads the latest snapshot exactly once per CL history request", async () => {
    const { env, prepared } = fakeEnv();
    const response = await app.request("https://site.invalid/en/seasons/champions-league", { headers }, env);
    expect(response.status).toBe(200);
    expect(prepared.filter((sql) => LATEST_SQL.test(sql))).toHaveLength(1);
  });

  it("renders the same output as before the change", async () => {
    const { env } = fakeEnv();
    const body = await (await app.request("https://site.invalid/en/seasons/champions-league", { headers }, env)).text();
    expect(body).toContain(">9</td>");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    expect([...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")).toBe("a5d47e35792366f9c25d8b970363abb3cf1442f654f33fcf665690ee4138c26c");
  });
});
