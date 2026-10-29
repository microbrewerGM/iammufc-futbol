export interface ManagerEraRequest {
  competition: "PL";
  manager_id: string | null;
  seasons: string[];
}

/** Caller supplies identities and seasons from the validated snapshot catalog. */
export interface ManagerEraRequestCatalog {
  manager_ids: readonly string[];
  seasons: readonly string[];
}

export type ManagerEraRequestResult =
  | { ok: true; request: ManagerEraRequest }
  | { ok: false; status: 404; code: "manager_not_found" }
  | { ok: false; status: 400; code: "unknown_parameter" | "duplicate_manager_id"
      | "invalid_manager_id" | "season_count" | "invalid_season" | "duplicate_season" | "unsupported_season" };

/**
 * Locale-neutral controls: optional manager_id and repeated seasons parameters.
 * Omitted controls list every catalog manager over the catalog seasons; an empty
 * catalog stays empty for the route's no-data state. Coverage is never inferred.
 * Explicit season selections are unique, bounded and canonicalized, never clipped.
 */
export function parseManagerEraRequest(
  params: URLSearchParams,
  catalog: ManagerEraRequestCatalog,
): ManagerEraRequestResult {
  for (const key of params.keys()) {
    if (key !== "manager_id" && key !== "seasons") {
      return { ok: false, status: 400, code: "unknown_parameter" };
    }
  }
  const managers = params.getAll("manager_id");
  if (managers.length > 1) return { ok: false, status: 400, code: "duplicate_manager_id" };
  const managerId = managers[0] ?? null;
  if (managerId !== null && !/^manager:[a-z0-9:_-]{1,55}$/.test(managerId)) {
    return { ok: false, status: 400, code: "invalid_manager_id" };
  }

  const selected = params.getAll("seasons");
  const seasons = selected.length ? selected : [...catalog.seasons];
  if (seasons.length > 16) return { ok: false, status: 400, code: "season_count" };
  const seen = new Set<string>();
  for (const season of seasons) {
    if (!/^\d{4}-\d{2}$/.test(season) || Number(season.slice(-2)) !== (Number(season.slice(0, 4)) + 1) % 100) {
      return { ok: false, status: 400, code: "invalid_season" };
    }
    if (seen.has(season)) return { ok: false, status: 400, code: "duplicate_season" };
    if (!catalog.seasons.includes(season)) return { ok: false, status: 400, code: "unsupported_season" };
    seen.add(season);
  }
  if (managerId !== null && !catalog.manager_ids.includes(managerId)) {
    return { ok: false, status: 404, code: "manager_not_found" };
  }
  return { ok: true, request: { competition: "PL", manager_id: managerId, seasons: seasons.sort() } };
}
