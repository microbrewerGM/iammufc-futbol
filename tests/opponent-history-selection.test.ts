import { beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Node's built-in module is available in the configured test runtime.
import * as nodeFs from "node:fs";
import type { Env } from "../worker/src/core/db";

const labels = new Map([["club:1001", "Arsenal"], ["club:1014", "Liverpool"], ["club:1015", "Manchester City"]]);
vi.mock("jose", async (original) => ({ ...await original<typeof import("jose")>(), jwtVerify: vi.fn(async () => ({ payload: { sub: "owner", email: "owner@example.invalid" } })) }));
vi.mock("../worker/src/core/db", async (original) => ({ ...await original<typeof import("../worker/src/core/db")>(),
  enforceBudget: vi.fn(async () => true), currentSnapshot: vi.fn(async () => "a".repeat(64)),
  currentPublication: vi.fn(async () => ({ snapshotId: "a".repeat(64), preparedAt: "2026-01-01T00:00:00.000Z", loadedAt: "2026-01-01T00:00:00.000Z", sources: [] })),
  readOpponentLabels: vi.fn(async (_env: unknown, _snapshot: string, ids: readonly string[]) => new Map(ids.flatMap(id => labels.has(id) ? [[id, labels.get(id)!] as const] : []))),
  seasonSplitFacts: vi.fn(async (_env: unknown, snapshot: string, seasons: string[]) => ({ catalog: { snapshot_id: snapshot, seasons: seasons.map(season => ({ season, coverage: "complete" as const })) }, rows: [] })),
}));
vi.mock("../worker/src/core/opponent-history", async (original) => ({ ...await original<typeof import("../worker/src/core/opponent-history")>(),
  readOpponentHistory: vi.fn(async (_env: unknown, request: any, metadata: any) => ({ request, snapshot_id: metadata.snapshot_id,
    seasons: request.seasons.map((season: string) => ({ season, coverage: "complete", status: "no_matches" })),
    status: "no_matches", partial: false, contributing_seasons: [] })),
}));

import app from "../worker/src/index";
import { currentPublication, currentSnapshot, enforceBudget, readOpponentLabels, seasonSplitFacts } from "../worker/src/core/db";
import { APPROVED_OPPONENT_IDS } from "../worker/src/core/opponent-history";
import { Catalog } from "../worker/src/core/feasibility";
import { LOCALES } from "../worker/src/core/locale";

const env = { ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64), ACCESS_OWNER_EMAILS: "owner@example.invalid",
  DB: { prepare: vi.fn(() => ({ first: async () => ({ count: 1 }), bind: () => ({ first: async () => ({ count: 1 }) }) })) } } as unknown as Env;
const headers = { "cf-access-jwt-assertion": "synthetic", Origin: "https://site.invalid" };
const clear = vi.spyOn(Catalog.prototype, "outputCapability").mockReturnValue("clear");
const snapshot = "a".repeat(64);
const { readFileSync } = nodeFs as unknown as { readFileSync(path: URL, encoding: "utf8"): string };
const stylesheet = readFileSync(new URL("../worker/public/style.css", import.meta.url), "utf8");

