import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, QuestionHistoryEntry } from "../worker/src/core/db";
import type { QueryIntent } from "../worker/src/core/intent";

vi.mock("jose", async (original) => ({
  ...await original<typeof import("jose")>(),
  jwtVerify: vi.fn(async (token: string) => {
    if (token === "synthetic-service") {
      return { payload: { sub: "", type: "app", common_name: "synthetic-service-id" } };
    }
    if (token !== "synthetic") throw new Error("denied");
    return { payload: { sub: "account-subject", email: "owner@example.invalid" } };
  }),
}));

vi.mock("../worker/src/core/db", async (original) => ({
  ...await original<typeof import("../worker/src/core/db")>(),
  currentSnapshot: vi.fn(async () => "synthetic"),
  logQueryAggregate: vi.fn(async () => {}),
  allPlayerNames: vi.fn(async () => []),
  readQueryCache: vi.fn(async (_env: Env, _key: string, snapshot: string | null, intent: QueryIntent) => ({
    result: { rows: [], snapshot_id: snapshot, unit: intent.metric },
    outcome: "hit" as const,
  })),
  saveQuestionHistory: vi.fn(async () => {}),
  listQuestionHistory: vi.fn(async () => []),
  clearQuestionHistory: vi.fn(async () => {}),
}));

import app from "../worker/src/index";
import { clearQuestionHistory, listQuestionHistory, saveQuestionHistory } from "../worker/src/core/db";

const env = {
  ACCESS_ISSUER: "https://example.cloudflareaccess.com",
  ACCESS_AUD: "a".repeat(64),
  ACCESS_OWNER_EMAILS: "owner@example.invalid",
  ACCESS_SERVICE_CLIENT_IDS: "synthetic-service-id",
} as Env;

function request(path: string, init: RequestInit = {}) {
  return app.request(`https://site.invalid${path}`, {
    ...init,
    headers: {
      "cf-access-jwt-assertion": "synthetic",
      ...(init.method === "POST" ? { Origin: "https://site.invalid", "content-type": "application/x-www-form-urlencoded" } : {}),
      ...init.headers,
    },
  }, env);
}

beforeEach(() => vi.clearAllMocks());

describe("account question history routes", () => {
  it.each(["en", "es"])("keeps service identities out of %s account history", async (locale) => {
    const headers = { "cf-access-jwt-assertion": "synthetic-service" };
    const history = await request(`/${locale}/history`, { headers });
    expect(history.status).toBe(200);
    expect(history.headers.get("cache-control")).toBe("private, no-store");
    expect(listQuestionHistory).not.toHaveBeenCalled();

    const clear = await request(`/${locale}/history/clear`, { method: "POST", headers, body: "" });
    expect(clear.status).toBe(303);
    expect(clearQuestionHistory).not.toHaveBeenCalled();

    const answer = await request(`/${locale}/ask`, {
      method: "POST", headers,
      body: new URLSearchParams({ q: "Top goals 2024-25" }).toString(),
    });
    expect(answer.status).toBe(200);
    expect(saveQuestionHistory).not.toHaveBeenCalled();
  });

  it.each(["en", "es"])("rejects cross-origin %s history clearing before mutation", async (locale) => {
    const response = await request(`/${locale}/history/clear`, {
      method: "POST",
      headers: { Origin: "https://other.invalid" },
      body: "",
    });
    expect(response.status).toBe(403);
    expect(clearQuestionHistory).not.toHaveBeenCalled();
  });

  it.each([
    ["/en/ask", "Top goals in the Premier League 2024-25", "goals", "bar"],
    ["/en/ask", "Top assists 2023-24", "assists", "bar"],
    ["/en/ask", "Expected goals 2025-26", "xg", "bar"],
    ["/en/ask", "Show me a goals shot map for 2024-25", "goals", "shot_map"],
    ["/es/ask", "Máximos goles en la Premier League 2024-25", "goals", "bar"],
    ["/es/ask", "Máximas asistencias 2023-24", "assists", "bar"],
    ["/es/ask", "Goles esperados 2025-26", "xg", "bar"],
    ["/es/ask", "Muéstrame un mapa de tiros de goles para 2024-25", "goals", "shot_map"],
  ] as const)("stores a validated manual question including coverage-dependent requests: %s / %s", async (path, question, metric, viz) => {
    const response = await request(path, {
      method: "POST",
      body: new URLSearchParams({ q: question }).toString(),
    });
    expect(response.status).toBe(200);
    expect(saveQuestionHistory).toHaveBeenCalledOnce();
    expect(vi.mocked(saveQuestionHistory).mock.calls[0]?.[3]).toMatchObject({ metric, viz });
  });

  it.each([
    ["/en/ask", "Show me a goals shot map for 2024-25"],
    ["/es/ask", "Muéstrame un mapa de tiros de goles para 2024-25"],
  ])("stores a high-confidence validated %s ask under verified subject", async (path, question) => {
    const response = await request(path, {
      method: "POST",
      body: new URLSearchParams({ q: question }).toString(),
    });
    expect(response.status).toBe(200);
    expect(await response.clone().text()).toContain("no_data");
    expect(saveQuestionHistory).toHaveBeenCalledOnce();
    expect(vi.mocked(saveQuestionHistory).mock.calls[0]?.slice(1)).toMatchObject([
      "account-subject", question, expect.objectContaining({ metric: "goals", viz: "shot_map" }), path.startsWith("/es") ? "es" : "en",
    ]);
    const html = await response.text();
    expect(html).toContain(path.startsWith("/es") ? "/es/history" : "/en/history");
  });

  it("renders saved items as replay links and clears only the authenticated account", async () => {
    const item: QuestionHistoryEntry = {
      id: 7,
      question: "Top goals 2024-25",
      visualizationPath: "/en/q?metric=goals&entity_type=player&entity_id=all&season=2024-25&competition=PL&viz=bar&limit=10",
      locale: "en",
      createdAt: "2026-10-19T00:00:00.000Z",
    };
    vi.mocked(listQuestionHistory).mockResolvedValueOnce([item]);
    const page = await request("/en/history");
    expect(page.headers.get("cache-control")).toBe("private, no-store");
    expect((await page.text())).toContain(item.visualizationPath.replaceAll("&", "&amp;"));
    expect(listQuestionHistory).toHaveBeenCalledWith(env, "account-subject");

    const spanishPage = await request("/es/history");
    expect(spanishPage.headers.get("cache-control")).toBe("private, no-store");

    const clear = await request("/en/history/clear", { method: "POST", body: "" });
    expect(clear.status).toBe(303);
    expect(clear.headers.get("location")).toBe("/en/history");
    expect(clearQuestionHistory).toHaveBeenCalledWith(env, "account-subject");
  });
});
