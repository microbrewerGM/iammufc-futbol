import { describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";

vi.mock("jose", async (importOriginal) => ({
  ...await importOriginal<typeof import("jose")>(),
  jwtVerify: vi.fn(async (token: string) => {
    if (token === "service-assertion") return { payload: { sub: "", type: "app", common_name: "0123456789abcdef0123456789abcdef.access" } };
    if (token === "owner-assertion") return { payload: { sub: "human", email: "owner@example.invalid" } };
    throw new Error("denied");
  }),
}));

import app from "../worker/src/index";

const serviceClientId = "0123456789abcdef0123456789abcdef.access";
const env = {
  ACCESS_ISSUER: "https://example.cloudflareaccess.com",
  ACCESS_AUD: "a".repeat(64),
  ACCESS_OWNER_EMAILS: "owner@example.invalid",
  ACCESS_SERVICE_CLIENT_IDS: serviceClientId,
  BRIDGE_CURSOR_KEY: "synthetic-cursor-key",
  BRIDGE_PUBLICATION_VERIFIER: { verify: async () => true },
  DB: {
    prepare: () => ({ bind() { return this; }, first: async () => null, all: async () => ({ results: [] }) }),
    batch: async () => [],
  },
} as unknown as Env;

const post = (token?: string) => app.request("https://site.invalid/internal/exploration-bridge/read", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(token ? { "cf-access-jwt-assertion": token } : {}),
  },
  body: JSON.stringify({ version: 1, kind: "read", payload: { cursor: null, limit: 5 } }),
}, env);

describe("mounted exploration bridge routes", () => {
  it("denies anonymous POST at the Access gate", async () => {
    const response = await post();
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Access denied.");
  });

  it("denies an authenticated human owner with 403", async () => {
    const response = await post("owner-assertion");
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).not.toContain("invalid_caller");
    expect(body).not.toContain("owner@example.invalid");
    expect(body).not.toContain("human");
  });

  it("routes a same-origin human POST to the router and rejects its caller", async () => {
    const response = await app.request("https://site.invalid/internal/exploration-bridge/read", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": "owner-assertion", Origin: "https://site.invalid", "content-type": "application/json" },
      body: JSON.stringify({ version: 1, kind: "read", payload: { cursor: null, limit: 5 } }),
    }, env);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "invalid_caller" });
  });

  it("allows a configured service identity through Access and into the router without browser Origin", async () => {
    const all = vi.fn(async () => ({ results: [] }));
    const serviceEnv = { ...env, DB: { prepare: () => ({ bind() { return this; }, first: async () => null, all }), batch: async () => [] } } as unknown as Env;
    const response = await app.request("https://site.invalid/internal/exploration-bridge/read", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": "service-assertion", "content-type": "application/json" },
      body: JSON.stringify({ version: 1, kind: "read", payload: { cursor: null, limit: 5 } }),
    }, serviceEnv);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: 1, kind: "read_result", payload: { jobs: [], next_cursor: null } });
    expect(all).toHaveBeenCalledOnce();
  });
});
