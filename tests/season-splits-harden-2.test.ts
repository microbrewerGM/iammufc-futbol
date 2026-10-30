import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";

const sqliteModuleName: string = "node:sqlite";
const { DatabaseSync } = await import(sqliteModuleName) as unknown as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    close(): void;
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
const headers = { "cf-access-jwt-assertion": "synthetic", Origin: "https://site.invalid" };

function fakeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE snapshots (snapshot_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
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
  sqlite.prepare("INSERT INTO snapshots VALUES (?, '2026-01-01T00:00:00Z')").run(snapshot);
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

afterEach(() => vi.restoreAllMocks());
const locales = ["en", "es"] as const;

for (const locale of locales) describe(`${locale} season split navigation and gaps`, () => {
  it("rejects unsupported opponents before any budget or data SQL", async () => {
    const prepare = vi.fn(() => { throw new Error("unexpected SQL"); });
    const env = envFor({ prepare } as unknown as ReturnType<typeof fakeD1>["db"]);
    for (const opponent of ["club:1016", "club:9999", "club:1"]) {
      for (const capability of ["clear", "unknown"] as const) {
        vi.spyOn(Catalog.prototype, "outputCapability").mockReturnValue(capability);
        const response = await app.request(`https://site.invalid/${locale}/seasons/explore?seasons=2024-25&opponent_id=${encodeURIComponent(opponent)}`, { headers }, env);
        expect(response.status).toBe(400);
        expect(await response.text()).toContain(locale === "en" ? "Invalid season selection." : "Selección de temporada no válida.");
      }
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it("follows both navigation links to valid default selections", async () => {
    const store = fakeD1();
    try {
      vi.spyOn(Catalog.prototype, "outputCapability").mockReturnValue("clear");
      const env = envFor(store.db);
      const { page } = await import("../worker/src/views/layout");
      const { LOCALES } = await import("../worker/src/core/locale");
      const markup = page("", { title: "Navigation", locale: LOCALES[locale], unprefixedPath: "/" });
      const nav = markup.match(/<nav class="analysis-nav"[\s\S]*?<\/nav>/)![0];
      for (const path of ["opponents/history", "seasons/explore"]) {
        const href = nav.match(new RegExp(`href="(/${locale}/${path}[^" ]*)"`))![1]!.replaceAll("&amp;", "&");
        const url = new URL(href, "https://site.invalid");
        // The explore link is bare so the route preselects the newest clear season.
        expect(url.searchParams.getAll("seasons")).toEqual([]);
        if (path === "opponents/history") expect(url.searchParams.get("opponent_id")).toBeNull();
        const response = await app.request(url.toString(), { headers }, env);
        expect(response.status).toBe(200);
        expect(await response.text()).not.toMatch(/Invalid season selection|Selección de temporada no válida|temporarily unavailable|no está disponible temporalmente/);
      }
    } finally { store.sqlite.close(); }
  });

  it.each([false, true])("serves missing-season history without inventing totals (all missing=%s)", async (allMissing) => {
    const store = fakeD1();
    try {
      vi.spyOn(Catalog.prototype, "outputCapability").mockReturnValue("clear");
      for (const season of ["2023-24", "2024-25"]) {
        store.sqlite.prepare("INSERT INTO season_stats VALUES (?, ?, 'PL', 1)").run(snapshot, season);
        store.sqlite.prepare(`INSERT INTO season_splits VALUES (?, ?, 'PL', 'home', 'club:1001', 1, 1, 0, 0, 2, 0, ?)`).run(
          snapshot, season, season === "2023-24" || allMissing ? "not-json" : '["football_data_couk"]',
        );
      }
      const response = await app.request(`https://site.invalid/${locale}/opponents/history?opponent_id=club%3A1001&seasons=2023-24&seasons=2024-25`, { headers }, envFor(store.db));
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      const missing = locale === "en" ? "Record unavailable; missing matches are not zero" : "Balance no disponible; los partidos ausentes no equivalen a cero";
      expect(body).toContain(`<th scope="row">2023-24</th><td colspan="9">—</td><td>${missing}</td>`);
      const combined = body.match(/<tr><th scope="row">(?:Combined record for selected seasons|Balance conjunto de las temporadas seleccionadas)<\/th>[\s\S]*?<\/tr>/)![0];
      if (allMissing) {
        expect(combined).toContain(`<td colspan="9">—</td><td>${missing}</td>`);
        expect(combined).not.toContain("<td>0</td>");
      } else {
        expect(combined).toContain("<td>1</td><td>1</td><td>0</td><td>0</td><td>2</td><td>0</td><td>3</td>");
        expect(combined).toContain(locale === "en" ? "Recorded subtotal" : "Subtotal registrado");
        const sources = body.match(/<section aria-label="(?:Sources and snapshot|Fuentes y versión de datos)">[\s\S]*?<\/section>/)![0];
        expect(sources).toContain("Football-Data.co.uk");
        expect(sources).toContain(snapshot);
      }
    } finally { store.sqlite.close(); }
  });
});
