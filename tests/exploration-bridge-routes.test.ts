import { describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";
import { Hono } from "hono";
import { createExplorationBridgeRouter } from "../worker/src/routes/exploration-bridge";
import type { ExplorationBridgeEnv } from "../worker/src/routes/exploration-bridge";

vi.mock("jose", async (importOriginal) => ({
  ...await importOriginal<typeof import("jose")>(),
  jwtVerify: vi.fn(async (token: string, _keys: unknown, options: { issuer?: string; audience?: string }) => {
    if (options?.issuer !== "https://example.cloudflareaccess.com" || options?.audience !== "a".repeat(64)) throw new Error("denied");
    if (token === "service-assertion") return { payload: { sub: "", type: "app", common_name: "0123456789abcdef0123456789abcdef.access" } };
    if (token === "alpha.beta") return { payload: { sub: "", type: "app", common_name: "alpha.beta" } };
    if (token === "alpha_beta") return { payload: { sub: "", type: "app", common_name: "alpha_beta" } };
    if (token === "Alpha.beta") return { payload: { sub: "", type: "app", common_name: "Alpha.beta" } };
    if (token === "other.service") return { payload: { sub: "", type: "app", common_name: "other.service" } };
    if (token === "unlisted.service") return { payload: { sub: "", type: "app", common_name: "unlisted.service" } };
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

  it("denies colliding underscore ids while allowing dotted ids after mapping", async () => {
    const collisionEnv = { ...env, ACCESS_SERVICE_CLIENT_IDS: "alpha.beta,alpha_beta" } as Env;
    const dotted = await app.request("https://site.invalid/internal/exploration-bridge/read", {
      method: "POST", headers: { "cf-access-jwt-assertion": "alpha.beta", "content-type": "application/json" },
      body: JSON.stringify({ version: 1, kind: "read", payload: { cursor: null, limit: 5 } }),
    }, { ...collisionEnv, ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64) } as Env);
    expect(dotted.status).toBe(200);
    expect(await dotted.json()).toEqual({ version: 1, kind: "read_result", payload: { jobs: [], next_cursor: null } });

    const underscored = await app.request("https://site.invalid/internal/exploration-bridge/read", {
      method: "POST", headers: { "cf-access-jwt-assertion": "alpha_beta", "content-type": "application/json" },
      body: JSON.stringify({ version: 1, kind: "read", payload: { cursor: null, limit: 5 } }),
    }, { ...collisionEnv, ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64) } as Env);
    expect(underscored.status).toBe(403);
    expect(await underscored.json()).toEqual({ error: "invalid_caller" });
  });

  it("denies an unlisted service id at the full-app Access gate without exposing internals", async () => {
    for (const [token, allowlist] of [["Alpha.beta", "Alpha.beta"], ["unlisted.service", serviceClientId]] as const) {
      const response = await app.request("https://site.invalid/internal/exploration-bridge/read", {
        method: "POST", headers: { "cf-access-jwt-assertion": token, "content-type": "application/json" },
        body: JSON.stringify({ version: 1, kind: "read", payload: { cursor: null, limit: 5 } }),
      }, { ...env, ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64), ACCESS_SERVICE_CLIENT_IDS: allowlist } as Env);
      expect(response.status).toBe(403);
      const body = await response.text();
      expect(body).not.toContain("unlisted.service");
      expect(body).not.toContain("Alpha.beta");
      expect(body).not.toContain("ACCESS_SERVICE_CLIENT_IDS");
      if (token === "unlisted.service") expect(body).toBe("Access denied.");
    }
  });

  it("returns router JSON invalid_caller for uppercase and underscore ids after identity injection", async () => {
    const routerApp = new Hono<ExplorationBridgeEnv>();
    routerApp.use("*", async (c, next) => {
      c.set("accessIdentity", { sub: "", serviceClientId: c.req.header("x-service-id") ?? "" });
      await next();
    });
    routerApp.route("/internal/exploration-bridge", createExplorationBridgeRouter());

    for (const serviceId of ["Alpha.beta", "alpha_beta"]) {
      const response = await routerApp.request("https://site.invalid/internal/exploration-bridge/read", {
        method: "POST",
        headers: { "x-service-id": serviceId, "content-type": "application/json" },
        body: JSON.stringify({ version: 1, kind: "read", payload: { cursor: null, limit: 5 } }),
      }, env);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "invalid_caller" });
    }
  });

  it("denies forged Access headers without a valid assertion", async () => {
    const response = await app.request("https://site.invalid/internal/exploration-bridge/read", {
      method: "POST", headers: { "cf-access-client-id": serviceClientId, "cf-access-client-secret": "forged", "content-type": "application/json" },
      body: JSON.stringify({ version: 1, kind: "read", payload: { cursor: null, limit: 5 } }),
    }, env);
    expect(response.status).toBe(403);
  });

  it("checks the caller before rejecting an oversized body", async () => {
    const response = await app.request("https://site.invalid/internal/exploration-bridge/read", {
      method: "POST", headers: { "cf-access-jwt-assertion": "service-assertion", "content-length": "70000" }, body: "x",
    }, env);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "too_large" });
  });

  it("does not shadow other internal paths or existing site routes", async () => {
    const other = await app.request("https://site.invalid/internal/exploration-bridge/other", { method: "GET", headers: { "cf-access-jwt-assertion": "service-assertion" } }, env);
    expect(other.status).toBe(404);
    const site = await app.request("https://site.invalid/en", { method: "GET", headers: { "cf-access-jwt-assertion": "owner-assertion" } }, env);
    expect(site.status).toBe(200);
  });
});
