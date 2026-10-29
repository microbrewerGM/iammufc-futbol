import { afterEach, describe, expect, it, vi } from "vitest";
import { seasonSplitFacts, type Env } from "../worker/src/core/db";
import { Catalog } from "../worker/src/core/feasibility";
import { LOCALES } from "../worker/src/core/locale";
import { querySeasonSplits, type SeasonSplitRequest } from "../worker/src/core/season-splits";
import { seasonSplitsBody, seasonSplitSelection } from "../worker/src/views/season-splits";

// Access verification and capability readiness are synthetic. Publication, aggregate
// SQL, reconciliation, query projection, catalog credits and route HTML remain real.
vi.mock("jose", async (original) => ({
  ...await original<typeof import("jose")>(),
  jwtVerify: vi.fn(async () => ({ payload: { sub: "trust-test", email: "owner@example.invalid" } })),
}));
vi.mock("../worker/src/core/db", async (original) => ({
  ...await original<typeof import("../worker/src/core/db")>(),
  currentSnapshot: vi.fn(async (env: Env) => {
    const row = await env.DB.prepare("SELECT snapshot_id FROM snapshots ORDER BY rowid DESC LIMIT 1")
      .first<{ snapshot_id: string }>();
    return row?.snapshot_id ?? null;
  }),
}));
import app from "../worker/src/index";

const sqliteModuleName: string = "node:sqlite";
const { DatabaseSync } = await import(sqliteModuleName) as unknown as {
  DatabaseSync: new (path: string) => {
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): {
      run(...values: unknown[]): unknown;
      get(...values: unknown[]): unknown;
      all(...values: unknown[]): unknown[];
    };
  };
};
const snapshotA = "a".repeat(64), snapshotB = "b".repeat(64);
const seasons = ["2023-24", "2024-25"];
const headers = { "cf-access-jwt-assertion": "synthetic", Origin: "https://site.invalid" };
const stores: { close(): void }[] = [];
afterEach(() => { vi.restoreAllMocks(); stores.splice(0).forEach(store => store.close()); });

function fixture(changeOnPublicationRead?: number) {
  const sqlite = new DatabaseSync(":memory:");
  stores.push(sqlite);
  sqlite.exec(`
    CREATE TABLE snapshots (snapshot_id TEXT PRIMARY KEY);
    CREATE TABLE publication_runs (run_id INTEGER PRIMARY KEY, snapshot_id TEXT,
      prepared_at TEXT, loaded_at TEXT, source_status_json TEXT);
    CREATE TABLE budget_counter (day TEXT PRIMARY KEY, count INTEGER NOT NULL);
    CREATE TABLE season_stats (snapshot_id TEXT, season TEXT, competition TEXT, played INTEGER);
    CREATE TABLE season_splits (snapshot_id TEXT, season TEXT, competition TEXT, venue TEXT,
      opponent_id TEXT, played INTEGER, won INTEGER, drawn INTEGER, lost INTEGER,
      goals_for INTEGER, goals_against INTEGER, lineage_json TEXT);
  `);
  const sources = Object.fromEntries(["football_data_couk", "fpl", "openfootball_cl"].map(id =>
    [id, { coverage_through: null, retrieved_at: null, status: "unavailable" }]));
  function publish(snapshot: string) {
    sqlite.prepare("INSERT INTO snapshots VALUES (?)").run(snapshot);
    sqlite.prepare("INSERT INTO publication_runs (snapshot_id, prepared_at, loaded_at, source_status_json) VALUES (?, ?, ?, ?)")
      .run(snapshot, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", JSON.stringify(sources));
  }
  publish(snapshotA);
  function addSeason(season: string, snapshot = snapshotA, lineage = '["football_data_couk"]', expectedPlayed = 2) {
    sqlite.prepare("INSERT INTO season_stats VALUES (?, ?, 'PL', ?)").run(snapshot, season, expectedPlayed);
    for (const venue of ["home", "away"]) {
      sqlite.prepare("INSERT INTO season_splits VALUES (?, ?, 'PL', ?, 'club:1001', 1, 1, 0, 0, 2, 0, ?)")
        .run(snapshot, season, venue, lineage);
    }
  }
  let publicationReads = 0;
  const db = { prepare(sql: string) {
    let bound: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) { bound = values; return statement; },
      first: async <T,>() => {
        if (sql.includes("SELECT r.snapshot_id FROM publication_runs") && ++publicationReads === changeOnPublicationRead) {
          publish(snapshotB);
        }
        return (sqlite.prepare(sql).get(...bound) ?? null) as T | null;
      },
      all: async <T,>() => ({ results: sqlite.prepare(sql).all(...bound) as T[] }),
      run: async () => sqlite.prepare(sql).run(...bound),
    };
    return statement;
  } };
  const env = { DB: db, CFG: { get: async () => null, put: async () => undefined },
    ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64),
    ACCESS_OWNER_EMAILS: "owner@example.invalid" } as unknown as Env;
  vi.spyOn(Catalog.prototype, "outputCapability").mockReturnValue("clear");
  return { sqlite, env, addSeason, publish };
}
const sourcesSection = (body: string) => {
  const section = body.match(/<section aria-label="(?:Sources and snapshot|Fuentes y versión de datos)">[\s\S]*?<\/section>/)?.[0];
  expect(section).toBeDefined();
  return section!;
};
const canonical = (body: string) => {
  const href = body.match(/<link rel="canonical" href="([^"]+)">/)?.[1];
  expect(href).toBeDefined();
  return href!.replaceAll("&amp;", "&");
};
const request: SeasonSplitRequest = { schema_version: 1, competition: "PL", seasons,
  group_by: "venue", venue: null, opponent_id: null };

