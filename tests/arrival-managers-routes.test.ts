import { describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";
vi.mock("jose", async (original) => ({
  ...await original<typeof import("jose")>(),
  jwtVerify: vi.fn(async () => ({ payload: { sub: "owner", email: "owner@example.invalid" } })),
}));
import app from "../worker/src/index";

const request = new URLSearchParams({
  academy_basis: "documented_first_team_promotion",
  as_of: "2026-07-02",
  family: "arrival_manager",
  joining_basis: "effective_first_team_spell_entry",
  population: "first_team_available",
  version: "1",
  visualization: "table",
});
const answer = {
  version: 1,
  as_of: "2026-07-02",
  snapshot_id: "snap-1",
  coverage: "partial",
  population_count: 1,
  lineage: ["fpl"],
  rows: [{ player: "Alex Player", manager: null, entry_type: null, entry_date: null, status: "unknown", reason: "tenure_missing", coverage: "partial", as_of: "2026-07-02", snapshot_id: "snap-1", lineage: ["fpl"] }],
};
const env = (fetcher: (input: RequestInfo | URL) => Promise<Response>) => ({
  ACCESS_ISSUER: "https://example.cloudflareaccess.com",
  ACCESS_AUD: "a".repeat(64),
  ACCESS_OWNER_EMAILS: "owner@example.invalid",
  ASSETS: { fetch: fetcher },
} as unknown as Env);
const access = { "cf-access-jwt-assertion": "synthetic", Origin: "https://site.invalid", "Sec-Fetch-Site": "same-origin" };

describe("arrival manager dated answer route", () => {
  it.each([["en", "Players by manager at joining"], ["es", "Jugadores por entrenador al llegar"]] as const)("renders matching dated answer in %s", async (locale, title) => {
    const runtime = env(async input => {
      expect(new URL(String(input)).pathname).toBe("/answers/arrival-manager/2026-07-02.json");
      return Response.json(answer);
    });
    const response = await app.request(`https://site.invalid/${locale}/discover/arrivals?${request}`, { headers: access }, runtime);
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(body).toContain(title);
    expect(body).toContain("Alex Player");
    expect(body).toContain("2026-07-02");
    expect(body).toContain(locale === "es" ? "Desconocidos" : "Unknown manager");
    expect(body).toContain(locale === "es"
      ? "Datos de jugadores derivados de la API pública de Fantasy Premier League."
      : "Player data derived from the Fantasy Premier League public API.");
  });

  it("denies answers with unknown lineage refs", async () => {
    const unknown = { ...answer, lineage: ["unknown-source"], rows: answer.rows.map(row => ({ ...row, lineage: ["unknown-source"] })) };
    const runtime = env(async () => Response.json(unknown));
    for (const locale of ["en", "es"] as const) {
      const response = await app.request(`https://site.invalid/${locale}/discover/arrivals?${request}`, { headers: access }, runtime);
      const body = await response.text();
      expect(response.status, body).toBe(200);
      expect(body).toContain(locale === "es" ? "No se permite usar los datos" : "Data use is not permitted");
      expect(body).not.toContain("Alex Player");
    }
  });

  it("renders no-rights without player labels for non-redistributable lineage in EN and ES", async () => {
    const restricted = { ...answer, lineage: ["fbref"], rows: answer.rows.map(row => ({ ...row, lineage: ["fbref"] })) };
    const runtime = env(async () => Response.json(restricted));
    for (const locale of ["en", "es"] as const) {
      const response = await app.request(`https://site.invalid/${locale}/discover/arrivals?${request}`, { headers: access }, runtime);
      const body = await response.text();
      expect(response.status, body).toBe(200);
      expect(body).toContain(locale === "es" ? "No se permite usar los datos" : "Data use is not permitted");
      expect(body).not.toContain("Alex Player");
    }
  });

  it("renders labels and credit for redistributable lineage", async () => {
    const runtime = env(async () => Response.json(answer));
    const response = await app.request(`https://site.invalid/en/discover/arrivals?${request}`, { headers: access }, runtime);
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(body).toContain("Alex Player");
    expect(body).toContain("Player data derived from the Fantasy Premier League public API.");
  });

  it("renders row-only FPL credit in EN and ES", async () => {
    const rowOnly = { ...answer, lineage: [] };
    const runtime = env(async () => Response.json(rowOnly));
    for (const locale of ["en", "es"] as const) {
      const response = await app.request(`https://site.invalid/${locale}/discover/arrivals?${request}`, { headers: access }, runtime);
      const body = await response.text();
      expect(response.status, body).toBe(200);
      expect(body).toContain(locale === "es"
        ? "Datos de jugadores derivados de la API pública de Fantasy Premier League."
        : "Player data derived from the Fantasy Premier League public API.");
      expect(body).not.toContain(locale === "es" ? "Atribución de fuente no disponible para algunos datos." : "Source attribution unavailable for some data.");
    }
  });

  it("shows unavailable attribution for unknown row-only lineage", async () => {
    const unknown = { ...answer, lineage: [], rows: answer.rows.map(row => ({ ...row, lineage: ["unknown-source"] })) };
    const runtime = env(async () => Response.json(unknown));
    const response = await app.request(`https://site.invalid/en/discover/arrivals?${request}`, { headers: access }, runtime);
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(body).toContain("Data use is not permitted for this question");
  });

  it.each([
    ["invalid request", "as_of=2026-02-30"],
    ["mismatched answer", "family=manager_eras"],
  ])("does not expose player rows for %s", async (_name, override) => {
    const runtime = env(async () => Response.json(answer));
    const query = new URLSearchParams(request);
    const [key, value] = override.split("=");
    query.set(key!, value!);
    const response = await app.request(`https://site.invalid/en/discover/arrivals?${query}`, { headers: access }, runtime);
    const body = await response.text();
    expect(response.status).toBe(400);
    expect(body).not.toContain("Alex Player");
  });

  it("does not expose player rows when the dated answer is missing", async () => {
    const runtime = env(async () => new Response("missing", { status: 404 }));
    const response = await app.request(`https://site.invalid/es/discover/arrivals?${request}`, { headers: access }, runtime);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).not.toContain("Alex Player");
    expect(body).toContain("Datos necesarios no disponibles");
    expect(body).toContain("Volver a esta pregunta fechada");
  });

  it("keeps a localized no-data and revisit state for an answer with a different date", async () => {
    const mismatched = { ...answer, as_of: "2026-07-01" };
    const runtime = env(async () => Response.json(mismatched));
    const response = await app.request(`https://site.invalid/es/discover/arrivals?${request}`, { headers: access }, runtime);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).not.toContain("Alex Player");
    expect(body).toContain("Datos necesarios no disponibles");
    expect(body).toContain("Volver a esta pregunta fechada");
  });
});
