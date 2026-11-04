import type { LocaleCode } from "./locale";

/** Shared by GET registration and the Access same-origin boundary. Keep arrivals
 * and CL history protected even though they currently do not debit the budget. */
export const COMPUTE_GET_ROUTES = Object.freeze({
  query: "/q",
  playerComparison: "/players/compare",
  playerTrends: "/players/trends",
  opponentHistory: "/opponents/history",
  seasonExploration: "/seasons/explore",
  championsLeague: "/seasons/champions-league",
  arrivals: "/discover/arrivals",
} as const);

export function computeGetPath(route: keyof typeof COMPUTE_GET_ROUTES, locale?: LocaleCode): string {
  return `${locale ? `/${locale}` : ""}${COMPUTE_GET_ROUTES[route]}`;
}

const protectedPaths = new Set(Object.values(COMPUTE_GET_ROUTES).flatMap(path =>
  [path, `/en${path}`, `/es${path}`].flatMap(path => [path, `${path}/`]),
));

/** Receives Hono's decoded request path; do not decode a second time. */
export function isComputeGetPath(path: string): boolean {
  return protectedPaths.has(path);
}
