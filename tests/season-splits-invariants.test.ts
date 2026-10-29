import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import { querySeasonSplits, type SeasonSplitRequest, type SeasonSplitRow } from "../worker/src/core/season-splits";
import { seasonSplitsBody, seasonSplitSelection } from "../worker/src/views/season-splits";

const SEED = 0x5ea50;
const snapshot = "synthetic-invariants";
const missingSeason = "2030-31";

// Independent fixtures at the required single-match grain, not aggregate rows.
function generate(index: number) {
  let state = SEED + index;
  const next = (limit: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 0x100000000) * limit);
  };
  const seasons = Array.from({ length: 1 + index % 4 }, (_, i) => `202${i}-2${i + 1}`);
  const rows: SeasonSplitRow[] = [];
  for (const season of seasons) for (const venue of ["home", "away"] as const) {
    // Include empty and one-venue-only cases, as well as uneven venue totals.
    const count = index % 20 === 0 || (index % 11 === 0 && venue === "away") ? 0 : next(7);
    for (let opponent = 1; opponent <= count; opponent++) {
      const outcome = index % 13 === 0 ? 2 : index % 17 === 0 ? 1 : next(3);
      const low = index % 13 === 0 || index % 17 === 0 ? 0 : next(4);
      const high = low + 1 + next(4);
      rows.push({ season, competition: "PL", venue, opponent_id: `club:${opponent}`,
        played: 1, won: Number(outcome === 0), drawn: Number(outcome === 1), lost: Number(outcome === 2),
        goals_for: outcome === 0 ? high : low, goals_against: outcome === 2 ? high : low,
        snapshot_id: snapshot, lineage: ["synthetic:invariants"] });
    }
  }
  return { index, seasons, rows };
}
const cases = Array.from({ length: 240 }, (_, index) => generate(index));
type Case = (typeof cases)[number];
type Code = "en" | "es";

it("keeps the seeded corpus diverse and reproducible", () => {
  expect(cases).toEqual(Array.from({ length: 240 }, (_, index) => generate(index)));
  expect(new Set(cases.map(value => JSON.stringify(value.rows))).size).toBeGreaterThanOrEqual(200);
  expect(new Set(cases.map(value => value.seasons.length))).toEqual(new Set([1, 2, 3, 4]));
  expect(cases.some(value => value.rows.length === 0)).toBe(true);
  expect(cases.some(value => value.rows.length > 0 && value.rows.every(row => row.lost === 1))).toBe(true);
  expect(cases.some(value => value.rows.length > 0 && value.rows.every(row => row.drawn === 1 && row.goals_for === 0))).toBe(true);
});

