import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";
import { LOCALES } from "../worker/src/core/locale";
import compiledCatalog from "../worker/src/generated/catalog.json" with { type: "json" };

const fsModuleName: string = "node:fs";
const { readFileSync } = await import(fsModuleName) as { readFileSync(path: string, encoding: string): string };
const sqliteModuleName: string = "node:sqlite";
const { DatabaseSync } = await import(sqliteModuleName) as unknown as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    close(): void;
    prepare(sql: string): { run(...values: unknown[]): unknown; all(...values: unknown[]): unknown[] };
  };
};

// This suite tests answers, not Access. Keep the parser, executor and renderer real.
vi.mock("../worker/src/security/auth", async (original) => ({
  ...await original<typeof import("../worker/src/security/auth")>(),
  accessGate: () => async (_context: unknown, next: () => Promise<void>) => next(),
  accessIdentity: () => undefined,
}));
vi.mock("../worker/src/core/db", async (original) => ({
  ...await original<typeof import("../worker/src/core/db")>(),
  currentSnapshot: vi.fn(async () => "a".repeat(64)),
  readQueryCache: vi.fn(async () => ({ result: null, outcome: "miss" })),
  writeQueryCache: vi.fn(async () => false),
  enforceBudget: vi.fn(async () => true),
  logQueryAggregate: vi.fn(async () => {}),
}));

import app from "../worker/src/index";
import { enforceBudget, logQueryAggregate } from "../worker/src/core/db";

const examples = [
  { key: "exampleGoals", metric: "goals", viz: "bar", order: ["Alpha", "Beta", "Gamma"], values: ["7", "3", "1"] },
  { key: "exampleAssistsTable", metric: "assists", viz: "table", order: ["Beta", "Gamma", "Alpha"], values: ["9", "4", "2"] },
  { key: "exampleMinutesDots", metric: "minutes", viz: "dot_plot", order: ["Gamma", "Alpha", "Beta"], values: ["1,800", "1,350", "900"] },
  { key: "examplePointsTable", metric: "points", viz: "table", order: ["Beta", "Alpha", "Gamma"], values: ["60", "40", "20"] },
  { key: "exampleXg", metric: "xg", viz: "bar", order: ["Beta", "Gamma", "Alpha"], values: ["8.50", "3.75", "1.25"] },
] as const;

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("infra/migrations/0001_schema.sql", "utf8"));
  const players = [
    { name: "Alpha", goals: 7, assists: 2, minutes: 1350, points: 40, xg: 1.25 },
    { name: "Beta", goals: 3, assists: 9, minutes: 900, points: 60, xg: 8.5 },
    { name: "Gamma", goals: 1, assists: 4, minutes: 1800, points: 20, xg: 3.75 },
  ];
  players.forEach((player, index) => {
    const id = `fixture:${index}:2025-26`;
    sqlite.prepare("INSERT INTO players VALUES (?, ?, '2025-26', ?, '', '', 'FW', 'MUN')")
      .run(id, index + 1, player.name);
    sqlite.prepare("INSERT INTO player_identities VALUES (?, ?, 'fpl', ?, '2025-26')")
      .run(id, `fpl:code:${index + 1}`, index + 1);
    sqlite.prepare("INSERT INTO player_season_stats VALUES (?, '2025-26', 'PL', ?, ?, ?, ?, ?, ?)")
      .run(id, player.goals, player.assists, player.minutes, player.points, player.xg, "a".repeat(64));
  });
  const reads: Array<{ sql: string; bound: unknown[]; results: unknown[] }> = [];
  const env = { DB: { prepare(sql: string) {
    let bound: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) { bound = values; return statement; },
      async all() {
        const results = sqlite.prepare(sql).all(...bound);
        reads.push({ sql, bound, results });
        return { results };
      },
    };
    return statement;
  } } } as unknown as Env;
  return { sqlite, env, reads };
}

async function ask(env: Env, language: "en" | "es", question: string) {
  return app.request(`https://site.invalid/${language}/ask`, {
    method: "POST",
    headers: { Origin: "https://site.invalid", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ q: question }).toString(),
  }, env);
}

beforeEach(() => vi.clearAllMocks());

