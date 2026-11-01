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
  for (const [id, label] of [[1, "<Alex>"], [2, "Blair"], [3, "Casey"], [4, "Devon"], [5, "Evan"], [6, "Farah"]] as const) {
    const pid = `p${id}`;
    sqlite.prepare("INSERT INTO players VALUES (?, ?)").run(pid, label);
    sqlite.prepare("INSERT INTO player_identities VALUES (?, ?, '2023-24')").run(`fpl:code:${id}`, pid);
    sqlite.prepare("INSERT INTO player_season_stats VALUES (?, '2023-24', 'PL', 2, 1, ?, ?)").run(pid, 900 - id, snapshot);
  }
  const db = { prepare(sql: string) { let bound: unknown[] = []; const stmt = { bind(...values: unknown[]) { bound = values; return stmt; }, first: async <T,>() => (sqlite.prepare(sql).get(...bound) ?? null) as T | null, all: async <T,>() => ({ results: sqlite.prepare(sql).all(...bound) as T[] }), run: async () => sqlite.prepare(sql).run(...bound) }; return stmt; } };
  return { sqlite, env: { DB: db, CFG: { get: async () => null, put: async () => undefined }, ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64), ACCESS_OWNER_EMAILS: "owner@example.invalid" } as unknown as Env };
}
const route = (locale: string, query: URLSearchParams) => app.request(`https://site.invalid/${locale}/players/trends?${query}`, { headers }, (activeEnv as Env));
let activeEnv: Env;
const queryFor = (ids: string[]) => {
  const q = new URLSearchParams("schema_version=1&competition=PL&metric=assists&normalization=per90&start_season=2023-24&end_season=2023-24");
  ids.forEach(id => q.append("person_ids", id)); return q;
};
const decode = (html: string) => html.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

describe("player trends form", () => {
  it.each(["en", "es"])("renders contract-matching selected metric and normalization, labels, and localized compare link in %s", async locale => {
    const f = fixture(); activeEnv = f.env;
    const response = await route(locale, queryFor(["fpl:code:1", "fpl:code:2"]));
    const body = decode(await response.text());
    expect(response.status).toBe(200);
    expect(body).toMatch(/<select id="trend-metric" name="metric">[\s\S]*?<option value="assists" selected>/);
    expect(body).toMatch(/<select id="trend-normalization" name="normalization">[\s\S]*?<option value="per90" selected>/);
    for (const id of ["trend-player-1", "trend-player-2", "trend-player-3", "trend-player-4", "trend-player-5", "trend-metric", "trend-normalization", "trend-start-season", "trend-end-season"]) {
      expect(body).toContain(`<label for="${id}">`);
      expect(body).toContain(`<select id="${id}"`);
    }
    expect(body).toContain(`href="/${locale}/compare"`);
    expect(body).toContain("<option value=\"fpl:code:1\" selected><Alex></option>");
  });

  it.each([2, 3, 4, 5])("renders each of %i requested players selected and submits them; omitted optionals produce no blank person_ids", async count => {
    const f = fixture(); activeEnv = f.env;
    const ids = Array.from({ length: count }, (_, i) => `fpl:code:${i + 1}`);
    const rendered = decode(await (await route("en", queryFor(ids))).text());
    const selects = [...rendered.matchAll(/<select id="trend-player-(\d)" name="person_ids"([^>]*)>([\s\S]*?)<\/select>/g)];
    expect(selects).toHaveLength(5);
    ids.forEach((id, index) => expect(selects[index]![3]).toMatch(new RegExp(`<option value="${id}" selected>`)));
    const submitted = new URLSearchParams();
    for (const [, , attrs, options] of selects) {
      const selected = [...options!.matchAll(/<option value="([^"]*)"([^>]*)>/g)].find(match => match[2]!.includes("selected"));
      if (selected && !selected[2]!.includes("disabled")) submitted.append("person_ids", selected[1]!);
      expect(attrs).not.toContain("multiple");
    }
    expect(submitted.getAll("person_ids")).toEqual(ids);
    const q = new URLSearchParams("schema_version=1&competition=PL&metric=goals&normalization=total&start_season=2023-24&end_season=2023-24");
    submitted.getAll("person_ids").forEach(id => q.append("person_ids", id));
    const response = await route("en", q);
    expect(response.status).toBe(200);
    const result = decode(await response.text());
    for (const id of ids) expect(result).toMatch(new RegExp(`<option value="${id}" selected>`));
  });

  it("keeps a requested player selected when that player is absent from choices", async () => {
    const f = fixture(); activeEnv = f.env;
    f.sqlite.prepare("UPDATE player_season_stats SET minutes = 0 WHERE player_id = 'p2'").run();
    const body = decode(await (await route("en", queryFor(["fpl:code:1", "fpl:code:2"]))).text());
    const second = new RegExp('<select id="trend-player-2" name="person_ids"[^>]*>([\\s\\S]*?)</select>').exec(body)?.[1];
    expect(second).toContain('<option value="fpl:code:2" selected>Blair</option>');
    expect([...second!.matchAll(/value="fpl:code:2"/g)]).toHaveLength(1);
  });

  it("accepts a different available player selected in the form", async () => {
    const f = fixture(); activeEnv = f.env;
    const rendered = decode(await (await route("en", queryFor(["fpl:code:1", "fpl:code:2"]))).text());
    const changed = rendered.replace('<option value="fpl:code:2" selected>Blair</option>', '<option value="fpl:code:2">Blair</option><option value="fpl:code:3" selected>Casey</option>');
    const second = new RegExp('<select id="trend-player-2" name="person_ids"[^>]*>([\\s\\S]*?)</select>').exec(changed)?.[1];
    expect(second).toContain('<option value="fpl:code:3" selected>Casey</option>');
    const submitted = queryFor(["fpl:code:1", "fpl:code:3"]);
    expect((await route("en", submitted)).status).toBe(200);
  });

  it("limits the form to five native single-select controls and the existing route rejects a sixth", async () => {
    const f = fixture(); activeEnv = f.env;
    const page = decode(await (await route("en", queryFor(["fpl:code:1", "fpl:code:2"]))).text());
    expect([...page.matchAll(/<select id="trend-player-/g)]).toHaveLength(5);
    expect(page.match(/<select id="trend-player-3"[^>]*>/)?.[0]).not.toContain("required");
    expect(page.match(/<select id="trend-player-4"[^>]*>/)?.[0]).not.toContain("required");
    expect(page.match(/<select id="trend-player-5"[^>]*>/)?.[0]).not.toContain("required");
    const tooMany = queryFor(Array.from({ length: 6 }, (_, i) => `fpl:code:${i + 1}`));
    expect((await route("en", tooMany)).status).toBe(400);
  });
});