function expectOpponentFormNarrow(markup: string) {
  const form = markup.match(/<form id="opponent-history-form"[\s\S]*?<\/form>/)?.[0];
  expect(form).toBeDefined();
  const rules = [...stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const formRules = rules.filter(rule => /\b(?:form|fieldset|label|select|input|button)\b/i.test(rule[1] ?? ""));
  for (const rule of formRules) {
    for (const width of (rule[2] ?? "").matchAll(/(?:min-width|max-width|width)\s*:\s*([\d.]+)px/gi)) {
      expect(Number(width[1] ?? "0")).toBeLessThanOrEqual(320);
    }
  }
}

beforeEach(() => { vi.clearAllMocks(); clear.mockReturnValue("clear"); });

describe("opponent history selection form", () => {
  it.each(["en", "es"] as const)("renders a localized %s form without selection", async locale => {
    const response = await app.request(`https://site.invalid/${locale}/opponents/history`, { headers }, env);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain(`<html lang="${LOCALES[locale].htmlLang}">`);
    expect(body).toContain(locale === "en" ? "Choose an opponent and scope" : "Elige un rival y el alcance");
    expect(body).toContain('name="opponent_id"');
    const optionIds = [...body.matchAll(/<option value="(club:\d+)"(?: selected)?>([^<]+)<\/option>/g)];
    expect(new Set(optionIds.map(([, id]) => id))).toEqual(APPROVED_OPPONENT_IDS);
    expect(readOpponentLabels).toHaveBeenCalledWith(env, snapshot, [...APPROVED_OPPONENT_IDS]);
    expect(optionIds.find(([, id]) => id === "club:1001")?.[2]).toBe("Arsenal");
    expect(optionIds.find(([, id]) => id === "club:1014")?.[2]).toBe("Liverpool");
    expect(optionIds.find(([, id]) => id === "club:1015")?.[2]).toBe("Manchester City");
    const sortedFirst = [...APPROVED_OPPONENT_IDS].sort((a, b) =>
      (labels.get(a) ?? a).localeCompare(labels.get(b) ?? b) || a.localeCompare(b))[0];
    expect(optionIds[0]?.[1]).toBe(sortedFirst);
    expect(optionIds[0]?.[0]).toContain(" selected>");
    expect(body).toMatch(/name="seasons" value="\d{4}-\d{2}" checked/);
    expect(body).toContain('value="all" selected');
    expect(body).toContain(locale === "en" ? "All venues" : "Todas las localías");
    expectOpponentFormNarrow(body);
    expect(seasonSplitFacts).not.toHaveBeenCalled();
  });

  it.each([
    "schema_version=%201",
    "schema_version=01",
    "schema_version=1.0",
    "schema_version=",
    "competition=pl",
    "competition=",
    "schema_version=2",
    "competition=XX",
  ])("rejects %s before budget and D1 work, even with no seasons", async query => {
    const response = await app.request(
      `https://site.invalid/en/opponents/history?${query}&opponent_id=club%3A1001`,
      { headers }, env,
    );
    expect(response.status).toBe(400);
    expect(enforceBudget).not.toHaveBeenCalled();
    expect(currentPublication).not.toHaveBeenCalled();
    expect(readOpponentLabels).not.toHaveBeenCalled();
    expect(currentSnapshot).not.toHaveBeenCalled();
    expect(seasonSplitFacts).not.toHaveBeenCalled();
  });

  it.each([
    ["initial", "https://site.invalid/en/opponents/history", 200],
    ["no-seasons", "https://site.invalid/en/opponents/history?opponent_id=club%3A1001", 400],
  ] as const)("does not read opponent labels for the %s form when splits are unpublished", async (_path, url, status) => {
    clear.mockReturnValue("unknown");
    const response = await app.request(url, { headers }, env);
    expect(response.status).toBe(status);
    expect(await response.text()).toContain("Season splits capability is not published.");
    expect(enforceBudget).not.toHaveBeenCalled();
    expect(currentPublication).not.toHaveBeenCalled();
    expect(readOpponentLabels).not.toHaveBeenCalled();
  });

  it("checks the budget before empty-query D1 reads and returns the selected path refusal status", async () => {
    vi.mocked(enforceBudget).mockResolvedValueOnce(false);
    const emptyResponse = await app.request("https://site.invalid/en/opponents/history", { headers }, env);
    expect(emptyResponse.status).toBe(503);
    expect(enforceBudget).toHaveBeenCalledWith(env, { failClosed: true });
    expect(currentPublication).not.toHaveBeenCalled();
    expect(readOpponentLabels).not.toHaveBeenCalled();
    expect(currentSnapshot).not.toHaveBeenCalled();
    expect(seasonSplitFacts).not.toHaveBeenCalled();

    vi.mocked(enforceBudget).mockResolvedValueOnce(false);
    const selectedResponse = await app.request(
      "https://site.invalid/en/opponents/history?opponent_id=club%3A1001&seasons=2023-24",
      { headers }, env,
    );
    expect(selectedResponse.status).toBe(emptyResponse.status);
    expect(enforceBudget).toHaveBeenLastCalledWith(env, { failClosed: true });
    expect(currentPublication).not.toHaveBeenCalled();
    expect(readOpponentLabels).not.toHaveBeenCalled();
    expect(currentSnapshot).not.toHaveBeenCalled();
    expect(seasonSplitFacts).not.toHaveBeenCalled();
  });

  it.each(["en", "es"] as const)("preserves the %s selection and venue in the canonical result URL", async locale => {
    const params = new URLSearchParams({ schema_version: "1", competition: "PL", group_by: "opponent", venue: "away", opponent_id: "club:1014" });
    params.append("seasons", "2023-24");
    params.append("seasons", "2024-25");
    const response = await app.request(`https://site.invalid/${locale}/opponents/history?${params}`, { headers }, env);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(seasonSplitFacts).toHaveBeenCalledWith(env, snapshot, ["2023-24", "2024-25"], { venue: "away", opponent_id: "club:1014" });
    // Contract order: schema_version, competition, seasons, group_by, venue, opponent_id.
    expect(body).toContain(
      `<link rel="canonical" href="/${locale}/opponents/history?schema_version=1&amp;competition=PL` +
      "&amp;seasons=2023-24&amp;seasons=2024-25&amp;group_by=opponent&amp;venue=away&amp;opponent_id=club%3A1014\">");
    expect(readOpponentLabels).toHaveBeenCalledTimes(1);
    expect(readOpponentLabels).toHaveBeenCalledWith(env, snapshot, ["club:1014"]);
    expect(body).toContain(`<p>${LOCALES[locale].strings.opponentHistoryOpponentLabel}: Liverpool</p><input type="hidden" name="opponent_id" value="club:1014">`);
    expect(body).not.toContain('<select name="opponent_id"');
    expect(body).toContain('name="seasons" value="2023-24" checked');
    expect(body).toContain('name="seasons" value="2024-25" checked');
    expect(body).toContain('value="away" selected');
    const href = body.match(/<p><a href="([^"]+)">/)?.[1]?.replaceAll("&amp;", "&");
    expect(href).toBe(`/${locale}/opponents/history?seasons=2023-24&seasons=2024-25&venue=away`);
    expect(body).toContain(`<a href="/${locale}/opponents/history?seasons=2023-24&amp;seasons=2024-25&amp;venue=away">${LOCALES[locale].strings.opponentHistoryChangeSelection}</a>`);
    expectOpponentFormNarrow(body);
    const returned = await app.request(`https://site.invalid${href}`, { headers }, env);
    const returnedBody = await returned.text();
    expect(returned.status).toBe(200);
    expect(returnedBody).toContain('<select name="opponent_id" required>');
    expect(returnedBody).toContain('name="seasons" value="2023-24" checked');
    expect(returnedBody).toContain('name="seasons" value="2024-25" checked');
    expect(returnedBody).toContain('value="away" selected');
    expectOpponentFormNarrow(returnedBody);
    expect(LOCALES[locale].strings.opponentHistoryChangeSelection).not.toBe(LOCALES[locale].strings.opponentHistoryChoose);
    expect(currentSnapshot).toHaveBeenCalled();
  });

  it.each(["en", "es"] as const)("re-renders the %s form with a message when no season is checked", async locale => {
    const response = await app.request(
      `https://site.invalid/${locale}/opponents/history?schema_version=1&competition=PL&group_by=opponent&venue=home&opponent_id=club%3A1014`,
      { headers }, env,
    );
    const body = await response.text();
    expect(response.status).toBe(400);
    expect(body).toContain(locale === "en" ? "Select at least one season." : "Selecciona al menos una temporada.");
    expect(body).toContain('role="alert"');
    expect(body).toContain('value="club:1014" selected>');
    expect(body).toContain('value="home" selected');
    expect(body).not.toMatch(/name="seasons" value="[^"]+" checked/);
    expect(seasonSplitFacts).not.toHaveBeenCalled();
  });

  it("returns 503 on the no-seasons branch when budget is refused, before D1 reads", async () => {
    vi.mocked(enforceBudget).mockResolvedValueOnce(false);
    const response = await app.request(
      "https://site.invalid/en/opponents/history?schema_version=1&competition=PL&group_by=opponent&opponent_id=club%3A1014",
      { headers }, env,
    );
    expect(response.status).toBe(503);
    expect(enforceBudget).toHaveBeenCalledWith(env, { failClosed: true });
    expect(currentPublication).not.toHaveBeenCalled();
    expect(readOpponentLabels).not.toHaveBeenCalled();
    expect(currentSnapshot).not.toHaveBeenCalled();
    expect(seasonSplitFacts).not.toHaveBeenCalled();
  });

  it("keeps the label read cap at or above the approved set size", async () => {
    const real = await vi.importActual<typeof import("../worker/src/core/db")>("../worker/src/core/db");
    const ids = [...APPROVED_OPPONENT_IDS];
    expect(APPROVED_OPPONENT_IDS.size).toBeLessThanOrEqual(real.MAX_OPPONENT_LABELS);
    await expect(real.readOpponentLabels(env, snapshot, ids)).resolves.toBeInstanceOf(Map);
  });
});
