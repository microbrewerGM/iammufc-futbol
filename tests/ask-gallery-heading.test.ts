import { describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";
import compiled from "../worker/src/generated/catalog.json" with { type: "json" };
import { Catalog, type CompiledCatalog } from "../worker/src/core/feasibility";
import { LOCALES } from "../worker/src/core/locale";
import { homeBody } from "../worker/src/views/pages";

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
  it.each([
    ["en", "Example questions"],
    ["es", "Preguntas de ejemplo"],
  ] as const)("labels the question gallery in %s", async (code, heading) => {
    const locale = LOCALES[code];
    const response = await app.request(`https://site.invalid/${locale.code}`, {}, env);
    const markup = await response.text();

    expect(response.status).toBe(200);
    expect(markup).toContain(`<h3>${heading}</h3>`);
    const questionSection = markup.match(new RegExp(`<section>\\s*<h3>${heading}</h3>([\\s\\S]*?)<\\/section>`))?.[1];
    expect(questionSection).toBeDefined();
    expect(questionSection).not.toMatch(/href="\/(?:en|es)\/(?:player|season)\//);
  });

  it("renders only the comparison section when the catalog has no question examples", () => {
    const empty = new Catalog({ ...(compiled as unknown as CompiledCatalog), coverage: [] });
    const markup = homeBody(empty, LOCALES.en);

    expect(markup.match(/<h3>/g)).toHaveLength(1);
    expect(markup).toContain(`<h3>${LOCALES.en.strings.examplesHeading}</h3>`);
    expect(markup).not.toContain("<h3>Example questions</h3>");
  });
});
