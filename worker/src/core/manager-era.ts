import type { Env } from "./db";
export type { Env } from "./db";

export type EraCoverage = "complete" | "partial" | "missing";
export interface ManagerEraCatalog {
  snapshot_id: string;
  seasons: { season: string; coverage: EraCoverage; completed: number; unfinished: number; ambiguous: number }[];
}
interface Counts { played: number; won: number; drawn: number; lost: number; goals_for: number; goals_against: number }
export interface ManagerEraRow extends Counts {
  snapshot_id: string; season: string; tenure_id: string; manager_id: string; role: "manager" | "caretaker";
  lineage: string[];
}
export interface ManagerEraUnassigned extends Counts { snapshot_id: string; season: string; reason: string; lineage: string[] }
export interface ManagerEraManager { snapshot_id: string; manager_id: string; label: string; lineage: string[] }
export interface ManagerEraResult {
  snapshot_id: string;
  coverage: ManagerEraCatalog["seasons"];
  managers: { tenure_id: string; manager_id: string; manager: string; role: "manager" | "caretaker"; selected_window: boolean }[];
  eras: (Counts & { tenure_id: string; manager_id: string; manager: string; role: "manager" | "caretaker"; points: number })[];
  unassigned: (Counts & { reason: string; points: number })[];
}

const fail = (message: string): never => { throw new Error(`Invalid manager eras: ${message}`); };
const MAX_RECORDS = 16 * 128;
const COUNTERS = ["played", "won", "drawn", "lost", "goals_for", "goals_against"] as const;
const validSeason = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}$/.test(s) && Number(s.slice(-2)) === (Number(s.slice(0, 4)) + 1) % 100;
const validCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
function lineage(value: unknown): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 32 && value.every(x => typeof x === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(x)) && new Set(value).size === value.length;
}
function add(a: number, b: number): number { const n = a + b; return Number.isSafeInteger(n) ? n : fail("counter overflow"); }

