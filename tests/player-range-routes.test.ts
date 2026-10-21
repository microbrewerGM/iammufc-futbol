import { describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";

const sqliteModuleName: string = "node:sqlite";
const { DatabaseSync } = await import(sqliteModuleName) as unknown as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...values: unknown[]): unknown;
      get(...values: unknown[]): unknown;
      all(...values: unknown[]): unknown[];
    };
  };
};

vi.mock("jose", async (original) => ({
  ...await original<typeof import("jose")>(),
  jwtVerify: vi.fn(async () => ({ payload: { sub: "range-user", email: "owner@example.invalid" } })),
}));

import app from "../worker/src/index";

const ids: [string, string] = ["fpl:code:101", "fpl:code:202"];
const seasons = ["2024-25"];
const snapshot = "a".repeat(64);
const headers = {
  "cf-access-jwt-assertion": "synthetic",
  Origin: "https://site.invalid",
  "Sec-Fetch-Site": "same-origin",
};
const fixturePlayers = ids.map((person_id, i) => ({
  person_id, player_id: `fpl:${101 + i}:2024-25`, season: "2024-25", label: `Player ${i + 1}`,
}));
const fixtureFacts = [
  { person_id: ids[0], season: "2024-25", competition: "PL" as const, goals: 7, assists: 2, minutes: 900, snapshot_id: snapshot },
  // Stale publication data must not leak into the current comparison.
  { person_id: ids[0], season: "2024-25", competition: "PL" as const, goals: 99, assists: 9, minutes: 9000, snapshot_id: "b".repeat(64) },
];

function fakeD1(options: { failOn?: string; corruptFacts?: boolean } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE budget_counter (day TEXT PRIMARY KEY, count INTEGER NOT NULL);
    CREATE TABLE snapshots (snapshot_id TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE players (player_id TEXT PRIMARY KEY, web_name TEXT NOT NULL);
    CREATE TABLE player_identities (person_id TEXT NOT NULL, player_id TEXT NOT NULL, season TEXT NOT NULL);
    CREATE TABLE player_season_stats (player_id TEXT NOT NULL, season TEXT NOT NULL, competition TEXT NOT NULL, goals INTEGER, assists INTEGER, minutes INTEGER, snapshot_id TEXT NOT NULL);
    CREATE TABLE account_question_history (id INTEGER PRIMARY KEY AUTOINCREMENT, account_sub TEXT, question_text TEXT, visualization_path TEXT, locale TEXT, created_at TEXT);
  `);
  sqlite.prepare("INSERT INTO snapshots VALUES (?, ?)").run(snapshot, "2026-01-01T00:00:00Z");
  for (const player of fixturePlayers) {
    sqlite.prepare("INSERT INTO players VALUES (?, ?)").run(player.player_id, player.label);
    sqlite.prepare("INSERT INTO player_identities VALUES (?, ?, ?)").run(player.person_id, player.player_id, player.season);
  }
  for (const fact of fixtureFacts) {
    sqlite.prepare("INSERT INTO player_season_stats VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(fixturePlayers.find((player) => player.person_id === fact.person_id)!.player_id, fact.season, fact.competition, options.corruptFacts && fact.snapshot_id === snapshot ? -1 : fact.goals, fact.assists, fact.minutes, fact.snapshot_id);
  }
  const history: unknown[][] = [];
  const trace: string[] = [];
  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const statement = {
      bind: (...values: unknown[]) => { bound = values; return statement; },
      first: async <T,>() => {
        trace.push(sql);
        if (options.failOn && sql.includes(options.failOn)) throw new Error("synthetic D1 failure");
        return (sqlite.prepare(sql).get(...bound) ?? null) as T | null;
      },
      all: async <T,>() => {
        trace.push(sql);
        if (options.failOn && sql.includes(options.failOn)) throw new Error("synthetic D1 failure");
        return { results: sqlite.prepare(sql).all(...bound) as T[] };
      },
      run: async () => {
        trace.push(sql);
        if (options.failOn && sql.includes(options.failOn)) throw new Error("synthetic D1 failure");
        return sqlite.prepare(sql).run(...bound);
      },
    };
    return Object.assign(statement, { sql, values: () => bound });
  };
  return {
    history,
    trace,
    db: {
      prepare,
      batch: async (statements: Array<{ sql: string; values: () => unknown[] }>) => {
        sqlite.exec("BEGIN");
        try {
          for (const item of statements) {
            trace.push(item.sql);
            if (options.failOn && item.sql.includes(options.failOn)) throw new Error("synthetic D1 failure");
            sqlite.prepare(item.sql).run(...item.values());
            if (item.sql.startsWith("INSERT INTO account_question_history")) history.push(item.values());
          }
          sqlite.exec("COMMIT");
          return [];
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      },
    },
  };
}

const url = (locale = "en", selectedIds: string[] = ids, selectedSeasons: string[] = seasons) => {
  const params = new URLSearchParams({ schema_version: "1", competition: "PL", metric: "goals", normalization: "total", min_minutes: "0", viz: "table" });
  selectedIds.forEach((id) => params.append("person_ids", id));
  selectedSeasons.forEach((season) => params.append("seasons", season));
  return `https://site.invalid/${locale}/players/compare?${params}`;
};

const envFor = (db: ReturnType<typeof fakeD1>["db"]) => ({
  DB: db,
  CFG: { get: async () => null, put: async () => {} },
  ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64),
  ACCESS_OWNER_EMAILS: "owner@example.invalid",
}) as unknown as Env;

