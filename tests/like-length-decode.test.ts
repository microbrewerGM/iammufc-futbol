import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";

vi.mock("jose", async (original) => ({
  ...await original<typeof import("jose")>(),
  jwtVerify: vi.fn(async () => ({ payload: { sub: "owner", email: "owner@example.invalid" } })),
}));

vi.mock("../worker/src/core/db", async (original) => ({
  ...await original<typeof import("../worker/src/core/db")>(),
  currentSnapshot: vi.fn(async () => "synthetic"),
}));

import app from "../worker/src/index";
import { resolvePlayerIdentity } from "../worker/src/core/db";

const bound: unknown[][] = [];
const env = {
  ACCESS_ISSUER: "https://example.cloudflareaccess.com",
  ACCESS_AUD: "a".repeat(64),
  ACCESS_OWNER_EMAILS: "owner@example.invalid",
  DB: {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        all: async () => {
          if (sql.includes("exact_match")) {
            bound.push(args);
            return { results: [{ person_id: "fpl:code:1", web_name: "Fernandes", exact_match: 1 }] };
          }
          return { results: [] };
        },
      }),
    }),
  },
} as unknown as Env;

beforeEach(() => {
  bound.length = 0;
});

// Alias pattern is "%" + escaped needle + "%"; D1 caps it at 50 bytes.
describe("alias LIKE pattern length cap", () => {
  it("resolves a needle whose bound pattern is exactly 50 bytes", async () => {
    const needle = "a".repeat(48);
    expect(await resolvePlayerIdentity(env, needle)).toEqual({ person_id: "fpl:code:1", web_name: "Fernandes" });
    expect(bound[0]).toContain(needle);
  });

  it("returns null without querying one byte over the cap", async () => {
    expect(await resolvePlayerIdentity(env, "a".repeat(49))).toBeNull();
    expect(bound).toHaveLength(0);
  });

  it("counts UTF-8 bytes, not characters", async () => {
    expect(await resolvePlayerIdentity(env, "é".repeat(24))).not.toBeNull();
    expect(await resolvePlayerIdentity(env, "é".repeat(25))).toBeNull();
  });

  it("counts escape characters toward the cap", async () => {
    // 20 chars escape to 40 bytes + 2 wildcards = 42: fits.
    expect(await resolvePlayerIdentity(env, "%".repeat(20))).not.toBeNull();
    // 25 chars escape to 50 bytes + 2: over.
    expect(await resolvePlayerIdentity(env, "%".repeat(25))).toBeNull();
    expect(await resolvePlayerIdentity(env, "%".repeat(5000))).toBeNull();
  });

  it("still resolves a normal name", async () => {
    expect(await resolvePlayerIdentity(env, "Fernandes")).toEqual({ person_id: "fpl:code:1", web_name: "Fernandes" });
  });
});

describe("/player/:name decoding", () => {
  const get = (path: string) => app.request(`https://site.invalid${path}`, { headers: { "cf-access-jwt-assertion": "synthetic" } }, env);

  it.each(["/en/player/%25", "/en/player/%2500aa"])("%s gives the not-found page, not 503", async (path) => {
    const res = await get(path);
    expect(res.status).toBeLessThan(500);
  });

  it("a long escaped-overflow name is not a 503", async () => {
    const res = await get(`/en/player/${"%25".repeat(300)}`);
    expect(res.status).toBeLessThan(500);
    expect(bound).toHaveLength(0);
  });

  it("a normal name still resolves", async () => {
    const res = await get("/en/player/Fernandes");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Fernandes");
  });
});
