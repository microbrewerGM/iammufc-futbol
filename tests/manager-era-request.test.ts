import { describe, expect, it } from "vitest";
import { parseManagerEraRequest } from "../worker/src/core/manager-era-request";

const catalog = {
  manager_ids: ["manager:one", "manager:two"],
  seasons: ["2025-26", "2023-24", "2024-25"],
};
const parse = (query: string) => parseManagerEraRequest(new URLSearchParams(query), catalog);

describe("manager-era query controls", () => {
  it("defaults to the all-manager list with canonical catalog seasons", () => {
    expect(parse("")).toEqual({ ok: true, request: {
      competition: "PL", manager_id: null, seasons: ["2023-24", "2024-25", "2025-26"],
    } });
  });

  it("keeps an empty catalog empty for the no-data route state", () => {
    expect(parseManagerEraRequest(new URLSearchParams(), { manager_ids: [], seasons: [] }))
      .toEqual({ ok: true, request: { competition: "PL", manager_id: null, seasons: [] } });
  });

  it("accepts a stable manager identity and preserves noncontiguous seasons", () => {
    expect(parse("manager_id=manager%3Aone&seasons=2025-26&seasons=2023-24"))
      .toEqual({ ok: true, request: { competition: "PL", manager_id: "manager:one", seasons: ["2023-24", "2025-26"] } });
  });

  it("distinguishes unknown identity from a known manager with no selected-season facts", () => {
    expect(parse("manager_id=manager:unknown")).toEqual({ ok: false, status: 404, code: "manager_not_found" });
    // The catalog admits this identity; row presence/coverage is not a parser decision.
    expect(parse("manager_id=manager:two&seasons=2023-24")).toMatchObject({ ok: true });
  });

  it.each(["", "one", "Manager:one", "manager:", "manager:one' OR 1=1", "manager:" + "a".repeat(56)])(
    "rejects malformed or name-based manager selector %j", (manager) => {
      expect(parse(new URLSearchParams({ manager_id: manager }).toString()))
        .toEqual({ ok: false, status: 400, code: "invalid_manager_id" });
    },
  );

  it.each(["", "2023", "2023-25", "2023-2024", " 2023-24", "2023-24' OR 1=1"]) (
    "rejects malformed season %j with a typed 400", (season) => {
      expect(parse(new URLSearchParams({ seasons: season }).toString()))
        .toEqual({ ok: false, status: 400, code: "invalid_season" });
    },
  );

  it("rejects unsupported seasons instead of replacing them with defaults", () => {
    expect(parse("seasons=2022-23")).toEqual({ ok: false, status: 400, code: "unsupported_season" });
  });

  it("rejects ambiguous duplicate scalar and season controls", () => {
    expect(parse("manager_id=manager:one&manager_id=manager:one"))
      .toEqual({ ok: false, status: 400, code: "duplicate_manager_id" });
    expect(parse("seasons=2023-24&seasons=2023-24"))
      .toEqual({ ok: false, status: 400, code: "duplicate_season" });
  });

  it("enforces the 16-season read bound on explicit and default selections", () => {
    const seasons = Array.from({ length: 17 }, (_, i) => `${2009 + i}-${String((2010 + i) % 100).padStart(2, "0")}`);
    const metadata = { manager_ids: [], seasons };
    const query = new URLSearchParams();
    seasons.slice(0, 16).reverse().forEach(season => query.append("seasons", season));
    expect(parseManagerEraRequest(query, metadata)).toEqual({ ok: true, request: {
      competition: "PL", manager_id: null, seasons: seasons.slice(0, 16),
    } });
    query.append("seasons", seasons[16]!);
    expect(parseManagerEraRequest(query, metadata)).toEqual({ ok: false, status: 400, code: "season_count" });
    expect(parseManagerEraRequest(new URLSearchParams(), metadata))
      .toEqual({ ok: false, status: 400, code: "season_count" });
  });

  it("rejects unknown controls rather than silently changing query meaning", () => {
    expect(parse("competition=CL")).toEqual({ ok: false, status: 400, code: "unknown_parameter" });
    expect(parse("season=2023-24")).toEqual({ ok: false, status: 400, code: "unknown_parameter" });
  });

  it("preserves caller arrays and query parameters", () => {
    const metadata = { manager_ids: Object.freeze([...catalog.manager_ids]), seasons: Object.freeze([...catalog.seasons]) };
    const query = new URLSearchParams("seasons=2025-26&seasons=2023-24");
    parseManagerEraRequest(query, metadata);
    parseManagerEraRequest(new URLSearchParams(), metadata);
    expect(metadata.seasons).toEqual(catalog.seasons);
    expect(query.toString()).toBe("seasons=2025-26&seasons=2023-24");
  });
});
