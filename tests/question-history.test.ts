import { describe, expect, it } from "vitest";

import {
  clearQuestionHistory,
  listQuestionHistory,
  QUESTION_HISTORY_LIMIT,
  saveQuestionHistory,
  type Env,
} from "../worker/src/core/db";
import type { QueryIntent } from "../worker/src/core/intent";

type StoredRow = {
  id: number;
  account_sub: string;
  question_text: string;
  visualization_path: string;
  locale: "en" | "es";
  created_at: string;
};

function historyEnv(): Env {
  const rows: StoredRow[] = [];
  let nextId = 1;
  const DB = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) { bound = args; return statement; },
        async run() {
          if (sql.startsWith("DELETE FROM account_question_history WHERE account_sub = ?")) {
            for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.account_sub === bound[0]) rows.splice(i, 1);
          }
          return { success: true };
        },
        async all<T>() {
          const results = rows.filter((row) => row.account_sub === bound[0])
            .sort((a, b) => b.id - a.id).slice(0, QUESTION_HISTORY_LIMIT)
            .map(({ id, question_text, visualization_path, locale, created_at }) => ({ id, question_text, visualization_path, locale, created_at }));
          return { results: results as T[] };
        },
      };
      return Object.assign(statement, { sql, values: () => bound });
    },
    async batch(statements: Array<{ sql: string; values: () => unknown[] }>) {
      for (const statement of statements) {
        const values = statement.values();
        if (statement.sql.startsWith("INSERT INTO account_question_history")) {
          rows.push({ id: nextId++, account_sub: String(values[0]), question_text: String(values[1]), visualization_path: String(values[2]), locale: values[3] as "en" | "es", created_at: String(values[4]) });
        } else if (statement.sql.startsWith("DELETE FROM account_question_history")) {
          const account = String(values[0]);
          const keep = new Set(rows.filter((row) => row.account_sub === account).sort((a, b) => b.id - a.id).slice(0, QUESTION_HISTORY_LIMIT).map((row) => row.id));
          for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.account_sub === account && !keep.has(rows[i]!.id)) rows.splice(i, 1);
        }
      }
      return [];
    },
  } as unknown as D1Database;
  return { DB, CFG: {} as KVNamespace };
}

const intent: QueryIntent = {
  metric: "goals", entity_type: "player", entity_id: "all", season: "2025-26",
  competition: "PL", dimensions: [], filters: {}, viz: "bar", limit: 10,
};

describe("account-linked question history", () => {
  it("stores a canonical replay link for only the supplied account subject", async () => {
    const env = historyEnv();
    await saveQuestionHistory(env, "access-subject-a", "  United goals?  ", intent, "en");
    await saveQuestionHistory(env, "access-subject-b", "United assists?", { ...intent, metric: "assists" }, "es");
    const a = await listQuestionHistory(env, "access-subject-a");
    expect(a).toHaveLength(1);
    expect(a[0]?.question).toBe("United goals?");
    expect(a[0]?.visualizationPath).toContain("/en/q?");
    expect(a[0]?.visualizationPath).toContain("season=2025-26");
    expect(await listQuestionHistory(env, "access-subject-b")).toHaveLength(1);
  });

  it("retains at most 50 recent questions and clears only that account", async () => {
    const env = historyEnv();
    await saveQuestionHistory(env, "subject-a", "Other account", intent, "en");
    for (let i = 0; i < QUESTION_HISTORY_LIMIT + 3; i++) {
      await saveQuestionHistory(env, "subject-b", `Question ${i}`, intent, "en");
    }
    const rows = await listQuestionHistory(env, "subject-b");
    expect(rows).toHaveLength(QUESTION_HISTORY_LIMIT);
    expect(rows[0]?.question).toBe("Question 52");
    await clearQuestionHistory(env, "subject-b");
    expect(await listQuestionHistory(env, "subject-b")).toEqual([]);
    expect(await listQuestionHistory(env, "subject-a")).toHaveLength(1);
  });

  it("refuses empty service identities and invalid question text", async () => {
    const env = historyEnv();
    await expect(saveQuestionHistory(env, "", "question", intent, "en")).rejects.toThrow("human_access_subject_required");
    await expect(saveQuestionHistory(env, "subject-a", "  ", intent, "en")).rejects.toThrow("invalid_history_question");
  });
});