describe.each(["en", "es"] as const)("%s example questions return fixture answers", (language) => {
  it.each(examples)("executes $key as $metric / $viz", async (example) => {
    const store = fixture();
    try {
      const response = await ask(store.env, language, `${LOCALES[language].strings[example.key]} 2025-26`);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain(`metric      ${example.metric}`);
      expect(html).toContain(`viz         ${example.viz}`);
      const table = html.match(/<table[\s\S]*?<\/table>/)?.[0];
      expect(table).toBeDefined();
      expect(html.includes('<div class="chart-region"')).toBe(example.viz !== "table");
      const rows = [...table!.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)][0]![1]!;
      expect([...rows.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((match) => {
        const row = match[1]!;
        return [row.match(/>(Alpha|Beta|Gamma)<\//)?.[1], row.match(/<td class="num">([^<]+)<\/td>/)?.[1]];
      })).toEqual(example.order.map((name, index) => [name,
        language === "es" ? (example.metric === "minutes"
          ? example.values[index]!.replace(",", "") : example.values[index]!.replace(".", ",")) : example.values[index],
      ]));
      const facts = store.reads.filter((read) => read.sql.includes("FROM player_season_stats"));
      expect(facts).toHaveLength(1);
      expect(facts[0]!.bound).toEqual(["2025-26", "PL", 10]);
      expect(logQueryAggregate).toHaveBeenCalledWith(store.env, expect.objectContaining({
        metric: example.metric, viz: example.viz,
      }), "computable_now_queued", "unavailable", "success", language, "ask_page");
    } finally { store.sqlite.close(); }
  });

  it.each(examples)("shows an empty supported season for $key", async (example) => {
    const store = fixture();
    const season = "2024-25";
    try {
      expect(compiledCatalog.coverage).toEqual(expect.arrayContaining([
        expect.objectContaining({ metric: example.metric, season, competition: "PL",
          entity_type: "player", granularity: "box_score", redistributable: true, cost_class: "cheap" }),
      ]));
      // Establish missing facts independently of the ask path; other-season facts exist.
      const expectedRows = store.sqlite.prepare("SELECT * FROM player_season_stats WHERE season = ?").all(season);
      expect(expectedRows).toEqual([]);
      expect(store.sqlite.prepare("SELECT * FROM player_season_stats WHERE season = ?").all("2025-26"))
        .toHaveLength(3);

      const response = await ask(store.env, language, `${LOCALES[language].strings[example.key]} ${season}`);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain(`metric      ${example.metric}`);
      expect(html).toContain(`viz         ${example.viz}`);
      expect(html).toContain(`season      ${season}`);
      const facts = store.reads.filter((read) => read.sql.includes("FROM player_season_stats"));
      expect(facts).toHaveLength(1);
      expect(facts[0]!.bound).toEqual([season, "PL", 10]);
      expect(facts[0]!.results).toEqual(expectedRows);
      expect(enforceBudget).toHaveBeenCalledTimes(1);
      expect(vi.mocked(enforceBudget).mock.calls[0]![0]).toBe(store.env);
      expect(html).toContain('<p class="state">no rows</p>');
      expect(html).toContain(language === "es"
        ? "El catálogo dice que esto es respondible, pero la consulta no devolvió nada. Prueba con un apellido, o pide una clasificación."
        : "The catalog says this is answerable, but the query returned nothing. Try a surname, or ask for a ranking.");
      expect(html).not.toContain('<p class="state">no_data</p>');
      expect(html).not.toContain("<table");
      expect(html).not.toContain('<div class="chart-region"');
      for (const name of ["Alpha", "Beta", "Gamma"]) expect(html).not.toContain(name);
      expect(logQueryAggregate).toHaveBeenCalledWith(store.env, expect.objectContaining({
        metric: example.metric, viz: example.viz, season,
      }), "computable_now_queued", "unavailable", "success", language, "ask_page");
    } finally { store.sqlite.close(); }
  });

  it.each(examples)("keeps missing-season $key honest", async (example) => {
    const store = fixture();
    try {
      const response = await ask(store.env, language, `${LOCALES[language].strings[example.key]} 2000-01`);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain('class="state">no_data</p>');
      expect(html).toContain("season      2000-01");
      expect(html).not.toContain("<table");
      expect(store.reads.some((read) => read.sql.includes("FROM player_season_stats"))).toBe(false);
      expect(enforceBudget).not.toHaveBeenCalled();
      expect(logQueryAggregate).toHaveBeenCalledWith(store.env, expect.objectContaining({
        metric: example.metric, season: "2000-01",
      }), "no_data", "not_applicable", "refused", language, "ask_page");
    } finally { store.sqlite.close(); }
  });
});
