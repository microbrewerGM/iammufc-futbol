import { beforeEach, describe, expect, it, vi } from "vitest";
import { Catalog, type CompiledCatalog } from "../worker/src/core/feasibility";
import { withDefaults } from "../worker/src/core/intent";
import { LOCALES } from "../worker/src/core/locale";
import type { Env } from "../worker/src/core/db";
import { resultPanel } from "../worker/src/views/pages";
import compiled from "../worker/src/generated/catalog.json";

vi.mock("jose", async (original) => ({
  ...await original<typeof import("jose")>(),
  jwtVerify: vi.fn(async (token: string) => {
    if (token !== "synthetic") throw new Error("denied");
    return { payload: { sub: "owner", email: "owner@example.invalid" } };
  }),
}));

vi.mock("../worker/src/core/db", async (original) => ({
  ...await original<typeof import("../worker/src/core/db")>(),
  currentSnapshot: vi.fn(async () => "synthetic"),
  logDemand: vi.fn(async () => {}),
  enforceBudget: vi.fn(async () => true),
  allPlayerNames: vi.fn(async () => ["Rashford", "Fernandes", "Bruno Fernandes"]),
  runQuery: vi.fn(async (_env: unknown, intent: { entity_type: string }) => ({
    rows:
      intent.entity_type === "season"
        ? [{ label: "2024-25", value: 72, secondary: "22W 6D 10L" }]
        : [{ label: "Synthetic", value: 2 }],
    snapshot_id: "synthetic",
    unit: "goals",
  })),
}));

import app from "../worker/src/index";
import {
  allPlayerNames,
  currentSnapshot,
  enforceBudget,
  logDemand,
  runQuery,
} from "../worker/src/core/db";

const env = {
  ACCESS_ISSUER: "https://example.cloudflareaccess.com",
  ACCESS_AUD: "a".repeat(64),
  ACCESS_OWNER_EMAILS: "owner@example.invalid",
} as Env;
const auth = { "cf-access-jwt-assertion": "synthetic", Origin: "https://site.invalid" };
const base = {
  metric: "goals",
  season: "2024-25",
  entity_type: "player",
  entity_id: "all",
  competition: "PL",
  viz: "bar",
  limit: 10,
} as const;
const catalog = new Catalog(compiled as unknown as CompiledCatalog);

