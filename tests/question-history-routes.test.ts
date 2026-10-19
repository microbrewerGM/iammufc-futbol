import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, QuestionHistoryEntry } from "../worker/src/core/db";
import type { QueryIntent } from "../worker/src/core/intent";

vi.mock("jose", async (original) => ({
  ...await original<typeof import("jose")>(),
  jwtVerify: vi.fn(async (token: string) => {
    if (token === "synthetic-service") {
      return { payload: { sub: "", type: "app", common_name: "synthetic-service-id" } };
    }
    if (token === "synthetic-other") {
      return { payload: { sub: "other-subject", email: "owner@example.invalid" } };
    }
    if (!["synthetic", "synthetic-session-two"].includes(token)) throw new Error("denied");
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
import { currentSnapshot, clearQuestionHistory, listQuestionHistory, logQueryAggregate, saveQuestionHistory } from "../worker/src/core/db";

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(saveQuestionHistory).mockReset().mockResolvedValue(undefined);
  vi.mocked(listQuestionHistory).mockReset().mockResolvedValue([]);
  vi.mocked(clearQuestionHistory).mockReset().mockResolvedValue(undefined);
  vi.mocked(currentSnapshot).mockResolvedValue("synthetic");
});

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

  it.each(["en", "es"])("escapes stored question text in %s history", async (locale) => {
    const question = '<img src=x onerror="alert(1)"><script>alert(2)</script>&\'"';
    vi.mocked(listQuestionHistory).mockResolvedValueOnce([{
      id: 1, question, visualizationPath: `/${locale}/q?metric=goals&season=2024-25`,
      locale: locale as "en" | "es", createdAt: "2026-10-19T00:00:00Z",
    }]);
    const response = await request(`/${locale}/history`);
    const markup = await response.text();
    expect(response.status).toBe(200);
    expect(markup).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;&amp;&#39;&quot;');
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<script");
  });

  it.each(["en", "es"])("replays the actual canonical saved %s intent against current coverage without saving again", async (locale) => {
    const actual = await vi.importActual<typeof import("../worker/src/core/db")>("../worker/src/core/db");
    let savedPath = "";
    // Capture bindings at the real persistence boundary: the production helper,
    // rather than a test-side URL serializer, constructs the canonical link.
    const captureEnv = {
      ...env,
      DB: {
        prepare: () => ({ bind: (...values: unknown[]) => {
          if (values.length === 5) savedPath = String(values[2]);
          return {};
        } }),
        batch: async () => [],
      } as unknown as D1Database,
    };
    vi.mocked(saveQuestionHistory).mockImplementation(async (_env, subject, question, intent, code) => {
      await actual.saveQuestionHistory(captureEnv, subject, question, intent, code);
    });
    const ask = await request(`/${locale}/ask`, {
      method: "POST", body: new URLSearchParams({ q: "Show me a goals shot map for 2024-25" }).toString(),
    });
    expect(ask.status).toBe(200);
    const savedIntent = vi.mocked(saveQuestionHistory).mock.calls[0]![3];
    expect(savedPath).toMatch(new RegExp(`^/${locale}/q\\?`));
    vi.mocked(listQuestionHistory).mockResolvedValueOnce([{
      id: 1, question: "Shot map", visualizationPath: savedPath,
      locale: locale as "en" | "es", createdAt: "2026-10-19T00:00:00Z",
    }]);
    const history = await request(`/${locale}/history`);
    const historyMarkup = await history.text();
    const renderedLink = historyMarkup.match(/href="([^" ]*\/q\?[^" ]+)"/)?.[1]?.replaceAll("&amp;", "&");
    expect(renderedLink).toBe(savedPath);
    vi.mocked(currentSnapshot).mockClear().mockResolvedValue("new-publication");
    const replay = await request(renderedLink!, { headers: { "Sec-Fetch-Site": "same-origin" } });
    expect(replay.status).toBe(200);
    expect(await replay.text()).toContain("no_data");
    expect(logQueryAggregate).toHaveBeenLastCalledWith(
      env, savedIntent, "no_data", "not_applicable", "refused", locale, "query_page",
    );
    expect(currentSnapshot).toHaveBeenCalledExactlyOnceWith(env);
    expect(saveQuestionHistory).toHaveBeenCalledOnce();
  });

  it("uses verified subjects across separate sessions and isolates another human's read and clear", async () => {
    const accounts = new Map<string, QuestionHistoryEntry[]>();
    vi.mocked(saveQuestionHistory).mockImplementation(async (_env, subject, question, _intent, locale) => {
      accounts.set(subject, [{ id: 1, question, visualizationPath: `/${locale}/q?metric=goals&season=2024-25`, locale, createdAt: "2026-10-19T00:00:00Z" }]);
    });
    vi.mocked(listQuestionHistory).mockImplementation(async (_env, subject) => accounts.get(subject) ?? []);
    vi.mocked(clearQuestionHistory).mockImplementation(async (_env, subject) => { accounts.delete(subject); });
    const question = "Top goals 2024-25";
    const ask = await request("/en/ask", { method: "POST", body: new URLSearchParams({ q: question }).toString() });
    expect(ask.status).toBe(200);
    const secondSession = { "cf-access-jwt-assertion": "synthetic-session-two" };
    const otherSession = { "cf-access-jwt-assertion": "synthetic-other" };
    const reopened = await request("/en/history", { headers: secondSession });
    expect(await reopened.text()).toContain(question);
    expect(listQuestionHistory).toHaveBeenLastCalledWith(env, "account-subject");
    const other = await request("/en/history", { headers: otherSession });
    expect(await other.text()).not.toContain(question);
    expect(listQuestionHistory).toHaveBeenLastCalledWith(env, "other-subject");
    const otherClear = await request("/en/history/clear", { method: "POST", headers: otherSession });
    expect(otherClear.status).toBe(303);
    expect(clearQuestionHistory).toHaveBeenLastCalledWith(env, "other-subject");
    expect(await (await request("/en/history", { headers: secondSession })).text()).toContain(question);
    await request("/en/history/clear", { method: "POST", headers: secondSession });
    expect(clearQuestionHistory).toHaveBeenLastCalledWith(env, "account-subject");
    expect(await (await request("/en/history")).text()).not.toContain(question);
  });

});
