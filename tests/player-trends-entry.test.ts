import { describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";
const sqliteModuleName: string = "node:sqlite";
const { DatabaseSync } = await import(sqliteModuleName) as unknown as { DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { run(...values: unknown[]): unknown; get(...values: unknown[]): unknown; all(...values: unknown[]): unknown[] } } };
vi.mock("jose", async original => ({ ...await original<typeof import("jose")>(), jwtVerify: vi.fn(async () => ({ payload: { sub: "trend-user", email: "owner@example.invalid" } })) }));
import app from "../worker/src/index";

const snapshot = "a".repeat(64);
const headers = { "cf-access-jwt-assertion": "synthetic", Origin: "https://site.invalid", "Sec-Fetch-Site": "same-origin" };
function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE snapshots(snapshot_id TEXT, created_at TEXT); CREATE TABLE publication_runs(run_id INTEGER PRIMARY KEY, snapshot_id TEXT, prepared_at TEXT, source_status_json TEXT, loaded_at TEXT);
    CREATE TABLE budget_counter(day TEXT PRIMARY KEY, count INTEGER); CREATE TABLE players(player_id TEXT, web_name TEXT);
    CREATE TABLE player_identities(person_id TEXT, player_id TEXT, season TEXT); CREATE TABLE player_season_stats(player_id TEXT, season TEXT, competition TEXT, goals INTEGER, assists INTEGER, minutes INTEGER, snapshot_id TEXT);`);
  sqlite.prepare("INSERT INTO snapshots VALUES (?, '2026-01-01')").run(snapshot);
  sqlite.prepare("INSERT INTO publication_runs VALUES (1, ?, '', '', '')").run(snapshot);
  for (const id of [1, 2, 3]) {
    sqlite.prepare("INSERT INTO players VALUES (?, ?)").run(`p${id}`, `Player ${id}`);
    sqlite.prepare("INSERT INTO player_identities VALUES (?, ?, '2023-24')").run(`fpl:code:${id}`, `p${id}`);
    sqlite.prepare("INSERT INTO player_season_stats VALUES (?, '2023-24', 'PL', 2, 1, 900, ?)").run(`p${id}`, snapshot);
  }
  const db = { prepare(sql: string) { let bound: unknown[] = []; const stmt = { bind(...values: unknown[]) { bound = values; return stmt; }, first: async <T,>() => (sqlite.prepare(sql).get(...bound) ?? null) as T | null, all: async <T,>() => ({ results: sqlite.prepare(sql).all(...bound) as T[] }), run: async () => sqlite.prepare(sql).run(...bound) }; return stmt; } };
  return { env: { DB: db, CFG: { get: async () => null, put: async () => undefined }, ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64), ACCESS_OWNER_EMAILS: "owner@example.invalid" } as unknown as Env };
}

describe("player trends entry form", () => {
  it.each(["en", "es"])("renders the localized entry form and accepts a browser-style submission in %s", async locale => {
    const { env } = fixture();
    const response = await app.request(`https://site.invalid/${locale}/players/trends`, { headers }, env);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain(locale === "en" ? "Choose at least two players" : "Elige al menos dos jugadores");
    expect(body).not.toContain("<table");
    expect(body.match(/name="person_ids"/g)).toHaveLength(5);
    expect(body.match(/<option value="" selected disabled>/g)).toHaveLength(5);
    expect(body).toContain('<option value="goals" selected>');
    expect(body).toContain('<option value="total" selected>');
    expect(body).toContain('<option value="2025-26" selected>2025-26</option>');
    expect(body).toContain(`href="/${locale}/compare"`);
    for (const id of ["trend-player-1", "trend-player-2", "trend-player-3", "trend-player-4", "trend-player-5", "trend-metric", "trend-normalization", "trend-start-season", "trend-end-season"]) expect(body).toContain(`<label for="${id}">`);

    const query = new URLSearchParams("schema_version=1&competition=PL&metric=goals&normalization=total&start_season=2025-26&end_season=2025-26");
    query.append("person_ids", "fpl:code:1"); query.append("person_ids", "fpl:code:2");
    const submitted = await app.request(`https://site.invalid/${locale}/players/trends?${query}`, { headers }, env);
    expect(submitted.status).toBe(200);
    expect(await submitted.text()).toContain("Player 1");
  });

  it("keeps invalid nonempty trend queries at 400", async () => {
    const { env } = fixture();
    const response = await app.request("https://site.invalid/en/players/trends?metric=invalid", { headers }, env);
    expect(response.status).toBe(400);
  });
});