// Oracle uses score comparisons, independently of the fixture W/D/L fields.
function oracle(rows: SeasonSplitRow[]) {
  const won = rows.filter(r => r.goals_for > r.goals_against).length;
  const drawn = rows.filter(r => r.goals_for === r.goals_against).length;
  const lost = rows.length - won - drawn;
  const gf = rows.reduce((sum, r) => sum + r.goals_for, 0);
  const ga = rows.reduce((sum, r) => sum + r.goals_against, 0);
  return [rows.length, won, drawn, lost, gf, ga, gf - ga, 3 * won + drawn];
}
function run(value: Case, coverage: "complete" | "partial", missing = false) {
  const seasons = missing ? [...value.seasons, missingSeason] : value.seasons;
  const request: SeasonSplitRequest = { schema_version: 1, competition: "PL", seasons,
    group_by: "venue", venue: null, opponent_id: null };
  return querySeasonSplits(request, { snapshot_id: snapshot, seasons: [
    ...value.seasons.map(season => ({ season, coverage })),
    ...(missing ? [{ season: missingSeason, coverage: "missing" }] : []),
  ] }, value.rows);
}
function render(result: ReturnType<typeof run>, code: Code) {
  return seasonSplitsBody({ selection: seasonSplitSelection(result.request),
    seasons: result.request.seasons, opponents: [], result,
    credits: { "synthetic:invariants": "Synthetic fixture credit" } }, LOCALES[code]);
}
function bodyRows(body: string) {
  const tbody = body.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
  return [...tbody.matchAll(/<tr><th scope="row">([^<]*)<\/th>([\s\S]*?)<\/tr>/g)].map(match => ({
    label: match[1]!, cells: [...match[2]!.matchAll(/<td>([\s\S]*?)<\/td>/g)].map(cell => cell[1]!),
  }));
}
function checkTable(value: Case, result: ReturnType<typeof run>, code: Code) {
  const body = render(result, code), rows = bodyRows(body);
  if (!value.rows.length) {
    expect(result.groups).toEqual([]);
    expect(body).not.toContain("<table");
    expect(rows).toEqual([]);
    expect(result.status).toBe(result.partial ? "missing_capability" : "no_matches");
    expect(body).toContain(result.partial
      ? code === "en" ? "No zero-match total is implied" : "No se afirma un total de cero partidos"
      : code === "en" ? "No completed matches match" : "Ningún partido finalizado coincide");
    return;
  }
  expect(result.status).toBe("available");
  const format = (n: number, digits = 0) => new Intl.NumberFormat(code === "en" ? "en-GB" : "es-ES", {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(n);
  const expectedVenues = ["away", "home"].filter(venue => value.rows.some(r => r.venue === venue));
  const overall = rows.at(-1)!;
  expect(rows).toHaveLength(expectedVenues.length + 1);
  expect(overall.label).toBe((code === "en" ? "All matches" : "Todos los partidos")
    + (result.partial ? code === "en" ? " · partial subtotals" : " · subtotales parciales" : ""));
  const totals = oracle(value.rows);
  expect(overall.cells.slice(0, 8)).toEqual(totals.map(n => format(n)));
  for (const [i, venue] of expectedVenues.entries()) {
    const expected = oracle(value.rows.filter(r => r.venue === venue));
    expect(rows[i]!.label).toBe(venue === "home" ? code === "en" ? "Home" : "Local"
      : code === "en" ? "Away" : "Visitante");
    expect(rows[i]!.cells.slice(0, 8)).toEqual(expected.map(n => format(n)));
    const group = result.groups.find(g => g.key === venue)!;
    expect([group.played, group.won, group.drawn, group.lost, group.goals_for,
      group.goals_against, group.goal_difference, group.points]).toEqual(expected);
    expect(group.points).toBe(3 * group.won + group.drawn);
    expect(group.rate_denominator).toBe(expected[0]);
    expect(group.points_per_match).toBe(expected[7]! / expected[0]!);
    expect(group.goals_for_per_match).toBe(expected[4]! / expected[0]!);
    expect(group.goals_against_per_match).toBe(expected[5]! / expected[0]!);
    expect(group.win_rate).toBe(expected[1]! / expected[0]!);
    expect(rows[i]!.cells.slice(8, 12)).toEqual([expected[7]!, expected[4]!, expected[5]!, 100 * expected[1]!]
      .map(n => format(n / expected[0]!, 2)));
  }
  for (let column = 0; column < 8; column++) {
    // Counters are small (<1000), so neither locale introduces grouping marks.
    expect(Number(overall.cells[column])).toBe(rows.slice(0, -1).reduce((sum, row) => sum + Number(row.cells[column]), 0));
  }
  expect(Number(overall.cells[7])).toBe(3 * Number(overall.cells[1]) + Number(overall.cells[2]));
  expect(overall.cells.slice(8, 12)).toEqual([totals[7]!, totals[4]!, totals[5]!, 100 * totals[1]!]
    .map(n => format(n / totals[0]!, 2)));
  expect(body).toContain(result.partial
    ? code === "en" ? "Missing matches are not zero" : "Los partidos ausentes no equivalen a cero"
    : code === "en" ? ": Complete" : ": Completa");
}

describe.each(["en", "es"] as const)("%s season-splits seeded invariants", code => {
  it.each(cases)(`seed ${SEED}, case $index: counters, points, partial rates and missingness`, value => {
    const complete = run(value, "complete"), partial = run(value, "partial");
    checkTable(value, complete, code);
    checkTable(value, partial, code);
    // Missing fixtures change coverage, never observed counts or denominators.
    expect(partial.groups).toEqual(complete.groups);
    const missing = run(value, "complete", true);
    expect(missing.groups).toEqual(complete.groups);
    expect(missing.partial).toBe(true);
    expect(missing.coverage.at(-1)).toEqual({ season: missingSeason, coverage: "missing" });
    checkTable(value, missing, code);
    expect(render(missing, code)).toContain(`${missingSeason}: ${code === "en" ? "Missing split coverage" : "Sin cobertura de desgloses"}`);
    const allMissing = run({ ...value, seasons: [], rows: [] }, "complete", true);
    expect(allMissing.groups).toEqual([]);
    expect(allMissing.status).toBe("missing_capability");
    expect(render(allMissing, code)).not.toContain("<table");
  });
});