/** Validate bounded projections from D1 and sum only seasons with proven coverage. */
export function queryManagerEras(snapshotId: unknown, seasonsValue: unknown, eraValue: unknown, unassignedValue: unknown,
  managerValue: unknown, coverageValue: unknown): ManagerEraResult {
  if (typeof snapshotId !== "string" || !/^[0-9a-f]{64}$/.test(snapshotId)) fail("snapshot");
  if (!Array.isArray(seasonsValue) || seasonsValue.length < 1 || seasonsValue.length > 16 ||
      seasonsValue.some(s => !validSeason(s)) || new Set(seasonsValue).size !== seasonsValue.length) fail("selection");
  const selected = new Set(seasonsValue as string[]);
  if (![eraValue, unassignedValue, managerValue, coverageValue].every(Array.isArray)) fail("rows");
  const eraRows = eraValue as Record<string, unknown>[], unassignedRows = unassignedValue as Record<string, unknown>[];
  const managerRows = managerValue as Record<string, unknown>[], coverageRows = coverageValue as Record<string, unknown>[];
  if (eraRows.length > MAX_RECORDS || unassignedRows.length > MAX_RECORDS || managerRows.length > 128 || coverageRows.length > 16) fail("row bound");
  const coverageMap = new Map<string, ManagerEraCatalog["seasons"][number]>();
  for (const row of coverageRows) {
    if (row.snapshot_id !== snapshotId || !validSeason(row.season) || !selected.has(row.season as string) || coverageMap.has(row.season as string) ||
        !["complete", "partial", "missing"].includes(String(row.coverage)) || !["completed", "unfinished", "ambiguous"].every(k => validCount(row[k])) || !lineage(row.lineage)) fail("coverage row");
    coverageMap.set(row.season as string, { season: row.season as string, coverage: row.coverage as EraCoverage,
      completed: row.completed as number, unfinished: row.unfinished as number, ambiguous: row.ambiguous as number });
  }
  const coverage = [...selected].sort().map(season => coverageMap.get(season) ?? { season, coverage: "missing" as const, completed: 0, unfinished: 0, ambiguous: 0 });
  const managers = new Map<string, ManagerEraManager>();
  for (const row of managerRows) {
    if (row.snapshot_id !== snapshotId || typeof row.manager_id !== "string" || !/^manager:[a-z0-9:_-]{1,55}$/.test(row.manager_id) ||
        typeof row.label !== "string" || row.label.length < 1 || row.label.length > 80 || /[\u0000-\u001f\u007f]/.test(row.label) || !lineage(row.lineage) || managers.has(row.manager_id)) fail("manager row");
    const managerId = row.manager_id as string, label = row.label as string, sources = row.lineage as string[], currentSnapshot = snapshotId as string;
    managers.set(managerId, { snapshot_id: currentSnapshot, manager_id: managerId, label, lineage: sources });
  }
  const validCounts = (row: Record<string, unknown>) => COUNTERS.every(k => validCount(row[k])) &&
    Number(row.won) + Number(row.drawn) + Number(row.lost) === row.played;
  const totals = new Map<string, Counts & { manager_id: string; role: "manager" | "caretaker"; seasons: Set<string>; allSeasons: Set<string> }>();
  const seenEras = new Set<string>();
  for (const row of eraRows) {
    if (row.snapshot_id !== snapshotId || !validSeason(row.season) || typeof row.tenure_id !== "string" || !/^tenure:[a-z0-9:_-]{1,55}$/.test(row.tenure_id) ||
        typeof row.manager_id !== "string" || !/^manager:[a-z0-9:_-]{1,55}$/.test(row.manager_id) ||
        (row.role !== "manager" && row.role !== "caretaker") || !validCounts(row) || !lineage(row.lineage)) fail("era row");
    const season = row.season as string;
    const tenureId = row.tenure_id as string;
    const managerId = row.manager_id as string;
    const role = row.role as "manager" | "caretaker";
    const key = `${season}\0${tenureId}`;
    if (seenEras.has(key)) fail("duplicate era"); seenEras.add(key);
    let bucket = totals.get(tenureId);
    if (!bucket) { bucket = { manager_id: managerId, role, played: 0, won: 0, drawn: 0, lost: 0, goals_for: 0, goals_against: 0, seasons: new Set(), allSeasons: new Set() }; totals.set(tenureId, bucket); }
    if (bucket.manager_id !== managerId || bucket.role !== role) fail("tenure identity changed");
    const target = bucket;
    if (!selected.has(season) || coverageMap.get(season)?.coverage === "complete") target.allSeasons.add(season);
    if (!selected.has(season)) continue;
    if (coverageMap.get(season)?.coverage !== "complete") continue;
    for (const counter of COUNTERS) target[counter] = add(target[counter], row[counter] as number);
    target.seasons.add(season);
  }
  const unassigned = new Map<string, Counts>();
  for (const row of unassignedRows) {
    if (row.snapshot_id !== snapshotId || !validSeason(row.season) || typeof row.reason !== "string" ||
        !["boundary_unresolved", "tenure_overlap", "date_uncertain", "tenure_missing"].includes(row.reason) || !validCounts(row) || !lineage(row.lineage)) fail("unassigned row");
    if (!selected.has(row.season as string) || coverageMap.get(row.season as string)?.coverage !== "complete") continue;
    const reason = row.reason as string;
    let bucket = unassigned.get(reason); if (!bucket) { bucket = { played: 0, won: 0, drawn: 0, lost: 0, goals_for: 0, goals_against: 0 }; unassigned.set(reason, bucket); }
    const target = bucket;
    for (const counter of COUNTERS) target[counter] = add(target[counter], row[counter] as number);
  }
  const eraResults = [...totals].filter(([, t]) => t.seasons.size && managers.has(t.manager_id)).sort(([a], [b]) => a.localeCompare(b)).map(([tenure_id, t]) => ({
    tenure_id, manager_id: t.manager_id, manager: managers.get(t.manager_id)!.label, role: t.role, ...Object.fromEntries(COUNTERS.map(k => [k, t[k]])) as unknown as Counts,
    points: add(add(t.won, t.won), add(t.won, t.drawn)),
  }));
  const managerLabels = eraResults.map(row => { const t = totals.get(row.tenure_id)!; return { tenure_id: row.tenure_id, manager_id: row.manager_id,
    manager: row.manager, role: row.role, selected_window: t.seasons.size < t.allSeasons.size }; });
  return { snapshot_id: snapshotId as string, coverage, managers: managerLabels, eras: eraResults,
    unassigned: [...unassigned].sort(([a], [b]) => a.localeCompare(b)).map(([reason, counts]) => ({ reason, ...counts, points: add(add(counts.won, counts.won), add(counts.won, counts.drawn)) })) };
}

