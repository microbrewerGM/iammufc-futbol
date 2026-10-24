import { describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";
import { LOCALES } from "../worker/src/core/locale";
import { calculatePlayerTrends, parsePlayerTrendsRequest } from "../worker/src/core/player-trends";
import { playerTrendsBody } from "../worker/src/views/player-trends";
import { page } from "../worker/src/views/layout";

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
  sqlite.prepare("INSERT INTO players VALUES ('p1', 'Alex')").run();
  sqlite.prepare("INSERT INTO player_identities VALUES ('fpl:code:1', 'p1', '2023-24')").run();
  sqlite.prepare("INSERT INTO player_season_stats VALUES ('p1', '2023-24', 'PL', 2, 1, 900, ?)").run(snapshot);
  const db = { prepare(sql: string) { let bound: unknown[] = []; const stmt = { bind(...values: unknown[]) { bound = values; return stmt; }, first: async <T,>() => (sqlite.prepare(sql).get(...bound) ?? null) as T | null, all: async <T,>() => ({ results: sqlite.prepare(sql).all(...bound) as T[] }), run: async () => sqlite.prepare(sql).run(...bound) }; return stmt; } };
  return { sqlite, env: { DB: db, CFG: { get: async () => null, put: async () => undefined }, ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64), ACCESS_OWNER_EMAILS: "owner@example.invalid" } as unknown as Env };
}

function url(locale: string, query: string) { return `https://site.invalid/${locale}/players/trends?${query}`; }
const basic = "schema_version=1&competition=PL&person_ids=fpl%3Acode%3A1&seasons=2023-24&seasons=2024-25&metric=goals&normalization=total&min_minutes=0&viz=line";

describe("player trend routes", () => {
  it.each(["en", "es"])("renders the trend, gap marker, lineage attribution, canonical hreflang and nav in %s", async locale => {
    const { env } = fixture();
    const response = await app.request(url(locale, basic), { headers }, env);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("Alex");
    expect(body).toContain(locale === "es" ? "Datos no disponibles" : "Data unavailable");
    expect(body).toContain("href=\"/en/players/trends?");
    expect(body).toContain("href=\"/es/players/trends?");
    expect(body).toContain(`<a href="/${locale}/players/trends">`);
    expect(body).toContain(locale === "es" ? "Datos de jugadores derivados" : "Fantasy Premier League public API");
  });

  it.each(["en", "es"])("returns localized 400 for reversed and over-bound ranges in %s", async locale => {
    const { env } = fixture();
    const reversed = await app.request(url(locale, basic.replace("seasons=2023-24", "start_season=2024-25&end_season=2023-24")), { headers }, env);
    expect(reversed.status).toBe(400);
    const reversedBody = await reversed.text();
    expect(reversedBody).toContain(locale === "es" ? "no válida" : "Invalid");
    expect(reversedBody).toContain("<!doctype html>");
    const missingStart = await app.request(url(locale, basic.replace("seasons=2023-24&seasons=2024-25", "start_season=1900-01&end_season=2024-25")), { headers }, env);
    expect(missingStart.status).toBe(400);
    expect(await missingStart.text()).toContain("<!doctype html>");
    const missingEnd = await app.request(url(locale, basic.replace("seasons=2023-24&seasons=2024-25", "start_season=2023-24&end_season=1900-01")), { headers }, env);
    expect(missingEnd.status).toBe(400);
    expect(await missingEnd.text()).toContain("<!doctype html>");
    const over = await app.request(url(locale, basic + "&seasons=2024-25&seasons=2025-26&seasons=2026-27&seasons=2027-28&seasons=2028-29&seasons=2029-30&seasons=2030-31&seasons=2031-32"), { headers }, env);
    expect(over.status).toBe(400);
  });

  it.each(["en", "es"])("returns localized 404 for an unknown player in %s", async locale => {
    const { env } = fixture();
    const response = await app.request(url(locale, basic.replace("code%3A1", "code%3A99")), { headers }, env);
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toContain(locale === "es" ? "No se encontró" : "not found");
    expect(body).toContain("<!doctype html>");
    expect(body).toContain(locale === "es" ? "No encontrado" : "Not found");
  });

  it.each(["en", "es"])("returns a localized full unavailable page in %s", async locale => {
    const { env } = fixture();
    (env.CFG as unknown as { get: () => Promise<string | null> }).get = async () => "999999";
    const response = await app.request(url(locale, basic), { headers }, env);
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain("<!doctype html>");
    expect(body).toContain(locale === "es" ? "no está disponible" : "unavailable");
  });

  it.each(["en", "es"])("returns localized 404 when a requested person has no display label in %s", async locale => {
    const { env, sqlite } = fixture();
    sqlite.exec("DELETE FROM players");
    const response = await app.request(url(locale, basic), { headers }, env);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain(locale === "es" ? "No encontrado" : "Not found");
  });

  it("canonicalizes query order identically across locale paths", async () => {
    const { env } = fixture();
    const en = await (await app.request(url("en", basic), { headers }, env)).text();
    const es = await (await app.request(url("es", basic), { headers }, env)).text();
    const canonical = /<link rel="canonical" href="([^"]+)"/.exec(en)?.[1];
    expect(canonical!.replace(/&amp;/g, "&")).toContain("schema_version=1&competition=PL&person_ids=fpl%3Acode%3A1&seasons=2023-24&seasons=2024-25&metric=goals&normalization=total&min_minutes=0&viz=line");
    expect(es).toContain(canonical!.replace("/en/", "/es/"));
  });

  it("renders missing cells as dashes and resolves credits only through lineage", () => {
    const metadata = { snapshot_id: "s", person_ids: ["fpl:code:1"], seasons: ["2023-24", "2024-25"] };
    const request = parsePlayerTrendsRequest({ schema_version: 1, competition: "PL", person_ids: metadata.person_ids, seasons: metadata.seasons, metric: "goals", normalization: "total", min_minutes: 0, viz: "table" }, metadata);
    const result = calculatePlayerTrends(request, metadata, [{ person_id: "fpl:code:1", season: "2023-24", competition: "PL", metric: "goals", definition: "goals", total: 2, minutes: 90, snapshot_id: "s", lineage: ["fpl:asset"] }]);
    const body = playerTrendsBody({ ...result, people: [{ person_id: "fpl:code:1", label: "Alex" }], credits: { "fpl:asset": "Verified credit", "fpl:other": "Unused credit" } }, {}, LOCALES.en);
    expect(body).toContain("Verified credit"); expect(body).not.toContain("Unused credit"); expect(body).toContain("aria-label=\"Data unavailable\">—"); expect(body).not.toContain("<td>0</td>");
  });

  it("adds a keyboard reachable navigation link to both locale shells", () => {
    for (const locale of [LOCALES.en, LOCALES.es]) expect(page("", { title: "x", locale, unprefixedPath: "/players/trends" })).toContain(`<a href="/${locale.code}/players/trends">`);
  });
});
