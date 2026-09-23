import { describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";

// Route integration only. auth.test.ts separately exercises real JWT signatures.
vi.mock("jose", async (importOriginal) => ({
  ...await importOriginal<typeof import("jose")>(),
  jwtVerify: vi.fn(async (token: string) => {
    if (token !== "route-test-assertion") throw new Error("denied");
    return { payload: { sub: "owner", email: "owner@example.invalid" } };
  }),
}));
import app from "../worker/src/index";

function setup() {
  const fetch = vi.fn(async () => new Response("test stylesheet", {
    headers: { "Content-Type": "text/css", "Cache-Control": "public, max-age=3600" },
  }));
  const prepare = vi.fn(() => { throw new Error("DB must not be reached"); });
  const run = vi.fn(() => { throw new Error("AI must not be reached"); });
  const env = { ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64),
    ACCESS_OWNER_EMAILS: "owner@example.invalid", ASSETS: { fetch }, DB: { prepare }, AI: { run } } as unknown as Env;
  return { env, fetch, prepare, run };
}
const assertion = { "cf-access-jwt-assertion": "route-test-assertion" };

describe("authorization on real application routes", () => {
  it("denies assets before calling their binding", async () => {
    const { env, fetch } = setup();
    for (const token of ["", "forged"]) {
      for (const path of ["/style.css", "/future-asset.bin"]) {
        const res = await app.request(`https://site.invalid${path}`, { headers: { "cf-access-jwt-assertion": token } }, env);
        expect(res.status).toBe(403);
        expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      }
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("serves authenticated assets with private headers and no second login", async () => {
    const { env, fetch } = setup();
    const res = await app.request("https://site.invalid/style.css", { headers: assertion }, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("test stylesheet");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Cloudflare-CDN-Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("denies cross-origin side effects before DB or AI calls", async () => {
    const { env, prepare, run } = setup();
    for (const [path, method] of [["/en/ask", "POST"], ["/api/chat", "POST"], ["/api/query", "POST"], ["/en/q", "GET"], ["/es/q", "HEAD"], ["/en/%71", "GET"], ["/%65n/q", "HEAD"]]) {
      const res = await app.request(`https://site.invalid${path}`, { method, headers: { ...assertion, Origin: "https://foreign.invalid", "Sec-Fetch-Site": "cross-site" } }, env);
      expect(res.status).toBe(403);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
