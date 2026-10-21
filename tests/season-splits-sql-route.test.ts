import { describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";

const sqliteModuleName: string = "node:sqlite";
const { DatabaseSync } = await import(sqliteModuleName) as unknown as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...values: unknown[]): unknown; get(...values: unknown[]): unknown; all(...values: unknown[]): unknown[] };
  };
};

vi.mock("jose", async (original) => ({
  ...await original<typeof import("jose")>(),
  jwtVerify: vi.fn(async () => ({ payload: { sub: "route-user", email: "owner@example.invalid" } })),
}));

import app from "../worker/src/index";
import { Catalog } from "../worker/src/core/feasibility";

const snapshot = "a".repeat(64);
const headers = { "cf-access-jwt-assertion": "synthetic" };

function fakeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE snapshots (snapshot_id TEXT PRIMARY KEY);
    CREATE TABLE publication_runs (
      run_id INTEGER PRIMARY KEY, snapshot_id TEXT NOT NULL, prepared_at TEXT NOT NULL,
      loaded_at TEXT NOT NULL, source_status_json TEXT NOT NULL
    );
    CREATE TABLE budget_counter (day TEXT PRIMARY KEY, count INTEGER NOT NULL);
    CREATE TABLE season_stats (snapshot_id TEXT, season TEXT, competition TEXT, played INTEGER);
    CREATE TABLE season_splits (
      snapshot_id TEXT, season TEXT, competition TEXT, venue TEXT, opponent_id TEXT,
      played INTEGER, won INTEGER, drawn INTEGER, lost INTEGER, goals_for INTEGER,
      goals_against INTEGER, lineage_json TEXT
    );
  `);
  sqlite.prepare("INSERT INTO snapshots VALUES (?)").run(snapshot);
  const sources = Object.fromEntries(["fpl", "football_data_couk", "openfootball_cl"].map((id) => [id,
    { coverage_through: null, retrieved_at: null, status: "unavailable" },
  ]));
  sqlite.prepare("INSERT INTO publication_runs VALUES (1, ?, ?, ?, ?)").run(
    snapshot, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", JSON.stringify(sources),
  );
  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const statement = {
      bind: (...values: unknown[]) => { bound = values; return statement; },
      first: async <T,>() => (sqlite.prepare(sql).get(...bound) ?? null) as T | null,
      all: async <T,>() => ({ results: sqlite.prepare(sql).all(...bound) as T[] }),
      run: async () => sqlite.prepare(sql).run(...bound),
    };
    return statement;
  };
  return { sqlite, db: { prepare } };
}

function envFor(db: ReturnType<typeof fakeD1>["db"]) {
  return {
    DB: db,
    CFG: { get: async () => null, put: async () => undefined },
    ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    ACCESS_AUD: "a".repeat(64),
    ACCESS_OWNER_EMAILS: "owner@example.invalid",
  } as unknown as Env;
}

describe("season split route with real SQLite-backed D1 SQL", () => {
  it("shows reconciliation as complete and an unreconciled season as missing", async () => {
    const store = fakeD1();
    store.sqlite.prepare("INSERT INTO season_stats VALUES (?, ?, 'PL', ?)").run(snapshot, "2023-24", 2);
    store.sqlite.prepare("INSERT INTO season_stats VALUES (?, ?, 'PL', ?)").run(snapshot, "2024-25", 2);
    const addSplit = store.sqlite.prepare(`INSERT INTO season_splits VALUES (?, ?, 'PL', 'home', ?, 1, 1, 0, 0, 2, 0, '["football_data_couk"]')`);
    addSplit.run(snapshot, "2023-24", "club:1");
    addSplit.run(snapshot, "2024-25", "club:2");
    addSplit.run(snapshot, "2024-25", "club:3");
    vi.spyOn(Catalog.prototype, "outputCapability").mockReturnValue("clear");
    const env = envFor(store.db);

    const response = await app.request(
      "https://site.invalid/en/seasons/explore?seasons=2023-24&seasons=2024-25",
      { headers }, env,
    );
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("2023-24: Missing split coverage");
    expect(body).toContain("2024-25: Complete");
  });
});