/** Read the four frozen 0009 projections for a bounded selected season window. */
export async function managerEraFacts(env: Env, snapshotId: string, seasons: readonly string[]): Promise<ManagerEraResult> {
  if (!/^[0-9a-f]{64}$/.test(snapshotId) || seasons.length < 1 || seasons.length > 16 || seasons.some(s => !validSeason(s)) || new Set(seasons).size !== seasons.length) fail("selection");
  const publication = await env.DB.prepare(`SELECT r.snapshot_id FROM publication_runs r JOIN snapshots s ON s.snapshot_id = r.snapshot_id ORDER BY r.run_id DESC LIMIT 1`)
    .first<{ snapshot_id: unknown }>();
  if (publication?.snapshot_id !== snapshotId) fail("stale publication");
  const marks = seasons.map(() => "?").join(",");
  const era = await env.DB.prepare(`SELECT snapshot_id, season, tenure_id, manager_id, role, played, won, drawn, lost, goals_for, goals_against, lineage_json FROM manager_era_season_records WHERE snapshot_id = ? ORDER BY season, tenure_id LIMIT ${MAX_RECORDS + 1}`)
    .bind(snapshotId).all<Record<string, unknown> & { lineage_json: string }>();
  const unassigned = await env.DB.prepare(`SELECT snapshot_id, season, reason, played, won, drawn, lost, goals_for, goals_against, lineage_json FROM manager_era_season_unassigned WHERE snapshot_id = ? AND season IN (${marks}) ORDER BY season, reason LIMIT ${MAX_RECORDS + 1}`)
    .bind(snapshotId, ...seasons).all<Record<string, unknown> & { lineage_json: string }>();
  const coverage = await env.DB.prepare(`SELECT snapshot_id, season, coverage, completed, unfinished, ambiguous, lineage_json FROM manager_era_season_coverage WHERE snapshot_id = ? AND season IN (${marks}) ORDER BY season LIMIT 17`)
    .bind(snapshotId, ...seasons).all<Record<string, unknown> & { lineage_json: string }>();
  const managers = await env.DB.prepare(`SELECT snapshot_id, manager_id, label, lineage_json FROM manager_era_managers WHERE snapshot_id = ? ORDER BY manager_id LIMIT 129`)
    .bind(snapshotId).all<Record<string, unknown> & { lineage_json: string }>();
  const after = await env.DB.prepare(`SELECT r.snapshot_id FROM publication_runs r JOIN snapshots s ON s.snapshot_id = r.snapshot_id ORDER BY r.run_id DESC LIMIT 1`)
    .first<{ snapshot_id: unknown }>();
  if (after?.snapshot_id !== snapshotId) fail("publication changed during read");
  const decode = (rows: (Record<string, unknown> & { lineage_json: string })[]) => rows.map(({ lineage_json, ...row }) => {
    let parsed: unknown; try { parsed = JSON.parse(lineage_json); } catch { fail("lineage JSON"); }
    return { ...row, lineage: parsed };
  });
  if ((era.results ?? []).length > MAX_RECORDS || (unassigned.results ?? []).length > MAX_RECORDS || (coverage.results ?? []).length > 16 || (managers.results ?? []).length > 128) fail("read bound");
  return queryManagerEras(snapshotId, seasons, decode(era.results ?? []), decode(unassigned.results ?? []), decode(managers.results ?? []), decode(coverage.results ?? []));
}
