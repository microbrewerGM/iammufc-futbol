import { describe, expect, it, vi } from "vitest";
// @ts-expect-error The project omits Node typings; Vitest runs this test in Node.
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import app from "../worker/src/index";
import type { Env } from "../worker/src/core/db";
import { accessGate, accessIdentity, isProtectedGetPath, type AccessEnv, verifyAccess } from "../worker/src/security/auth";

function setup() {
  const env = {
    ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    ACCESS_AUD: "a".repeat(64),
    ACCESS_OWNER_EMAILS: "owner@example.invalid",
  } as unknown as Env;
  const verifier = vi.fn(async (token: string, _config: unknown) => {
    if (token !== "verified-by-test") throw new Error("denied");
    return { sub: "test-owner", email: "owner@example.invalid" };
  });
  const application = new Hono<{ Bindings: Env }>();
  application.use("*", accessGate(verifier));
  application.all("*", (c) => c.text("protected"));
  const request = (path: string, init: RequestInit = {}) => application.request(`https://site.invalid${path}`, {
    ...init, headers: { "cf-access-jwt-assertion": "verified-by-test", ...init.headers },
  }, env);
  return { request, verifier, env };
}

describe("Cloudflare Access boundary", () => {
  it("disables services by default and passes only valid exact configured IDs", async () => {
    const { request, verifier, env } = setup();
    expect((await request("/en")).status).toBe(200);
    expect(verifier.mock.calls[0]?.[1]).toMatchObject({ serviceClientIds: [] });
    env.ACCESS_SERVICE_CLIENT_IDS = " synthetic-dev.access,second.access ";
    expect((await request("/en")).status).toBe(200);
    expect(verifier.mock.calls[1]?.[1]).toMatchObject({ serviceClientIds: ["synthetic-dev.access", "second.access"] });
    for (const value of ["*", "valid.access,", "has space", "   ", "a".repeat(257)]) {
      env.ACCESS_SERVICE_CLIENT_IDS = value;
      expect((await request("/en")).status).toBe(503);
    }
    expect(verifier).toHaveBeenCalledTimes(2);
  });

  it("does not treat raw service headers as an authorization assertion", async () => {
    const { request, env } = setup();
    env.ACCESS_SERVICE_CLIENT_IDS = "synthetic-dev.access";
    expect((await request("/en", { headers: {
      "cf-access-jwt-assertion": "", "CF-Access-Client-Id": "synthetic-dev.access",
      "CF-Access-Client-Secret": "synthetic-not-a-credential",
    } })).status).toBe(403);
  });

  it("fails closed for every route when Access configuration is absent", async () => {
    for (const path of ["/en", "/es", "/api/chat", "/api/query", "/api/health", "/sitemap.xml", "/robots.txt", "/style.css", "/", "/new-asset.bin"]) {
      const res = await app.request(`https://site.invalid${path}`, {}, {});
      expect(res.status).toBe(503);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
      expect(await res.text()).not.toContain("snapshot");
    }
  });

  it("denies a missing or forged Access assertion before protected routes", async () => {
    const { request, verifier } = setup();
    for (const path of ["/en", "/api/health", "/style.css", "/unknown"]) {
      expect((await request(path, { headers: { "cf-access-jwt-assertion": "forged" } })).status).toBe(403);
    }
    expect(verifier).toHaveBeenCalledTimes(4);
  });

  it("allows every method only after the verified Access assertion", async () => {
    const { request } = setup();
    for (const init of [{}, { method: "POST", headers: { Origin: "https://site.invalid" } }, { method: "DELETE", headers: { Origin: "https://site.invalid" } }]) {
      const res = await request("/protected", init);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("protected");
      expect(res.headers.get("Set-Cookie")).toBeNull();
    }
  });

  it("makes only the verified identity available to protected handlers", async () => {
    const env = {
      ACCESS_ISSUER: "https://example.cloudflareaccess.com",
      ACCESS_AUD: "a".repeat(64),
      ACCESS_OWNER_EMAILS: "owner@example.invalid",
      ACCESS_SERVICE_CLIENT_IDS: "test-service",
    } as unknown as Env;
    const humanApp = new Hono<AccessEnv>();
    humanApp.use("*", accessGate(async () => ({ sub: "stable-human-sub", email: "owner@example.invalid" })));
    humanApp.get("/", (c) => c.json({ ...accessIdentity(c) }));
    const human = await humanApp.request("https://site.invalid/", {}, env);
    expect(await human.json()).toEqual({ sub: "stable-human-sub", email: "owner@example.invalid" });

    const serviceApp = new Hono<AccessEnv>();
    serviceApp.use("*", accessGate(async () => ({ sub: "", serviceClientId: "test-service" })));
    serviceApp.get("/", (c) => c.json({ ...accessIdentity(c) }));
    const service = await serviceApp.request("https://site.invalid/", {}, env);
    const serviceIdentity = await service.json() as { sub: string; email?: string; serviceClientId?: string };
    expect(serviceIdentity).toEqual({ sub: "", serviceClientId: "test-service" });
    expect(serviceIdentity.sub).toBe("");
    expect(serviceIdentity.email).toBeUndefined();
  });

  it("rejects unsafe requests without exact same-origin HTTPS proof", async () => {
    const { request } = setup();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const origin of [undefined, "null", "https://foreign.invalid", "http://site.invalid", "https://site.invalid/", "https://site.invalid.evil.test"]) {
        const res = await request("/protected", { method, headers: origin ? { Origin: origin } : {} });
        expect(res.status, `${method} ${origin}`).toBe(403);
      }
    }
  });

  it("skips Origin only for verified service POSTs without the Access browser cookie", async () => {
    const env = {
      ACCESS_ISSUER: "https://example.cloudflareaccess.com",
      ACCESS_AUD: "a".repeat(64),
      ACCESS_OWNER_EMAILS: "owner@example.invalid",
      ACCESS_SERVICE_CLIENT_IDS: "test-service",
    } as unknown as Env;
    const serviceApp = new Hono<AccessEnv>();
    serviceApp.use("*", accessGate(async (token) => {
      if (token !== "verified-service") throw new Error("denied");
      return { sub: "", serviceClientId: "test-service" };
    }));
    serviceApp.all("*", (c) => c.text("protected"));
    const request = (headers: Record<string, string>) => serviceApp.request("https://site.invalid/en/ask", {
      method: "POST", headers: { "cf-access-jwt-assertion": "verified-service", ...headers },
    }, env);

    expect((await request({})).status).toBe(200);
    expect((await request({ Cookie: "CF_Authorization=browser-session" })).status).toBe(403);
    expect((await request({ Cookie: "other=value; CF_Authorization=browser-session" })).status).toBe(403);
    expect((await request({ Cookie: "cf_authorization=browser-session" })).status).toBe(403);
    expect((await request({ Cookie: "  CF_Authorization  =browser-session" })).status).toBe(403);
    expect((await request({ Cookie: "CF_AppSession=browser-session" })).status).toBe(403);
    expect((await request({ Cookie: "other=value; another=value; CF_Authorization=browser-session" })).status).toBe(403);
    expect((await request({ Origin: "https://foreign.invalid" })).status).toBe(200);
    expect((await request({ "cf-access-jwt-assertion": "forged" })).status).toBe(403);
  });

  it("keeps the Origin check for human POSTs with missing or cross-site Origin", async () => {
    const { request } = setup();
    expect((await request("/en/ask", { method: "POST" })).status).toBe(403);
    expect((await request("/en/ask", { method: "POST", headers: { Origin: "https://foreign.invalid" } })).status).toBe(403);
    expect((await request("/en/ask", { method: "POST", headers: { Origin: "https://site.invalid" } })).status).toBe(200);
  });

  it("requires same-origin proof for cost-causing GET and HEAD queries", async () => {
    const { request } = setup();
    for (const path of ["/en/q", "/es/q", "/seasons/explore", "/en/seasons/explore", "/es/seasons/explore", "/en/seasons/explore/", "/%65n/%73easons/%65xplore", "/es/seasons/%65xplore", "/en/players/trends", "/es/players/trends", "/en/opponents/history", "/es/opponents/history", "/en/players/%74rends", "/en/%6Fpponents/history"]) {
      for (const method of ["GET", "HEAD"]) {
        for (const site of [undefined, "cross-site", "same-site", "none"]) {
          expect((await request(path, { method, headers: site ? { "Sec-Fetch-Site": site } : {} })).status).toBe(403);
        }
        expect((await request(path, { method, headers: { "Sec-Fetch-Site": "same-origin" } })).status).toBe(200);
        expect((await request(path, { method, headers: { Origin: "https://site.invalid" } })).status).toBe(200);
      }
    }
    expect((await request("/en", { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(200);
    expect((await request("/en/q", { headers: { Origin: "https://foreign.invalid", "Sec-Fetch-Site": "same-origin" } })).status).toBe(403);
  });

  it("protects only the localized player comparison GET routes with the same origin rules", async () => {
    const { request } = setup();
    for (const path of ["/en/players/compare", "/es/players/compare", "/en/players/compare/", "/es/players/compare/"]) {
      for (const site of ["cross-site", "same-site"]) {
        expect((await request(path, { headers: { "Sec-Fetch-Site": site } })).status).toBe(403);
      }
      expect((await request(path, { headers: { Origin: "https://foreign.invalid" } })).status).toBe(403);
      expect((await request(path, { headers: { "Sec-Fetch-Site": "same-origin" } })).status).toBe(200);
      expect((await request(path, { headers: { "Sec-Fetch-Site": "none" } })).status).toBe(403);
      expect((await request(path, { headers: { Origin: "https://site.invalid" } })).status).toBe(200);
      expect((await request(path, { headers: { "Sec-Fetch-Site": "same-origin", Origin: "https://foreign.invalid" } })).status).toBe(403);
    }
    for (const path of ["/compare", "/en/players/compare/extra", "/en/players/Compare", "/en/players%2Fcompare", "/en/players/%63ompare", "/en/players/%2563ompare"]) {
      const decodedMatch = path === "/en/players/%63ompare";
      expect((await request(path, { headers: { "Sec-Fetch-Site": "cross-site" } })).status, path).toBe(decodedMatch ? 403 : 200);
    }
  });

  it("protects localized player trends and opponent history GET routes while preserving the existing protected route set", async () => {
    const { request } = setup();
    const protectedPaths = [
      "/q", "/en/q", "/es/q",
      "/players/compare", "/en/players/compare", "/es/players/compare",
      "/seasons/explore", "/en/seasons/explore", "/es/seasons/explore",
      "/en/players/trends", "/es/players/trends",
      "/en/opponents/history", "/es/opponents/history",
    ];
    for (const path of protectedPaths) {
      for (const suffix of ["", "/", "?competition=PL"]) {
        const target = `${path}${suffix}`;
        expect((await request(target, { headers: {
          Cookie: "CF_Authorization=browser-session", Origin: "https://foreign.invalid",
        } })).status, target).toBe(403);
        expect((await request(target, { headers: {
          Cookie: "CF_Authorization=browser-session", Origin: "https://site.invalid",
        } })).status, target).toBe(200);
      }
    }
    for (const locale of ["en", "es"]) {
      for (const suffix of ["", "/", "?competition=PL"]) {
        for (const route of ["players/trends", "opponents/history"]) {
          const target = `/${locale}/${route}${suffix}`;
          expect((await request(target, { headers: {
            "Sec-Fetch-Site": "cross-site", Cookie: "CF_Authorization=browser-session",
          } })).status, target).toBe(403);
        }
      }
    }

    const serviceEnv = {
      ACCESS_ISSUER: "https://example.cloudflareaccess.com",
      ACCESS_AUD: "a".repeat(64),
      ACCESS_OWNER_EMAILS: "owner@example.invalid",
      ACCESS_SERVICE_CLIENT_IDS: "test-service",
    } as unknown as Env;
    const serviceApp = new Hono<AccessEnv>();
    serviceApp.use("*", accessGate(async () => ({ sub: "", serviceClientId: "test-service" })));
    serviceApp.all("*", (c) => c.text("protected"));
    const serviceRequest = (path: string, headers: Record<string, string>) => serviceApp.request(`https://site.invalid${path}`, {
      headers: { "cf-access-jwt-assertion": "verified-service", ...headers },
    }, serviceEnv);
    expect((await serviceRequest("/en/players/trends?competition=PL", {
      "Sec-Fetch-Site": "cross-site",
    })).status).toBe(403);
    expect((await serviceRequest("/en/players/trends?competition=PL", {
      Origin: "https://site.invalid", "Sec-Fetch-Site": "same-origin",
    })).status).toBe(200);
  });

  it("covers every budgeted GET route with the protected path matcher", () => {
    const source = readFileSync(new URL("../worker/src/index.ts", import.meta.url), "utf8");
    // Strip comments while preserving offsets, then balance delimiters so handler
    // bodies can have any shape (including synchronous arrows and functions).
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (comment: string) => comment.replace(/[^\n]/g, " "));
    const calls: number[] = [];
    for (const match of code.matchAll(/\benforceBudget\s*\(/g)) calls.push(match.index!);
    const registrations: { start: number; open: number; method: string; path: string; end: number }[] = [];
    const routeStart = /\bapp\.(get|on|route|all|post|put|patch|delete)\s*\(/g;
    for (const match of code.matchAll(routeStart)) {
      const open = match.index! + match[0].lastIndexOf("(");
      const next = [...code.slice(open + 1).matchAll(routeStart)][0];
      const end = next ? open + 1 + next.index! : code.length;
      const args = code.slice(open + 1, end);
      const pathMatch = args.match(/^\s*(`[^`]*`|"[^"]*"|'[^']*')/);
      registrations.push({ start: match.index!, open, method: match[1]!, path: pathMatch?.[1] ?? "", end });
    }

    // These explicit non-GET call sites are infrastructure/POST handling.
    const nonGet = new Set(["app.post(\"/api/chat\", budget-free)", "app.post(\"/api/query\", budget-free)", "helper.executeWithCache(budget-free)"]);
    const attributed: typeof registrations = [];
    for (const call of calls) {
      const owner = registrations.filter((route) => route.open < call && call < route.end).at(-1);
      const helperStart = code.indexOf("async function executeWithCache(");
      const helperCall = call > helperStart && code.lastIndexOf("async function executeWithCache(", call) === helperStart;
      expect(owner || helperCall, `enforceBudget at offset ${call} must belong to a route registration or explicitly listed helper`).toBeTruthy();
      if (!owner) {
        expect(nonGet.has("helper.executeWithCache(budget-free)"), `helper budget call at ${call} must be explicitly listed`).toBe(true);
        continue;
      }
      const route = owner!;
      if (route.method === "get") attributed.push(route);
      else expect(nonGet.has(`app.${route.method}(${route.path}, budget-free)`),
        `budget call at ${call} belongs to non-GET app.${route.method} ${route.path}; list it explicitly`).toBe(true);
    }

    const budgetedGetRoutes = [...new Map(attributed.map((route) => [`${route.start}`, route])).values()];
    expect(budgetedGetRoutes.length).toBeGreaterThan(0);
    for (const route of budgetedGetRoutes) {
      expect(route.path, `GET registration at ${route.start} needs a literal path`).not.toBe("");
      for (const locale of ["en", "es"]) {
        const path = route.path.slice(1, -1).replace(/\$\{p\}/g, `/${locale}`).replace(/\$\{code\}/g, locale);
        expect(isProtectedGetPath(path), `${route.path} registered for ${locale} as ${path}`).toBe(true);
      }
    }
  });
});

describe("Access JWT verification uses signatures and required claims", () => {
  it("authorizes only explicitly allowed signed service identities", async () => {
    const pair = await generateKeyPair("RS256");
    const jwk = await exportJWK(pair.publicKey);
    const keys = createLocalJWKSet({ keys: [{ ...jwk, kid: "service-test" }] });
    const config = { issuer: "https://example.cloudflareaccess.com", audience: "a".repeat(64),
      owners: ["owner@example.invalid"], serviceClientIds: ["synthetic-dev.access"] };
    const claims = { iss: config.issuer, aud: config.audience, sub: "", type: "app",
      common_name: "synthetic-dev.access", exp: Math.floor(Date.now() / 1000) + 60 };
    const sign = (overrides: Record<string, unknown> = {}) => new SignJWT({ ...claims, ...overrides })
      .setProtectedHeader({ alg: "RS256", kid: "service-test" }).sign(pair.privateKey);
    await expect(verifyAccess(await sign(), config, keys)).resolves.toEqual({
      sub: "", serviceClientId: "synthetic-dev.access",
    });
    await expect(verifyAccess(await sign(), { ...config, serviceClientIds: [] }, keys)).rejects.toThrow();
    const { serviceClientIds: _ids, ...humanOnly } = config;
    await expect(verifyAccess(await sign(), humanOnly, keys)).rejects.toThrow();
    for (const overrides of [{ common_name: "other.access" }, { common_name: undefined },
      { common_name: null }, { common_name: 123 }, { email: null },
      { common_name: "SYNTHETIC-DEV.access" }, { sub: "human" }, { sub: undefined },
      { email: "owner@example.invalid" }, { type: "org" }, { type: undefined },
      { exp: 1 }, { exp: undefined }, { aud: "production-audience" }, { iss: "https://other.invalid" }]) {
      await expect(verifyAccess(await sign(overrides), config, keys)).rejects.toThrow();
    }
    const application = new Hono<{ Bindings: Env }>();
    application.use("*", accessGate((token, settings) => verifyAccess(token, settings, keys)));
    application.all("*", (c) => c.text("protected"));
    const env = { ACCESS_ISSUER: config.issuer, ACCESS_AUD: config.audience,
      ACCESS_OWNER_EMAILS: config.owners[0], ACCESS_SERVICE_CLIENT_IDS: config.serviceClientIds[0] } as Env;
    const token = await sign();
    for (const [path, method] of [["/en/ask", "POST"], ["/en/q", "GET"]]) {
      for (const origin of ["null", "https://foreign.invalid", "https://site.invalid"]) {
        const res = await application.request(`https://site.invalid${path}`, {
          method, headers: { "cf-access-jwt-assertion": token, Origin: origin },
        }, env);
        expect(res.status).toBe(path === "/en/ask" || origin === "https://site.invalid" ? 200 : 403);
      }
    }
  });

  it("rejects forged, expired, missing-exp, wrong issuer/audience/owner/algorithm assertions", async () => {
    const pair = await generateKeyPair("RS256");
    const jwk = await exportJWK(pair.publicKey);
    const keys = createLocalJWKSet({ keys: [{ ...jwk, kid: "test" }] });
    const config = { issuer: "https://example.cloudflareaccess.com", audience: "test-audience", owners: ["owner@example.invalid"] };
    const claims = { iss: config.issuer, aud: config.audience, sub: "owner", email: config.owners[0], exp: Math.floor(Date.now() / 1000) + 60 };
    const sign = (overrides: Record<string, unknown>) => new SignJWT({ ...claims, ...overrides }).setProtectedHeader({ alg: "RS256", kid: "test" }).sign(pair.privateKey);
    expect((await verifyAccess(await sign({}), config, keys)).sub).toBe("owner");
    for (const overrides of [{ exp: undefined }, { exp: 1 }, { aud: "other" }, { iss: "https://other.invalid" }, { email: "outsider@example.invalid" }, { email: undefined }, { sub: null }]) {
      await expect(verifyAccess(await sign(overrides), config, keys)).rejects.toThrow();
    }
    await expect(verifyAccess("forged", config, keys)).rejects.toThrow();
    const hs = await new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).sign(crypto.getRandomValues(new Uint8Array(32)));
    await expect(verifyAccess(hs, config, keys)).rejects.toThrow();
  });
});