describe("bounded player range routes", () => {
  it("requires Access before any D1 read", async () => {
    const store = fakeD1();
    const response = await app.request(url(), {}, envFor(store.db));
    expect(response.status).toBe(403);
  });

  it.each(["en", "es"]) ("rejects cross-site comparison requests in %s", async (locale) => {
    const store = fakeD1();
    const response = await app.request(url(locale), {
      headers: { ...headers, Origin: "https://foreign.invalid", "Sec-Fetch-Site": "cross-site" },
    }, envFor(store.db));
    expect(response.status).toBe(403);
    expect(store.trace).toEqual([]);
  });

  it.each(["en", "es"])("round-trips the full canonical selection in %s", async (locale) => {
    const store = fakeD1();
    const response = await app.request(url(locale), { headers }, envFor(store.db));
    const body = await response.text();
    const canonicalPath = `/players/compare?schema_version=1&competition=PL&person_ids=fpl%3Acode%3A101&person_ids=fpl%3Acode%3A202&seasons=2024-25&metric=goals&normalization=total&min_minutes=0&viz=table`;
    const htmlCanonicalPath = canonicalPath.replaceAll("&", "&amp;");
    expect(response.status).toBe(200);
    expect(body).toContain(`action="/${locale}/players/compare"`);
    expect(body).toContain(locale === "es" ? "Comparar jugadores" : "Compare players");
    expect(body).toContain("Player 1");
    expect(body).toContain(`href="/${locale === "en" ? "es" : "en"}${htmlCanonicalPath}"`);
    expect(body).toContain(`<link rel="canonical" href="/${locale}${htmlCanonicalPath}">`);
    expect(body).toContain(`href="/${locale}/players/compare"`);
    expect(body).toContain("7");
    expect(body).not.toContain("99");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(store.history).toHaveLength(1);
    expect(store.history[0]?.[2]).toContain("/players/compare?schema_version=1");
  });

  it("rejects invalid identity, season and scalar selections", async () => {
    const invalidIds = [...ids, "fpl:code:999"];
    const store = fakeD1();
    const response = await app.request(url("en", invalidIds), { headers }, envFor(store.db));
    expect(response.status).toBe(400);
    const badSeason = await app.request(url("en", ids, ["1900-01"]), { headers }, envFor(store.db));
    expect(badSeason.status).toBe(400);
    const duplicateScalar = await app.request(`${url()}&metric=assists`, { headers }, envFor(store.db));
    expect(duplicateScalar.status).toBe(400);
  });

  it("enforces exact person and season bounds", async () => {
    const store = fakeD1();
    const six = Array.from({ length: 6 }, (_, i) => `fpl:code:${100 + i}`);
    const sixResponse = await app.request(url("en", six), { headers }, envFor(store.db));
    expect(sixResponse.status).toBe(400);
    const nine = Array.from({ length: 9 }, (_, i) => `${2016 + i}-${String((17 + i) % 100).padStart(2, "0")}`);
    const nineResponse = await app.request(url("en", ids, nine), { headers }, envFor(store.db));
    expect(nineResponse.status).toBe(400);
    expect(store.history).toHaveLength(0);
  });

  it("renders a valid identity with no rows in the selected window as absent", async () => {
    const store = fakeD1();
    const response = await app.request(url(), { headers }, envFor(store.db));
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("Player 2");
    expect(body).toContain("Missing row");
  });

  it("returns 5xx on D1 failures and does not save history", async () => {
    const store = fakeD1({ failOn: "FROM player_season_stats" });
    const response = await app.request(url(), { headers }, envFor(store.db));
    expect(response.status).toBe(503);
    expect(store.history).toHaveLength(0);
  });

  it.each(["INSERT INTO budget_counter", "SELECT count FROM budget_counter"])("fails closed on budget D1 failure (%s) before identity, facts, or history in both locales", async (sql) => {
    for (const locale of ["en", "es"]) {
      const store = fakeD1({ failOn: sql });
      const response = await app.request(url(locale), { headers }, envFor(store.db));
      const body = await response.text();
      expect(response.status).toBe(503);
      expect(body).toContain(locale === "es" ? "La comparación no está disponible." : "Comparison unavailable.");
      expect(store.history).toHaveLength(0);
    }
  });

  it("validates input before D1 and enforces budget before snapshot and every later read", async () => {
    const invalid = fakeD1();
    const invalidResponse = await app.request(`${url()}&metric=assists`, { headers }, envFor(invalid.db));
    expect(invalidResponse.status).toBe(400);
    expect(invalid.trace).toEqual([]);

    const valid = fakeD1();
    const response = await app.request(url(), { headers }, envFor(valid.db));
    expect(response.status).toBe(200);
    const budgetWrite = valid.trace.findIndex((sql) => sql.includes("INSERT INTO budget_counter"));
    const snapshotRead = valid.trace.findIndex((sql) => sql.includes("FROM snapshots"));
    expect(budgetWrite).toBeGreaterThanOrEqual(0);
    expect(snapshotRead).toBeGreaterThan(budgetWrite);
    expect(valid.trace.slice(0, budgetWrite).every((sql) => !sql.trimStart().toUpperCase().startsWith("SELECT"))).toBe(true);
  });

  it.each(["en", "es"])("rejects oversized raw query and excess repeated parameters before budget in %s", async (locale) => {
    const oversized = fakeD1();
    const huge = await app.request(`https://site.invalid/${locale}/players/compare?${"x".repeat(2050)}`, { headers }, envFor(oversized.db));
    expect(huge.status).toBe(400);
    expect(oversized.history).toHaveLength(0);

    const repeatedPeople = fakeD1();
    const tooManyPeople = await app.request(url(locale, Array(6).fill(ids[0])), { headers }, envFor(repeatedPeople.db));
    expect(tooManyPeople.status).toBe(400);
    expect(repeatedPeople.history).toHaveLength(0);

    const repeatedSeasons = fakeD1();
    const tooManySeasons = await app.request(url(locale, ids, Array(9).fill(seasons[0])), { headers }, envFor(repeatedSeasons.db));
    expect(tooManySeasons.status).toBe(400);
    expect(repeatedSeasons.history).toHaveLength(0);
  });

  it("returns 5xx when returned facts fail integrity validation", async () => {
    const store = fakeD1({ corruptFacts: true });
    const response = await app.request(url(), { headers }, envFor(store.db));
    expect(response.status).toBe(503);
    expect(store.history).toHaveLength(0);
  });
});
