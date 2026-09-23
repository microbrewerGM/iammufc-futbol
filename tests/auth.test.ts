import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import app from "../worker/src/index";
import type { Env } from "../worker/src/core/db";
import { accessGate, verifyAccess } from "../worker/src/security/auth";

function setup() {
  const env = {
    ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    ACCESS_AUD: "a".repeat(64),
    ACCESS_OWNER_EMAILS: "owner@example.invalid",
  } as unknown as Env;
  const verifier = vi.fn(async (token: string) => {
    if (token !== "verified-by-test") throw new Error("denied");
    return { sub: "test-owner", email: "owner@example.invalid" };
  });
  const application = new Hono<{ Bindings: Env }>();
  application.use("*", accessGate(verifier));
  application.all("*", (c) => c.text("protected"));
  const request = (path: string, init: RequestInit = {}) => application.request(`https://site.invalid${path}`, {
    ...init, headers: { "cf-access-jwt-assertion": "verified-by-test", ...init.headers },
  }, env);
  return { request, verifier };
}

describe("Cloudflare Access boundary", () => {
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

  it("rejects unsafe requests without exact same-origin HTTPS proof", async () => {
    const { request } = setup();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const origin of [undefined, "null", "https://foreign.invalid", "http://site.invalid", "https://site.invalid/", "https://site.invalid.evil.test"]) {
        const res = await request("/protected", { method, headers: origin ? { Origin: origin } : {} });
        expect(res.status, `${method} ${origin}`).toBe(403);
      }
    }
  });

  it("requires same-origin proof for cost-causing GET and HEAD queries", async () => {
    const { request } = setup();
    for (const path of ["/en/q", "/es/q"]) {
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
});

describe("Access JWT verification uses signatures and required claims", () => {
  it("rejects forged, expired, missing-exp, wrong issuer/audience/owner/algorithm assertions", async () => {
    const pair = await generateKeyPair("RS256");
    const jwk = await exportJWK(pair.publicKey);
    const keys = createLocalJWKSet({ keys: [{ ...jwk, kid: "test" }] });
    const config = { issuer: "https://example.cloudflareaccess.com", audience: "test-audience", owners: ["owner@example.invalid"] };
    const claims = { iss: config.issuer, aud: config.audience, sub: "owner", email: config.owners[0], exp: Math.floor(Date.now() / 1000) + 60 };
    const sign = (overrides: Record<string, unknown>) => new SignJWT({ ...claims, ...overrides }).setProtectedHeader({ alg: "RS256", kid: "test" }).sign(pair.privateKey);
    expect((await verifyAccess(await sign({}), config, keys)).sub).toBe("owner");
    for (const overrides of [{ exp: undefined }, { exp: 1 }, { aud: "other" }, { iss: "https://other.invalid" }, { email: "outsider@example.invalid" }, { sub: null }]) {
      await expect(verifyAccess(await sign(overrides), config, keys)).rejects.toThrow();
    }
    await expect(verifyAccess("forged", config, keys)).rejects.toThrow();
    const hs = await new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).sign(crypto.getRandomValues(new Uint8Array(32)));
    await expect(verifyAccess(hs, config, keys)).rejects.toThrow();
  });
});
