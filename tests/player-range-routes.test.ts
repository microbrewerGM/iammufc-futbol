import { describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";

vi.mock("jose", async (original) => ({
  ...await original<typeof import("jose")>(),
  jwtVerify: vi.fn(async () => ({ payload: { sub: "range-user", email: "owner@example.invalid" } })),
}));

import app from "../worker/src/index";

const ids: [string, string] = ["fpl:code:101", "fpl:code:202"];
const seasons = ["2024-25"];
const snapshot = "a".repeat(64);
const headers = { "cf-access-jwt-assertion": "synthetic" };
const fixturePlayers = ids.map((person_id, i) => ({
  person_id, player_id: `fpl:${101 + i}:2024-25`, season: "2024-25", label: `Player ${i + 1}`,
}));
const fixtureFacts = [
  { person_id: ids[0], season: "2024-25", competition: "PL" as const, goals: 7, assists: 2, minutes: 900, snapshot_id: snapshot },
  // Stale publication data must not leak into the current comparison.
  { person_id: ids[0], season: "2024-25", competition: "PL" as const, goals: 99, assists: 9, minutes: 9000, snapshot_id: "b".repeat(64) },
];

function fakeD1(options: { failOn?: string; corruptFacts?: boolean } = {}) {
  const history: unknown[][] = [];
  let budgetCount = 0;
  const prepare = (sql: string) => {
    if (options.failOn && sql.includes(options.failOn)) throw new Error("synthetic D1 failure");
    let bound: unknown[] = [];
    const statement = {
      bind: (...values: unknown[]) => { bound = values; return statement; },
      first: async <T,>() => {
        if (sql.includes("FROM snapshots")) return { snapshot_id: snapshot } as T;
        if (sql.includes("SELECT count FROM budget_counter")) return { count: budgetCount } as T;
        return null;
      },
      all: async <T,>() => {
        if (sql.includes("SELECT DISTINCT i.person_id")) {
          const people = new Set<string>(bound as string[]);
          return { results: fixturePlayers.filter((p) => people.has(p.person_id)).map((p) => ({ person_id: p.person_id })) as T[] };
        }
        if (sql.includes("SELECT i.person_id, p.web_name AS label")) {
          const people = new Set<string>(bound as string[]);
          return { results: fixturePlayers.filter((p) => people.has(p.person_id)).map((p) => ({ person_id: p.person_id, label: p.label })) as T[] };
        }
        if (sql.includes("FROM player_season_stats")) {
          const people = new Set<string>(bound.slice(0, 2) as string[]);
          const requestedSeasons = new Set<string>(bound.slice(2, -1) as string[]);
          const selectedSnapshot = bound.at(-1) as string;
          const facts = fixtureFacts.filter((row) => people.has(row.person_id) && requestedSeasons.has(row.season) && row.snapshot_id === selectedSnapshot);
          if (options.corruptFacts && facts[0]) facts[0] = { ...facts[0], goals: -1 };
          return { results: facts as T[] };
        }
        throw new Error(`Unexpected fake D1 query: ${sql}`);
      },
      run: async () => {
        if (sql.includes("INSERT INTO budget_counter")) budgetCount += 1;
        return { success: true };
      },
      query: sql,
      values: () => bound,
    };
    return statement;
  };
  return {
    history,
    db: {
      prepare,
      batch: async (statements: Array<{ [key: string]: unknown }>) => {
        const insert = statements[0] as unknown as { query: string; values: () => unknown[] };
        if (insert.query?.includes("INSERT INTO account_question_history")) history.push(insert.values());
        return [];
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

  it("returns 5xx when returned facts fail integrity validation", async () => {
    const store = fakeD1({ corruptFacts: true });
    const response = await app.request(url(), { headers }, envFor(store.db));
    expect(response.status).toBe(503);
    expect(store.history).toHaveLength(0);
  });
});
