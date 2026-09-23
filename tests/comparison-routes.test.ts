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

const rows = [
  { player_id: "fpl:1:2024-25", label: "Synthetic Alpha", total: 5, minutes: 450, snapshot_id: "synthetic" },
  { player_id: "fpl:2:2024-25", label: "Synthetic Beta", total: 4, minutes: 500, snapshot_id: "synthetic" },
];

function setup() {
  const all = vi.fn(async () => ({ results: rows }));
  const bind = vi.fn((_season: string) => ({ all }));
  const prepare = vi.fn((_query: string) => ({ bind }));
  const env = {
    ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    ACCESS_AUD: "a".repeat(64),
    ACCESS_OWNER_EMAILS: "owner@example.invalid",
    DB: { prepare },
  } as unknown as Env;
  return { env, prepare, bind };
}

const headers = { "cf-access-jwt-assertion": "synthetic" };

describe("authenticated comparison routes", () => {
  it("denies absent and forged assertions in both locales before SQL", async () => {
    const { env, prepare } = setup();
    for (const locale of ["en", "es"]) {
      for (const assertion of [undefined, "forged"]) {
        const response = await app.request(
          `https://site.invalid/${locale}/compare`,
          assertion ? { headers: { "cf-access-jwt-assertion": assertion } } : {},
          env,
        );
        expect(response.status).toBe(403);
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      }
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it("renders EN/ES controls, preserves language-switch parameters, and uses localized attribution", async () => {
    const { env } = setup();
    const query = "season=2024-25&metric=goals&min_minutes=450";
    const en = await app.request(`https://site.invalid/en/compare?${query}`, { headers }, env);
    const enBody = await en.text();
    expect(en.status).toBe(200);
    expect(enBody).toContain("Output per 90 minutes");
    expect(enBody).toContain('role="region"');
    expect(enBody).toContain('tabindex="0"');
    expect(enBody).toContain(
      'href="/es/compare?season=2024-25&amp;metric=goals&amp;min_minutes=450"',
    );

    const es = await app.request(`https://site.invalid/es/compare?${query}`, { headers }, env);
    const esBody = await es.text();
    expect(es.status).toBe(200);
    expect(esBody).toContain("Producción por 90 minutos");
    expect(esBody).toContain("Datos de jugadores derivados");
  });

  it("selects assists safely and rejects duplicate or unsupported controls before SQL", async () => {
    const { env, prepare } = setup();
    const assists = await app.request(
      "https://site.invalid/en/compare?season=2024-25&metric=assists&min_minutes=450",
      { headers },
      env,
    );
    expect(assists.status).toBe(200);
    expect(await assists.text()).toContain('value="assists" selected');
    expect(prepare.mock.calls[0]![0]).toContain("s.assists AS total");

    prepare.mockClear();
    for (const query of ["metric=xg", "metric=goals&metric=assists", "extra=1"]) {
      const response = await app.request(`https://site.invalid/en/compare?${query}`, { headers }, env);
      expect(response.status).toBe(400);
    }
    expect(prepare).not.toHaveBeenCalled();
  });
});
