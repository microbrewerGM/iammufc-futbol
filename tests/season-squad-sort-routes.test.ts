import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/src/core/db";

vi.mock("jose", async original => ({
  ...await original<typeof import("jose")>(),
  jwtVerify: vi.fn(async () => ({ payload: { sub: "owner", email: "owner@example.invalid" } })),
}));
const state = vi.hoisted(() => ({ rows: [
  { label: "Goals leader", route_key: "k:goals", secondary: "FW", goals: 4, assists: 1, minutes: 900, points: 10, xg: 1 },
  { label: "Assists leader", route_key: "k:assists", secondary: "MF", goals: 1, assists: 4, minutes: 900, points: 10, xg: 1 },
] }));
vi.mock("../worker/src/core/db", async original => ({
  ...await original<typeof import("../worker/src/core/db")>(),
  currentSnapshot: vi.fn(async () => "a".repeat(64)),
  currentPublication: vi.fn(async () => ({
    snapshotId: "a".repeat(64), preparedAt: "2026-10-23T00:00:00.000Z",
    loadedAt: "2026-10-23T00:00:00.000Z", sources: [],
  })),
  seasonSquadRows: vi.fn(async () => state.rows),
  seasonRecordRow: vi.fn(async () => null),
  seasonHistoryRows: vi.fn(async () => []),
}));

import app from "../worker/src/index";
import { seasonHistoryRows, seasonRecordRow, seasonSquadRows } from "../worker/src/core/db";

const env = {
  ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64),
  ACCESS_OWNER_EMAILS: "owner@example.invalid",
  DB: { prepare: vi.fn(() => ({ first: vi.fn(async () => ({ snapshot_id: "a".repeat(64), sources_json: "{}" })) })) },
} as unknown as Env;
const headers = { "cf-access-jwt-assertion": "synthetic", Origin: "https://site.invalid", "Sec-Fetch-Site": "same-origin" };
const request = (locale: string, query = "") => app.request(`https://site.invalid/${locale}/season/2018-19${query}`, { headers }, env);
const order = (html: string) => [...html.match(/<tbody>.*?<\/tbody>/s)![0]
  .matchAll(/<tr><td><a[^>]*>(.*?)<\/a>/g)].map(match => match[1]);

beforeEach(() => vi.clearAllMocks());

describe.each(["en", "es"] as const)("season squad sort route in %s", locale => {
  it("preserves database order without selectors", async () => {
    const response = await request(locale);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(order(html)).toEqual(["Goals leader", "Assists leader"]);
    expect(html).not.toContain("aria-sort=");
  });

  it.each(["goals_per90", "assists_per90"] as const)("defaults %s to descending", async sort => {
    const response = await request(locale, `?sort=${sort}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('aria-sort="descending"');
    expect(order(html)[0]).toBe(sort === "goals_per90" ? "Goals leader" : "Assists leader");
    expect(seasonSquadRows).toHaveBeenCalledExactlyOnceWith(env, "2018-19");
    expect(seasonHistoryRows).toHaveBeenCalledTimes(1);
    expect(seasonRecordRow).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["goals_per90", "asc", "Assists leader"],
    ["goals_per90", "desc", "Goals leader"],
    ["assists_per90", "asc", "Goals leader"],
    ["assists_per90", "desc", "Assists leader"],
  ] as const)("renders %s %s without extra database reads", async (sort, direction, first) => {
    const response = await request(locale, `?sort=${sort}&direction=${direction}`);
    expect(response.status).toBe(200);
    expect(order(await response.text())[0]).toBe(first);
    expect(seasonSquadRows).toHaveBeenCalledTimes(1);
    expect(seasonHistoryRows).toHaveBeenCalledTimes(1);
  });

  it.each([
    "sort=", "sort=goals", "sort=goals_per90&direction=", "sort=goals_per90&direction=ASC",
    "direction=asc", "sort=goals_per90&sort=goals_per90", "sort=goals_per90&sort=assists_per90",
    "sort=goals_per90&direction=asc&direction=asc",
  ])("rejects incomplete, unsupported or duplicate selectors before squad reads: %s", async query => {
    const response = await request(locale, `?${query}`);
    expect(response.status).toBe(400);
    expect(seasonSquadRows).not.toHaveBeenCalled();
    expect(seasonRecordRow).not.toHaveBeenCalled();
    expect(seasonHistoryRows).not.toHaveBeenCalled();
  });

  it("preserves query selectors and unrelated values through locale switching", async () => {
    const response = await request(locale, "?sort=assists_per90&direction=asc&keep=a%26b");
    const html = await response.text();
    const other = locale === "en" ? "es" : "en";
    const nav = html.match(/<nav class="lang-toggle".*?<\/nav>/s)![0];
    const urls = [...nav.matchAll(/href="([^"]+)"/g)]
      .map(match => new URL(match[1]!.replaceAll("&amp;", "&"), "https://site.invalid"));
    const target = urls.find(url => url.pathname === `/${other}/season/2018-19`)!;
    expect(target.searchParams.get("sort")).toBe("assists_per90");
    expect(target.searchParams.get("direction")).toBe("asc");
    expect(target.searchParams.get("keep")).toBe("a&b");
    const switched = await app.request(target.toString(), { headers }, env);
    expect(switched.status).toBe(200);
    const switchedHtml = await switched.text();
    expect(order(switchedHtml)[0]).toBe("Goals leader");
    expect(switchedHtml).toContain(other === "es" ? 'aria-label="Ordenar Asistencias / 90 de mayor a menor"' : 'aria-label="Sort Assists / 90 in descending order"');
  });
});