async function post(path: string, body: unknown) {
  return app.request(
    `https://site.invalid${path}`,
    {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("honest query contract routes", () => {
  it.each([
    null,
    [],
    "query",
    5,
    { ...base, dimensions: 4 },
    { ...base, filters: null },
    { ...base, filters: { position: 8 } },
    { ...base, dimensions: [5] },
    { ...base, entity_id: 6 },
    { ...base, entity_type: "anything" },
    { ...base, viz: "pie" },
    { ...base, limit: 0 },
    { ...base, limit: 1.5 },
    { ...base, limit: "5" },
    { ...base, season: null },
    { ...base, competition: "" },
    { ...base, unexpected: "payload" },
  ])("rejects malformed API shape before data access: %j", async (body) => {
    expect((await post("/api/query", body)).status).toBe(400);
    expect(currentSnapshot).not.toHaveBeenCalled();
    expect(logDemand).not.toHaveBeenCalled();
    expect(enforceBudget).not.toHaveBeenCalled();
    expect(runQuery).not.toHaveBeenCalled();
  });

  it.each([
    { ...base, filters: { position: "GK" } },
    { ...base, dimensions: ["position"] },
    { ...base, entity_type: "season", entity_id: "Rashford" },
  ])("refuses unsupported semantics before hashing: %j", async (body) => {
    expect((await post("/api/query", body)).status).toBe(422);
    expect(currentSnapshot).not.toHaveBeenCalled();
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("checks execution support only after a positive feasibility result", async () => {
    expect((await post("/api/query", { ...base, viz: "line" })).status).toBe(422);
    expect(enforceBudget).not.toHaveBeenCalled();
    expect(runQuery).not.toHaveBeenCalled();

    const event = await post("/api/query", { ...base, viz: "shot_map" });
    expect(event.status).toBe(200);
    expect((await event.json() as { feasibility: { state: string } }).feasibility.state).toBe("no_data");

    const deferred = vi.spyOn(Catalog.prototype, "checkFeasibility").mockReturnValue({
      state: "computable_but_expensive",
      reason: "Synthetic deferral",
      cost_class: "expensive",
    });
    expect((await post("/api/query", base)).status).toBe(200);
    deferred.mockRestore();
    expect(enforceBudget).not.toHaveBeenCalled();
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("executes supported values without dropping entity, competition, or limit", async () => {
    const input = { ...base, limit: 3 };
    const response = await post("/api/query", input);
    expect(response.status).toBe(200);
    expect((await response.json() as { rows: unknown[] }).rows).toEqual([
      { label: "Synthetic", value: 2 },
    ]);
    expect(runQuery).toHaveBeenCalledWith(env, withDefaults(input));
  });

  it.each([null, [], "question", 5, {}, { question: 55 }, { question: " " }])(
    "rejects malformed chat input before names or AI: %j",
    async (body) => {
      expect((await post("/api/chat", body)).status).toBe(400);
      expect(allPlayerNames).not.toHaveBeenCalled();
    },
  );

  it("surfaces a finite model status on chat proposals", async () => {
    const response = await post("/api/chat", { question: "Top goals 2024-25" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      source: "rules",
      model_status: "not_configured",
      confidence: "high",
    });

    const degradedEnv = {
      ...env,
      AI: { run: async () => { throw new Error("synthetic-provider-detail"); } },
    } as unknown as Env;
    const degraded = await app.request(
      "https://site.invalid/api/chat",
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ question: "Top goals 2024-25" }),
      },
      degradedEnv,
    );
    const body = await degraded.json() as { model_status: string; notes: string[] };
    expect(body.model_status).toBe("provider_error");
    expect(body.notes).toContain("AI proposal unavailable (provider_error); using rules.");
    expect(JSON.stringify(body)).not.toContain("synthetic-provider-detail");
  });

  it("does not let AI change a deterministically requested competition", async () => {
    const changedCompetitionEnv = {
      ...env,
      AI: { run: async () => ({ response: JSON.stringify({ ...base, competition: "PL" }) }) },
    } as unknown as Env;
    const response = await app.request(
      "https://site.invalid/api/chat",
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ question: "Top goals 2024-25 Champions League" }),
      },
      changedCompetitionEnv,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      source: "rules",
      model_status: "unsupported_intent",
      proposed_intent: { competition: "CL" },
    });
  });

  it("does not let AI replace an explicitly quoted player", async () => {
    const changedIdentityEnv = {
      ...env,
      AI: {
        run: async () => ({
          response: JSON.stringify({ ...base, entity_id: "Guessed Player" }),
        }),
      },
    } as unknown as Env;
    const response = await app.request(
      "https://site.invalid/api/chat",
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ question: '\"Rashford\" goals 2024-25' }),
      },
      changedIdentityEnv,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      source: "rules",
      model_status: "unsupported_intent",
      proposed_intent: { entity_id: "Rashford" },
    });
  });

  it("does not execute an ambiguous ask proposal", async () => {
    const run = vi.fn(async () => ({ response: "{}" }));
    const response = await app.request(
      "https://site.invalid/en/ask",
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ q: "Most assists" }).toString(),
      },
      { ...env, AI: { run } } as unknown as Env,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("ambiguous and has not been run");
    expect(currentSnapshot).not.toHaveBeenCalled();
    expect(logDemand).not.toHaveBeenCalled();
    expect(enforceBudget).not.toHaveBeenCalled();
    expect(runQuery).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("does not let the model guess an overlapping player alias", async () => {
    const run = vi.fn(async () => ({ response: JSON.stringify(base) }));
    const response = await app.request(
      "https://site.invalid/en/ask",
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ q: "Fernandes goals 2024-25" }).toString(),
      },
      { ...env, AI: { run } } as unknown as Env,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Player identity is ambiguous.");
    expect(run).not.toHaveBeenCalled();
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("refuses unsupported semantics before model inference", async () => {
    const run = vi.fn(async () => ({ response: JSON.stringify(base) }));
    const response = await app.request(
      "https://site.invalid/api/chat",
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ question: "Top goals per 90 2024-25" }),
      },
      { ...env, AI: { run } } as unknown as Env,
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      rejected: true,
      code: "unsupported_semantics",
      proposed_intent: null,
    });
    expect(run).not.toHaveBeenCalled();
    expect(runQuery).not.toHaveBeenCalled();
  });

  it.each([
    "?viz=pie",
    "?limit=2.5",
    "?limit=-1",
    "?limit=51",
    "?metric=goals&metric=assists",
    "?filters=position",
    "?dimensions=position",
  ])("refuses malformed direct parameters %s", async (query) => {
    const response = await app.request(`https://site.invalid/en/q${query}`, { headers: auth }, env);
    expect(response.status).toBe(400);
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("preserves supported direct parameters and returns controlled execution errors", async () => {
    const supported = await app.request(
      "https://site.invalid/es/q?metric=goals&entity_type=player&entity_id=all&season=2024-25&competition=PL&viz=bar&limit=3",
      { headers: auth },
      env,
    );
    expect(supported.status).toBe(200);
    expect(runQuery).toHaveBeenCalledWith(env, withDefaults({ ...base, limit: 3 }));

    vi.clearAllMocks();
    const unsupported = await app.request(
      "https://site.invalid/en/q?metric=goals&entity_type=player&entity_id=all&season=2024-25&competition=PL&viz=line&limit=3",
      { headers: auth },
      env,
    );
    expect(unsupported.status).toBe(422);
    expect(await unsupported.text()).toContain("Unsupported query field: viz.");
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("renders supported season results as seasons in both locales", async () => {
    for (const locale of ["en", "es"]) {
      const response = await app.request(
        `https://site.invalid/${locale}/q?metric=goals&entity_type=season&entity_id=all&season=2024-25&competition=PL&viz=table&limit=3`,
        { headers: auth },
        env,
      );
      expect(response.status).toBe(200);
      const markup = await response.text();
      expect(markup).toContain(locale === "es" ? "Temporada" : "Season");
      expect(markup).toContain(locale === "es" ? "Balance" : "Record");
      expect(markup).toContain(`href="/${locale}/season/2024-25"`);
      expect(markup).not.toContain(`href="/${locale}/player/2024-25`);
    }
  });

  it("preserves every supported field in a nearest-alternative form", () => {
    const alternative = withDefaults({
      metric: "goals",
      entity_type: "season",
      entity_id: "all",
      season: "2023-24",
      competition: "CL",
      viz: "table",
      limit: 7,
    });
    const markup = resultPanel(
      withDefaults(base),
      {
        state: "no_data",
        reason: "Synthetic refusal",
        cost_class: "cheap",
        nearest_alternative: alternative,
      },
      [],
      catalog,
      "synthetic",
      LOCALES.en,
    );
    for (const field of [
      'name="entity_type" value="season"',
      'name="competition" value="CL"',
      'name="limit" value="7"',
    ]) {
      expect(markup).toContain(field);
    }
  });

  it("keeps authentication and private error handling in front of the new contract", async () => {
    for (const token of [undefined, "forged"]) {
      const response = await app.request(
        "https://site.invalid/api/query",
        {
          method: "POST",
          headers: token
            ? { "cf-access-jwt-assertion": token, Origin: "https://site.invalid", "content-type": "application/json" }
            : { Origin: "https://site.invalid", "content-type": "application/json" },
          body: JSON.stringify(base),
        },
        env,
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(runQuery).not.toHaveBeenCalled();
  });
});
