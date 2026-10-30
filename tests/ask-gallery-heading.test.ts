import { describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";
import { LOCALES } from "../worker/src/core/locale";

vi.mock("../worker/src/security/auth", async (original) => ({
  ...await original<typeof import("../worker/src/security/auth")>(),
  accessGate: () => async (_context: unknown, next: () => Promise<void>) => next(),
  accessIdentity: () => undefined,
}));

vi.mock("../worker/src/core/db", async (original) => ({
  ...await original<typeof import("../worker/src/core/db")>(),
  currentSnapshot: vi.fn(async () => null),
  currentPublication: vi.fn(async () => null),
}));

import app from "../worker/src/index";

const env = {
  ACCESS_ISSUER: "https://example.cloudflareaccess.com",
  ACCESS_AUD: "a".repeat(64),
  ACCESS_OWNER_EMAILS: "owner@example.invalid",
} as Env;

describe("ask gallery heading", () => {
  it.each([LOCALES.en, LOCALES.es])("labels the question gallery in $code", async (locale) => {
    const response = await app.request(`https://site.invalid/${locale.code}`, {}, env);
    const markup = await response.text();

    expect(response.status).toBe(200);
    expect(markup).toContain(`<h3>${locale.strings.exampleQuestionsHeading}</h3>`);
  });
});
