import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createQuestionRequestsRouter } from "../worker/src/routes/question-requests";
import type { RouteEnv } from "../worker/src/routes/question-requests";
import { storeQuestion, validAccountSub, validQuestionText } from "../worker/src/core/question-requests";

function appWith() {
  const app = new Hono<RouteEnv>();
  app.use("*", async (c, next) => { c.set("accessIdentity", { sub: "human-account", email: "owner@example.invalid" }); await next(); });
  app.route("/", createQuestionRequestsRouter());
  return app;
}
const env = (DB: unknown) => ({ DB } as never);

describe("question request intake", () => {
  it("normalizes text and rejects the full database rejected character classes", () => {
    expect(validQuestionText("Cafe\u0301 goals?")).toBe("Café goals?");
    expect(validAccountSub("human-account")).toBe(true);
    expect(validAccountSub(`a\u200db`)).toBe(false);
    expect(validAccountSub("a".repeat(513))).toBe(false);
    for (const rejected of ["\u0001", "\u0085", "\u00ad", "\u061c", "\u180e", "\u200b", "\u200d", "\u202e", "\u2060", "\ufeff", "\ufffa", "\u{e0000}"]) {
      expect(validQuestionText(`a${rejected}b`)).toBeNull();
    }
    expect(validQuestionText("a".repeat(501))).toBeNull();
  });

  it("renders a plain bilingual form and localized status without JavaScript", async () => {
    const db = { prepare: vi.fn(() => ({ bind: () => ({ first: async () => ({ status: "triage_failed" }) }) })) };
    const app = appWith();
    const response = await app.request("https://site.invalid/es/requests?id=" + "a".repeat(64), {}, env(db));
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("<form method=\"post\" action=\"/es/requests\">");
    expect(html).toContain("Error en la revisión");
    expect(html).not.toMatch(/<script\b/i);
  });

  it("rejects script and attribute payloads without reflecting submitted text", async () => {
    const first = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ n: 0 }).mockResolvedValueOnce({ n: 0 }).mockResolvedValueOnce({ count: 1 });
    const db = { prepare: vi.fn(() => ({ bind: () => ({ first, run: async () => ({ meta: { changes: 1 } }) }) })) };
    const app = appWith();
    const payload = `<script>alert(1)</script><img src=x onerror="alert(2)">`;
    const response = await app.request("https://site.invalid/en/requests", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ text: payload }) }, env(db));
    const html = await response.text();
    expect(response.status).toBe(303);
    expect(html).not.toContain(payload);
    expect(html).not.toContain("<script>");
  });

  it("returns the existing duplicate row id and binds every user value", async () => {
    const existingId = "f".repeat(64);
    const bindings: unknown[][] = [];
    const sql: string[] = [];
    const db = { prepare: (query: string) => { sql.push(query); return { bind: (...values: unknown[]) => { bindings.push(values); return {
      first: async () => query.includes("SELECT request_id") ? { request_id: existingId } : null,
      run: async () => ({ meta: { changes: 0 } }),
    }; } }; } };
    const payload = "<script>alert(1)</script>";
    const result = await storeQuestion(env(db), "human-account", payload, "en");
    expect(result).toEqual({ kind: "duplicate", requestId: existingId });
    expect(sql.join(" ")).not.toContain(payload);
    expect(bindings[0]).toHaveLength(3);
    expect(sql[0]).toContain("account_sub = ?");

    const writes: unknown[][] = [];
    const freshDb = { prepare: (query: string) => ({ bind: (...values: unknown[]) => { writes.push(values); return {
      first: async () => query.includes("SELECT count(*)") ? { n: 0 } : query.includes("RETURNING count") ? { count: 1 } : null,
      run: async () => ({ meta: { changes: 1 } }),
    }; } }) };
    expect((await storeQuestion(env(freshDb), "human-account", payload, "en")).kind).toBe("stored");
    expect(writes.flat()).toContain(payload);
  });
});
