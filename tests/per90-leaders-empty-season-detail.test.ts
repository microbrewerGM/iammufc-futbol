import { describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";
import { LOCALES } from "../worker/src/core/locale";
import type { Per90LeadersResult } from "../worker/src/core/player-trends";
import { playerTrendsBody } from "../worker/src/views/player-trends";

const sqliteModuleName: string = "node:sqlite";
const { DatabaseSync } = await import(sqliteModuleName) as unknown as { DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { run(...values: unknown[]): unknown; get(...values: unknown[]): unknown; all(...values: unknown[]): unknown[] } } };
vi.mock("jose", async original => ({ ...await original<typeof import("jose")>(), jwtVerify: vi.fn(async () => ({ payload: { sub: "trend-user", email: "owner@example.invalid" } })) }));
import app from "../worker/src/index";

const snapshot = "a".repeat(64);
const headers = { "cf-access-jwt-assertion": "synthetic", Origin: "https://site.invalid", "Sec-Fetch-Site": "same-origin" };
const allSeasons = "schema_version=1&competition=PL&person_ids=fpl%3Acode%3A1&person_ids=fpl%3Acode%3A2&person_ids=fpl%3Acode%3A3&start_season=2023-24&end_season=2024-25&metric=goals&normalization=per90&viz=table";

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE snapshots(snapshot_id TEXT, created_at TEXT); CREATE TABLE publication_runs(run_id INTEGER PRIMARY KEY, snapshot_id TEXT, prepared_at TEXT, source_status_json TEXT, loaded_at TEXT);
    CREATE TABLE budget_counter(day TEXT PRIMARY KEY, count INTEGER); CREATE TABLE players(player_id TEXT, web_name TEXT);
    CREATE TABLE player_identities(person_id TEXT, player_id TEXT, season TEXT); CREATE TABLE player_season_stats(player_id TEXT, season TEXT, competition TEXT, goals INTEGER, assists INTEGER, minutes INTEGER, snapshot_id TEXT);
    INSERT INTO snapshots VALUES ('${snapshot}', '2026-01-01'); INSERT INTO publication_runs VALUES (1, '${snapshot}', '', '', '');
    INSERT INTO players VALUES ('p1','Alex'),('p2','Blair'),('p3','Casey');
    INSERT INTO player_identities VALUES ('fpl:code:1','p1','2023-24'),('fpl:code:2','p2','2023-24'),('fpl:code:3','p3','2023-24');
    INSERT INTO player_season_stats VALUES ('p1','2023-24','PL',2,0,900,'${snapshot}'),('p2','2023-24','PL',3,0,1350,'${snapshot}'),('p3','2023-24','PL',1,0,900,'${snapshot}');`);
  const db = { prepare(sql: string) { let bound: unknown[] = []; const stmt = { bind(...values: unknown[]) { bound = values; return stmt; }, first: async <T,>() => (sqlite.prepare(sql).get(...bound) ?? null) as T | null, all: async <T,>() => ({ results: sqlite.prepare(sql).all(...bound) as T[] }), run: async () => sqlite.prepare(sql).run(...bound) }; return stmt; } };
  return { env: { DB: db, CFG: { get: async () => null, put: async () => undefined }, ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64), ACCESS_OWNER_EMAILS: "owner@example.invalid" } as unknown as Env };
}

function url(locale: string, query: string) { return `https://site.invalid/${locale}/players/trends?${query}`; }

function render(locale: "en" | "es", selectedSeason = "2024-25") {
  const leaders: Per90LeadersResult = { snapshot_id: "empty-season-fixture", season: selectedSeason, metric: "goals", min_minutes: 900, leaders: [], excluded: [] };
  return playerTrendsBody({ request: { schema_version: 1, competition: "PL", person_ids: ["fpl:code:1"], seasons: [selectedSeason], metric: "goals", normalization: "per90", min_minutes: 900, viz: "table" }, snapshot_id: leaders.snapshot_id, definition: "goals", series: [], leaders, people: [{ person_id: "fpl:code:1", label: "Player One" }], credits: {} }, {}, LOCALES[locale]);
}

describe("empty per-90 leaderboard season detail", () => {
  it.each([
    ["en", "No comparable players are available for 2024-25."],
    ["es", "No hay jugadores comparables disponibles para 2024-25."],
  ] as const)("names the selected season in %s", (locale, message) => {
    const html = render(locale);
    expect(html).toContain(`<p role="status">${message}</p>`);
    expect(html).toContain(`<h2>${locale === "en" ? "Per-90 leaderboard" : "Clasificación por 90 minutos"} · 2024-25</h2>`);
    expect(html).not.toContain("<tbody><tr>");
    expect(html).not.toContain("<td>0</td>");
  });

  it.each([
    ["en", "No comparable players are available for 2024-25."],
    ["es", "No hay jugadores comparables disponibles para 2024-25."],
  ] as const)("renders the empty selected season and retains it in the form in %s", async (locale, message) => {
    const { env } = fixture();
    const response = await app.request(url(locale, allSeasons), { headers }, env);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(`<p role="status">${message}</p>`);
    expect(html).toMatch(/<select name="end_season">[\s\S]*?<option value="2024-25" selected>2024-25<\/option>[\s\S]*?<\/select>/);
  });

  it("escapes a crafted season in the status message", () => {
    const html = render("en", "2024<script>-25");
    expect(html).toContain("No comparable players are available for 2024&lt;script&gt;-25.");
    expect(html).not.toContain("<script>-25");
  });
});