// Pure seam accepts partial coverage; published SQL deliberately withholds an
// unreconciled season as missing rather than serving incomplete aggregates.
describe.each(["en", "es"] as const)("%s season trust projection", locale => {
  it("preserves explicit complete, partial and missing metadata through core and view", () => {
    const selected = [...seasons, "2025-26"];
    const result = querySeasonSplits({ ...request, seasons: selected }, {
      snapshot_id: snapshotA, seasons: [
        { season: seasons[0], coverage: "complete" }, { season: seasons[1], coverage: "partial" },
        { season: selected[2], coverage: "missing" },
      ],
    }, [{ season: seasons[1], competition: "PL", venue: "home", opponent_id: "club:1",
      played: 1, won: 1, drawn: 0, lost: 0, goals_for: 2, goals_against: 0,
      snapshot_id: snapshotA, lineage: ["synthetic-source"] }]);
    const body = seasonSplitsBody({ result, selection: seasonSplitSelection(result.request),
      seasons: selected, opponents: [], credits: { "synthetic-source": "Selected credit", unrelated: "Unrelated credit" } }, LOCALES[locale]);
    expect(result.coverage.map(entry => entry.coverage)).toEqual(["complete", "partial", "missing"]);
    expect(body).toContain(locale === "en" ? "2023-24: Complete" : "2023-24: Completa");
    expect(body).toContain(locale === "en" ? "2024-25: Partial schedule" : "2024-25: Calendario parcial");
    expect(body).toContain(locale === "en" ? "2025-26: Missing split coverage" : "2025-26: Sin cobertura de desgloses");
    expect(body).toContain(locale === "en" ? "Missing matches are not zero" : "Los partidos ausentes no equivalen a cero");
    expect(sourcesSection(body)).toContain(snapshotA);
    expect(sourcesSection(body)).toContain("Selected credit");
    expect(body).not.toContain("Unrelated credit");
  });

  it("projects reconciled SQL coverage and result lineage into localized explanations", async () => {
    const store = fixture();
    store.addSeason(seasons[0]!);
    store.addSeason(seasons[1]!, snapshotA, '["fpl"]', 3); // Two rows cannot prove three matches.
    const response = await app.request(`https://site.invalid/${locale}/seasons/explore?seasons=2024-25&seasons=2023-24`, { headers }, store.env);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain(locale === "en" ? "2023-24: Complete" : "2023-24: Completa");
    expect(body).toContain(locale === "en" ? "2024-25: Missing split coverage" : "2024-25: Sin cobertura de desgloses");
    expect(body).toContain(locale === "en" ? "partial subtotals" : "subtotales parciales");
    const section = sourcesSection(body);
    expect(section).toContain(snapshotA);
    expect(section).toContain("Football-Data.co.uk");
    expect(section).not.toMatch(/FPL|Fantasy Premier League|OpenFootball|Source attribution unavailable|Atribución de fuente no disponible/);
  });

  it.each(['["unregistered-source"]', '["football_data_couk","unregistered-source"]', 'not-json'])(
    "withholds the entire affected season for invalid lineage %s even behind a venue filter", async lineage => {
      const store = fixture();
      store.addSeason(seasons[0]!);
      store.addSeason(seasons[1]!);
      store.sqlite.prepare("UPDATE season_splits SET lineage_json = ? WHERE season = ? AND venue = 'home'")
        .run(lineage, seasons[0]!);
      const facts = await seasonSplitFacts(store.env, snapshotA, seasons, { venue: "away", opponent_id: null });
      expect(facts.catalog.seasons).toEqual([
        { season: seasons[0], coverage: "missing" }, { season: seasons[1], coverage: "complete" },
      ]);
      expect(facts.rows.map(row => row.season)).toEqual([seasons[1]]);
      const response = await app.request(`https://site.invalid/${locale}/seasons/explore?seasons=2023-24&venue=away`, { headers }, store.env);
      const body = await response.text();
      expect(response.status).toBe(200); // Missing capability is honest, not an invented 503.
      expect(body).not.toContain("<table");
      expect(body).toContain(locale === "en" ? "No zero-match total is implied" : "No se afirma un total de cero partidos");
      expect(sourcesSection(body)).not.toContain("Football-Data.co.uk");
      expect(body).not.toContain("unregistered-source");
    },
  );

  it("renders only the two contributing catalog sources for a complete result", async () => {
    const store = fixture();
    store.addSeason(seasons[0]!, snapshotA, '["football_data_couk","fpl"]');
    const response = await app.request(`https://site.invalid/${locale}/seasons/explore?seasons=2023-24`, { headers }, store.env);
    const body = await response.text();
    expect(response.status).toBe(200);
    const section = sourcesSection(body);
    expect(section).toContain("Football-Data.co.uk");
    expect(section).toContain(locale === "en"
      ? "Player data derived from the Fantasy Premier League public API."
      : "Datos de jugadores derivados de la API pública de Fantasy Premier League.");
    expect(section).not.toContain(locale === "en"
      ? "Datos de jugadores derivados" : "Player data derived");
    expect(section).not.toMatch(/OpenFootball|Source attribution unavailable|Atribución de fuente no disponible/);
    expect(body).not.toContain('id="splits-warning"');
    expect(body).toContain("<td>1</td><td>1</td><td>0</td><td>0</td><td>2</td><td>0</td>");
  });

  it.each([1, 2])("fails closed when publication changes at aggregate snapshot check %i", async check => {
    const store = fixture(check);
    store.addSeason(seasons[0]!);
    const response = await app.request(`https://site.invalid/${locale}/seasons/explore?seasons=2023-24`, { headers }, store.env);
    const body = await response.text();
    expect(response.status).toBe(503);
    expect(body).toContain(locale === "en" ? "Season split data is unavailable" : "Los datos de desgloses no están disponibles");
    expect(body).toContain('role="alert"');
    expect(body).not.toContain("<table");
    expect(body).not.toMatch(/<section aria-label="(?:Sources and snapshot|Fuentes y versión de datos)">/);
  });

  it("refuses a publication mismatch instead of rendering stale totals or credit", async () => {
    const store = fixture();
    store.addSeason(seasons[0]!);
    store.publish(snapshotB);
    await expect(seasonSplitFacts(store.env, snapshotA, [seasons[0]!])).rejects.toThrow("stale season split publication");
    const result = querySeasonSplits(request, { snapshot_id: snapshotB, seasons: seasons.map(season => ({ season, coverage: "complete" })) }, []);
    expect(result.snapshot_id).toBe(snapshotB);
    expect(() => querySeasonSplits(request, { snapshot_id: snapshotB, seasons: result.coverage }, [{
      season: seasons[0], competition: "PL", venue: "home", opponent_id: "club:1", played: 1,
      won: 1, drawn: 0, lost: 0, goals_for: 2, goals_against: 0, snapshot_id: snapshotA, lineage: ["football_data_couk"],
    }])).toThrow("mixed snapshots");
  });

  it("reopens canonical filters with identical explanations and follows a new publication honestly", async () => {
    const store = fixture();
    seasons.forEach(season => store.addSeason(season));
    const response = await app.request(`https://site.invalid/${locale}/seasons/explore?venue=away&seasons=2024-25&opponent_id=club%3A1001&seasons=2023-24&group_by=opponent`, { headers }, store.env);
    const body = await response.text();
    expect(response.status).toBe(200);
    const path = canonical(body);
    expect(path).toBe(`/${locale}/seasons/explore?schema_version=1&competition=PL&seasons=2023-24&seasons=2024-25&group_by=opponent&venue=away&opponent_id=club%3A1001`);
    const replay = await app.request(`https://site.invalid${path}`, { headers }, store.env);
    expect(replay.status).toBe(200);
    const replayBody = await replay.text();
    expect(canonical(replayBody)).toBe(path);
    expect(sourcesSection(replayBody)).toBe(sourcesSection(body));
    expect(replayBody.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0]).toBe(body.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0]);
    store.publish(snapshotB);
    seasons.forEach(season => store.addSeason(season, snapshotB));
    const newer = await app.request(`https://site.invalid${path}`, { headers }, store.env);
    expect(newer.status).toBe(200);
    const newerBody = await newer.text();
    expect(canonical(newerBody)).toBe(path); // Filter replay is not an immutable artifact URL.
    expect(sourcesSection(newerBody)).toContain(snapshotB);
    expect(sourcesSection(newerBody)).not.toContain(snapshotA);
    expect(newer.headers.get("cache-control")).toBe("private, no-store");
  });
});
