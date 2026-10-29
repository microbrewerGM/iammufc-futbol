import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createQuestionRequestsRouter } from "../worker/src/routes/question-requests";
import type { RouteEnv } from "../worker/src/routes/question-requests";
import { storeQuestion, validAccountSub, validQuestionText } from "../worker/src/core/question-requests";
import { accessGate, type AccessIdentity } from "../worker/src/security/auth";
import type { Env } from "../worker/src/core/db";

const accessEnv = {
  ACCESS_ISSUER: "https://example.cloudflareaccess.com",
  ACCESS_AUD: "a".repeat(64),
  ACCESS_OWNER_EMAILS: "owner@example.invalid",
  ACCESS_SERVICE_CLIENT_IDS: "test-service",
} as unknown as Env;
function appWith(identity: AccessIdentity | null = { sub: "human-account", email: "owner@example.invalid" }) {
  const app = new Hono<RouteEnv>();
  app.use("*", accessGate(async () => {
    if (!identity) throw new Error("missing identity");
    return identity;
  }));
  app.route("/", createQuestionRequestsRouter());
  return app;
}
const env = (DB: unknown) => ({ DB } as never);
const headers = { "cf-access-jwt-assertion": "verified-by-test" };
function dbMock(first: (query: string) => unknown = () => null) {
  const queries: string[] = [];
  const DB = { prepare: vi.fn((query: string) => {
    queries.push(query);
    return { bind: () => ({ first: async () => first(query), run: async () => ({ meta: { changes: 1 } }) }) };
  }) };
  return { DB, queries };
}

