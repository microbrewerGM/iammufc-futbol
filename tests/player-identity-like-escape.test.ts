import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolvePlayerIdentity, type Env } from "../worker/src/core/db";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(readFileSync(new URL("../infra/migrations/0001_schema.sql", import.meta.url), "utf8"));
  const queries: string[] = [];
  const env = { DB: { prepare(sql: string) {
    queries.push(sql);
    return { bind(...values: (string | number)[]) {
      return { all: async () => ({ results: db.prepare(sql).all(...values) }) };
    } };
  } } } as unknown as Env;
  let next = 0;
  function add(names: { web?: string; first?: string; second?: string }, competition = "PL") {
    const code = ++next;
    const player = `fpl:${code}:2025-26`;
    const identity = { person_id: `fpl:code:${code}`, web_name: names.web ?? "Other" };
    db.prepare("INSERT INTO players VALUES (?, ?, '2025-26', ?, ?, ?, 'MID', 'MUN')")
      .run(player, code, identity.web_name, names.first ?? "Plain", names.second ?? "Surname");
    db.prepare("INSERT INTO player_identities VALUES (?, ?, 'fpl', ?, '2025-26')")
      .run(player, identity.person_id, code);
    db.prepare("INSERT INTO player_season_stats (player_id, season, competition, snapshot_id) VALUES (?, '2025-26', ?, 'fixture')")
      .run(player, competition);
    return identity;
  }
  return { env, queries, add };
}

describe("literal player alias search on real SQLite", () => {
  it.each(["web", "second", "full"] as const)("treats wildcard punctuation literally in %s names", async field => {
    const { env, add } = fixture();
    add(field === "full" ? { first: "Alpha", second: "Beta" } : { [field]: "AlphaBeta" });
    for (const needle of ["%%%", "___", "alpha%beta", "alpha_beta", "alpha %eta", "fpl:code:%"]) {
      await expect(resolvePlayerIdentity(env, needle)).resolves.toBeNull();
    }
  });

  it.each(["web", "second", "full"] as const)("finds literal punctuation substrings in %s names", async field => {
    const { env, add } = fixture();
    const expected = add(field === "full"
      ? { first: "Prefix A!%_", second: "B Suffix" }
      : { [field]: "Prefix A!%_B Suffix" });
    const needle = field === "full" ? "a!%_ b" : "a!%_b";
    await expect(resolvePlayerIdentity(env, needle)).resolves.toEqual(expected);
  });

  it("keeps ordinary case/dot normalization, exact priority and ambiguous aliases", async () => {
    const { env, add } = fixture();
    const expected = add({ web: "A.B. Target" });
    add({ web: "AB Target Junior" });
    await expect(resolvePlayerIdentity(env, "  A.B. TARGET  ")).resolves.toEqual(expected);
    await expect(resolvePlayerIdentity(env, "target")).resolves.toBeNull();
    await expect(resolvePlayerIdentity(env, "junior")).resolves.toEqual({ person_id: "fpl:code:2", web_name: "AB Target Junior" });
  });

  it("keeps exact punctuation aliases ahead of loose matches", async () => {
    const { env, add } = fixture();
    const exact = add({ web: "A!%_B" });
    add({ web: "A!%_B Junior" });
    await expect(resolvePlayerIdentity(env, "a!%_b")).resolves.toEqual(exact);
  });

  it("keeps literal escape characters and backslashes", async () => {
    const { env, add } = fixture();
    const bang = add({ web: "Prefix A!!B Suffix" });
    const slash = add({ web: String.raw`Prefix A\B Suffix` });
    await expect(resolvePlayerIdentity(env, "a!!b")).resolves.toEqual(bang);
    await expect(resolvePlayerIdentity(env, String.raw`a\b`)).resolves.toEqual(slash);
  });

  it("preserves competition filtering and the exact person-id path", async () => {
    const { env, queries, add } = fixture();
    const expected = add({ web: "Cup A%_B" }, "CL");
    await expect(resolvePlayerIdentity(env, "a%_b")).resolves.toBeNull();
    await expect(resolvePlayerIdentity(env, "a%_b", "CL")).resolves.toEqual(expected);
    queries.length = 0;
    await expect(resolvePlayerIdentity(env, expected.person_id, "CL")).resolves.toEqual(expected);
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toMatch(/LIKE/i);
  });
});
