import { describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";

vi.mock("jose", async (original) => ({
  ...await original<typeof import("jose")>(),
  jwtVerify: vi.fn(async (token: string) => {
    if (token !== "synthetic") throw new Error("denied");
    return { payload: { sub: "owner", email: "owner@example.invalid" } };
  }),
}));

import app from "../worker/src/index";

const auth = { "cf-access-jwt-assertion": "synthetic" };

function setup() {
  const prepare = vi.fn(() => { throw new Error("DB must not be reached"); });
  const run = vi.fn(() => { throw new Error("AI must not be reached"); });
  const env = {
    ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    ACCESS_AUD: "a".repeat(64),
    ACCESS_OWNER_EMAILS: "owner@example.invalid",
    DB: { prepare },
    AI: { run },
  } as unknown as Env;
  return { env, prepare, run };
}

describe("authenticated data availability routes", () => {
  it("denies anonymous access before DB or AI", async () => {
    const { env, prepare, run } = setup();
    for (const locale of ["en", "es"]) {
      const response = await app.request(`https://site.invalid/${locale}/data`, {}, env);
      expect(response.status).toBe(403);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["en", "Data and sources", "Goals scored in the competition."],
    ["es", "Datos y fuentes", "Goles marcados en la competición."],
  ])("renders the sanitized %s catalog without data-service calls", async (locale, title, definition) => {
    const { env, prepare, run } = setup();
    const response = await app.request(`https://site.invalid/${locale}/data`, { headers: auth }, env);
    const markup = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(markup).toContain(title);
    expect(markup).toContain(definition);
    expect(markup).toContain('role="region"');
    expect(markup).toContain('href="/en/data"');
    expect(markup).toContain('href="/es/data"');
    expect(markup).not.toMatch(/licence_id|private_agreement|retrieval_url|"notes"/);
    expect(prepare).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("redirects the bare data path permanently", async () => {
    const { env } = setup();
    const response = await app.request("https://site.invalid/data", { headers: auth }, env);
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("/en/data");
  });
});