describe("question request intake", () => {
  it("normalizes text and rejects the full database rejected character classes", () => {
    expect(validQuestionText("Cafe\u0301 goals?")).toBe("Café goals?");
    expect(validAccountSub("human-account")).toBe(true);
    expect(validAccountSub(`a\u200db`)).toBe(false);
    expect(validAccountSub("a".repeat(513))).toBe(false);
    for (const rejected of ["\u0001", "\u0085", "\u00ad", "\u0600", "\u061c", "\u06dd", "\u180e", "\u200b", "\u200d", "\u202e", "\u2060", "\ufeff", "\ufffa", "\u{e0000}", "\uFE0F", "\u{E0100}", "\u115F", "\u1160", "\u3164", "\uFFA0", "\u{E0001}", "\u{110BD}", "\u{1D173}"]) {
      expect(validQuestionText(`a${rejected}b`)).toBeNull();
    }
    expect(validQuestionText("a".repeat(501))).toBeNull();
  });

  it("renders a plain bilingual form and localized status without JavaScript", async () => {
    const db = { prepare: vi.fn(() => ({ bind: () => ({ first: async () => ({ status: "triage_failed" }) }) })) };
    const app = appWith();
    const response = await app.request("https://site.invalid/es/requests?id=" + "a".repeat(64), { headers }, { ...accessEnv, DB: db } as never);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("<form method=\"post\" action=\"/es/requests\">");
    expect(html).toContain("Error en la revisión");
    expect(html).not.toMatch(/<script\b/i);
  });

  it("stores script and attribute payloads but never renders the stored value", async () => {
    const first = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ n: 0 }).mockResolvedValueOnce({ n: 0 }).mockResolvedValueOnce({ count: 1 });
    const storedBindings: unknown[][] = [];
    const db = { prepare: vi.fn(() => ({ bind: (...values: unknown[]) => { storedBindings.push(values); return { first, run: async () => ({ meta: { changes: 1 } }) }; } })) };
    const app = appWith();
    const payload = `<script>alert(1)</script><img src=x onerror="alert(2)">`;
    const response = await app.request("https://site.invalid/en/requests", { method: "POST", headers: { ...headers, Origin: "https://site.invalid", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ text: payload }) }, { ...accessEnv, DB: db } as never);
    const html = await response.text();
    expect(response.status).toBe(303);
    expect(first).toHaveBeenCalled();
    expect(storedBindings.flat()).toContain(payload);
    expect(html).not.toContain(payload);
    expect(html).not.toContain("<script>");
  });

  it("denies empty service identities on GET and POST before any database call", async () => {
    for (const method of ["GET", "POST"]) {
      const { DB } = dbMock();
      const response = await appWith({ sub: "", serviceClientId: "test-service" }).request("https://site.invalid/en/requests", {
        method, headers: { ...headers, ...(method === "POST" ? { Origin: "https://site.invalid", "content-type": "application/x-www-form-urlencoded" } : {}) },
        ...(method === "POST" ? { body: "text=question" } : {}),
      }, { ...accessEnv, DB } as never);
      expect(response.status).toBe(403);
      expect(DB.prepare).not.toHaveBeenCalled();
    }
  });

  it("denies a missing identity before any database call", async () => {
    const { DB } = dbMock();
    const response = await appWith(null).request("https://site.invalid/en/requests", { headers }, { ...accessEnv, DB } as never);
    expect(response.status).toBe(403);
    expect(DB.prepare).not.toHaveBeenCalled();
  });

  it.each([
    ["cross-origin POST", { Origin: "https://attacker.invalid" }],
    ["POST with no Origin", {}],
  ])("denies %s before any database call", async (_name, extraHeaders) => {
    const { DB } = dbMock();
    const response = await appWith().request("https://site.invalid/en/requests", {
      method: "POST", headers: { ...headers, "content-type": "application/x-www-form-urlencoded", ...extraHeaders }, body: "text=question",
    }, { ...accessEnv, DB } as never);
    expect(response.status).toBe(403);
    expect(DB.prepare).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies from Content-Length and bounded streaming, while allowing exactly 8192 bytes", async () => {
    const declared = dbMock();
    const declaredBody = `text=q&pad=${"a".repeat(8200)}`;
    const declaredRequest = new Request("https://site.invalid/en/requests", {
      method: "POST", headers: { ...headers, Origin: "https://site.invalid", "content-type": "application/x-www-form-urlencoded", "content-length": String(new TextEncoder().encode(declaredBody).length) }, body: declaredBody,
    });
    expect(declaredRequest.headers.get("content-length")).toBe(String(new TextEncoder().encode(declaredBody).length));
    const declaredResponse = await appWith().fetch(declaredRequest, { ...accessEnv, DB: declared.DB } as never);
    expect(declaredResponse.status).toBe(413);
    expect(declared.DB.prepare).not.toHaveBeenCalled();

    const streamed = dbMock();
    const streamedBody = `text=q&pad=${"a".repeat(8200)}`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(streamedBody));
        controller.close();
      },
    });
    const streamResponse = await appWith().request("https://site.invalid/en/requests", {
      method: "POST", headers: { ...headers, Origin: "https://site.invalid", "content-type": "application/x-www-form-urlencoded" }, body: stream, duplex: "half",
    } as RequestInit & { duplex: "half" }, { ...accessEnv, DB: streamed.DB } as never);
    expect(streamResponse.status).toBe(413);
    expect(streamed.DB.prepare).not.toHaveBeenCalled();

    const boundary = dbMock();
    const boundaryBody = `text=q&pad=${"a".repeat(8181)}`; // 11-byte prefix plus 8181 bytes = 8192.
    expect(new TextEncoder().encode(boundaryBody)).toHaveLength(8192);
    const boundaryResponse = await appWith().fetch(new Request("https://site.invalid/en/requests", {
      method: "POST", headers: { ...headers, Origin: "https://site.invalid", "content-type": "application/x-www-form-urlencoded", "content-length": "8192" }, body: boundaryBody,
    }), { ...accessEnv, DB: boundary.DB } as never);
    expect(boundaryResponse.status).not.toBe(413);
    expect(boundary.DB.prepare).toHaveBeenCalled();
  });

  it.each([
    ["pending", "status", 20],
    ["daily", "substr(created_at", 10],
  ])("returns 429 at the %s limit", async (_name, queryMarker, count) => {
    const { DB } = dbMock((query) => query.startsWith("SELECT count(*)") && query.includes(queryMarker) ? { n: count } : query.startsWith("SELECT count(*)") ? { n: 0 } : null);
    const response = await appWith().request("https://site.invalid/en/requests", {
      method: "POST", headers: { ...headers, Origin: "https://site.invalid", "content-type": "application/x-www-form-urlencoded" }, body: "text=question",
    }, { ...accessEnv, DB } as never);
    expect(response.status).toBe(429);
    expect(DB.prepare).toHaveBeenCalled();
  });

  it.each([
    ["throw", (_query: string): never => { throw new Error("db unavailable"); }],
    ["null", (_query: string) => null],
    ["over budget", (_query: string) => ({ count: 1001 })],
  ])("returns 503 and never inserts when budget upsert is %s", async (_name, budgetResult) => {
    const queries: string[] = [];
    const DB = { prepare: vi.fn((query: string) => {
      queries.push(query);
      return { bind: () => ({ first: async () => query.includes("SELECT count(*)") ? { n: 0 } : query.includes("RETURNING count") ? budgetResult(query) : null, run: async () => ({ meta: { changes: 1 } }) }) };
    }) };
    const response = await appWith().request("https://site.invalid/en/requests", {
      method: "POST", headers: { ...headers, Origin: "https://site.invalid", "content-type": "application/x-www-form-urlencoded" }, body: "text=question",
    }, { ...accessEnv, DB } as never);
    expect(response.status).toBe(503);
    expect(queries.some((query) => query.startsWith("INSERT INTO question_requests"))).toBe(false);
  });

  it("rejects decoded question text over 2000 UTF-8 bytes with a localized page", async () => {
    const { DB } = dbMock();
    const body = new URLSearchParams({ text: "é".repeat(1001) }).toString();
    const response = await appWith().request("https://site.invalid/es/requests", {
      method: "POST", headers: { ...headers, Origin: "https://site.invalid", "content-type": "application/x-www-form-urlencoded" }, body,
    }, { ...accessEnv, DB } as never);
    expect(response.status).toBe(413);
    expect(await response.text()).toContain("Escribe una pregunta");
    expect(DB.prepare).not.toHaveBeenCalled();
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
