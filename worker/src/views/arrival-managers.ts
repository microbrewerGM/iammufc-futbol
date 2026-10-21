import type { ArrivalManagerRequest } from "../core/discovery-arrivals";
import type { Locale } from "../core/locale";
import { esc } from "./layout";

export type ArrivalUnknownReason = "identity_unresolved" | "spell_missing" | "arrival_missing" |
  "promotion_missing" | "date_uncertain" | "boundary_unresolved" | "tenure_missing" |
  "tenure_overlap" | "source_conflict";
interface MemberRow { member_id: string; person_id: string | null; spell_id: string | null; lineage: string[] }
/** Mirrors the frozen B15-CONTRACT result, not a decoder or publication verifier. */
export interface ArrivalManagerResult {
  request: ArrivalManagerRequest;
  snapshot_id: string; artifact_key: string; transform_code_version: string; renderer_version: string;
  roster_snapshot_id: string | null;
  feasibility: "available" | "computable_now_queued" | "computable_but_expensive" | "no_data" | "no_rights";
  coverage: "complete" | "partial" | "missing";
  population_count: number;
  assigned: (MemberRow & { person_id: string; spell_id: string; manager_id: string; event_id: string; tenure_id: string })[];
  unknown: (MemberRow & { reason: ArrivalUnknownReason })[];
  lineage: string[];
}
export interface ArrivalEntry {
  event_type: "effective_arrival" | "registration" | "first_team_promotion" | "re_signing";
  date: { earliest: string; latest: string; precision: "day" | "month" | "range" } | null;
}
export interface ArrivalManagerView {
  request: ArrivalManagerRequest;
  result?: ArrivalManagerResult;
  error?: string;
  /** Public-safe, validated identity labels and chosen entries, never raw source rows.
   * Assigned entries are keyed by event_id; unknown entries by stable member_id. */
  players: Readonly<Record<string, string>>;
  managers: Readonly<Record<string, string>>;
  entries: Readonly<Record<string, ArrivalEntry>>;
  unknown_entries?: Readonly<Record<string, ArrivalEntry>>;
  /** Localized attribution resolved from validated result lineage by the adapter. */
  credits: Readonly<Record<string, string>>;
  roster?: { observed_at: string; freshness: "dated" | "stale" };
  /** Sanitized read status only; no lease, worker identity or upstream error text. */
  job?: { status: "not_queued" | "queued" | "running" | "failed" | "published" };
}
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const own = <T>(map: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(map, key) ? map[key] : undefined;
const label = (map: Readonly<Record<string, string>>, key: string) => {
  const value = own(map, key);
  return typeof value === "string" && value.trim() ? value : key;
};
function fields(request: ArrivalManagerRequest): [string, string][] {
  return [["academy_basis", request.academy_basis], ["as_of", request.as_of],
    ["family", request.family], ["joining_basis", request.joining_basis],
    ["population", request.population], ["version", String(request.version)],
    ["visualization", request.visualization]];
}
/** A question link, not an immutable artifact link. Replay pins as_of; WIRE owns routing. */
export function arrivalManagerHref(request: ArrivalManagerRequest, locale: "en" | "es"): string {
  return `/${locale}/discover/arrivals?${new URLSearchParams(fields(request)).toString()}`;
}
/** Body fragment for validated/sanitized inputs only. B15-WIRE must validate schema,
 * semantic joins, request/snapshot/publication/rights and label provenance per read.
 * No endpoint, freshness policy, job admission or availability is established here. */
export function arrivalManagersBody(model: ArrivalManagerView, locale: Locale): string {
  const t = (en: string, es: string) => locale.code === "es" ? es : en;
  const title = t("Players by manager at joining", "Jugadores por entrenador al llegar");
  const request = model.request;
  const mismatch = model.result && fields(request).some(([key, value]) =>
    !fields(model.result!.request).some(([k, v]) => k === key && v === value));
  const error = model.error ?? (mismatch ? t("The result belongs to a different dated question.", "El resultado corresponde a otra pregunta fechada.") : undefined);
  const result = error ? undefined : model.result;
  const interpretation = `<p id="arrivals-interpretation">${t(
    "Dated United first-team squad, grouped by the manager in charge at effective entry into each player's selected first-team spell. Includes incoming loans, excludes outgoing loans and retains injured and suspended players. Academy players use documented first-team promotion; absent evidence stays unknown. This does not identify who recruited a player.",
    "Plantilla del primer equipo del United en una fecha concreta, agrupada por el entrenador al mando al inicio efectivo de la etapa seleccionada de cada jugador. Incluye cedidos entrantes, excluye cedidos salientes y conserva lesionados y sancionados. Para canteranos se usa la promoción documentada al primer equipo; si falta evidencia, se conserva como desconocida. No indica quién fichó al jugador.")}</p>`;
  const form = `<form method="get" action="/${locale.code}/discover/arrivals" aria-describedby="arrivals-interpretation">
    ${fields(request).filter(([k]) => k !== "as_of").map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join("")}
    <label for="arrivals-as-of">${t("Squad date", "Fecha de plantilla")}</label>
    <input id="arrivals-as-of" name="as_of" type="date" required value="${esc(request.as_of)}">
    <button type="submit">${t("Confirm dated question", "Confirmar pregunta fechada")}</button></form>`;
  const head = `<h1>${title}</h1>${error ? `<p role="alert">${esc(error)}</p>` : ""}${interpretation}${form}`;
  if (!result) return head;
  const feasibility = {
    available: t("Available", "Disponible"), computable_now_queued: t("Awaiting validated data", "A la espera de datos validados"),
    computable_but_expensive: t("Outside the current computation budget", "Fuera del presupuesto de cálculo actual"),
    no_data: t("Required data unavailable", "Datos necesarios no disponibles"), no_rights: t("Data use is not permitted for this question", "No se permite usar los datos para esta pregunta"),
  };
  const job = {
    not_queued: t("Not queued", "Sin tarea en cola"), queued: t("Queued", "En cola"), running: t("Running", "En curso"),
    failed: t("Failed", "Fallida"), published: t("Published; result availability is checked separately", "Publicada; la disponibilidad del resultado se comprueba por separado"),
  };
  const status = `<p role="status">${feasibility[result.feasibility]}</p>${model.job ? `<p>${t("Data task", "Tarea de datos")}: ${job[model.job.status]}. ${t("Task progress alone does not make data available.", "El progreso de la tarea por sí solo no hace que los datos estén disponibles.")}</p>` : ""}`;
  const revisit = `<p><a href="${esc(arrivalManagerHref(request, locale.code))}">${t("Revisit this dated question", "Volver a esta pregunta fechada")}</a> · ${t("The question date stays fixed; a later validated snapshot may change the result.", "La fecha de la pregunta se conserva; una versión posterior validada puede cambiar el resultado.")}</p>`;
  // Denied scope never reveals people, source details or snapshot metadata.
  if (result.feasibility === "no_rights") return `${head}${status}${revisit}`;
  const coverage = { complete: t("Complete for this dated selection", "Completa para esta selección fechada"), partial: t("Partial; unknowns and gaps remain", "Parcial; persisten casos desconocidos y lagunas"), missing: t("Missing", "Ausente") };
  const summary = `<p id="arrivals-summary">${t("Squad as of", "Plantilla a fecha de")}: ${esc(request.as_of)} · ${t("Coverage", "Cobertura")}: ${coverage[result.coverage]}</p>`;
  const roster = model.roster && result.roster_snapshot_id !== null ? `<p>${t("Observed at", "Observada el")}: ${esc(model.roster.observed_at)} · ${model.roster.freshness === "stale" ? t("Stale dated squad", "Plantilla fechada desactualizada") : t("Dated squad; current freshness not established", "Plantilla fechada; vigencia actual no acreditada")}</p>` : result.roster_snapshot_id !== null ? `<p>${t("Squad observation time and current freshness unavailable.", "Hora de observación y vigencia actual de la plantilla no disponibles.")}</p>` : "";
  const reason: Record<ArrivalUnknownReason, string> = {
    identity_unresolved: t("Player identity unresolved", "Identidad del jugador sin resolver"), spell_missing: t("First-team spell missing", "Falta la etapa en el primer equipo"),
    arrival_missing: t("Effective entry missing", "Falta el inicio efectivo"), promotion_missing: t("Documented first-team promotion missing", "Falta la promoción documentada al primer equipo"),
    date_uncertain: t("Entry date uncertain", "Fecha de inicio incierta"), boundary_unresolved: t("Responsibility boundary unresolved", "Límite de responsabilidad sin resolver"),
    tenure_missing: t("Manager responsibility evidence missing", "Falta evidencia del periodo del entrenador"), tenure_overlap: t("Overlapping manager responsibility", "Periodos de entrenadores superpuestos"),
    source_conflict: t("Conflicting source evidence", "Evidencia contradictoria entre fuentes"),
  };
  const eventName: Record<ArrivalEntry["event_type"], string> = {
    effective_arrival: t("Effective arrival", "Llegada efectiva"), registration: t("Registration", "Inscripción"),
    first_team_promotion: t("Documented first-team promotion", "Promoción documentada al primer equipo"), re_signing: t("New spell after re-signing", "Nueva etapa tras volver a fichar"),
  };
  const missing = `<span aria-label="${t("Missing data", "Datos ausentes")}">—</span>`;
  const entryCells = (entry: ArrivalEntry | undefined) => {
    const date = entry?.date;
    return `<td>${entry ? eventName[entry.event_type] : missing}</td><td>${date ? `${esc(date.earliest)}${date.earliest === date.latest ? "" : ` – ${esc(date.latest)}`}${date.precision === "day" ? "" : ` (${date.precision === "month" ? t("month precision", "precisión mensual") : t("uncertain range", "intervalo incierto")})`}` : missing}</td>`;
  };
  let table: string;
  if (result.roster_snapshot_id === null) {
    table = `<p>${t("Squad data is missing. The number of players is unknown, not zero.", "Faltan los datos de plantilla. El número de jugadores es desconocido, no cero.")}</p>`;
  } else {
    const counts = `<p>${t("Selected players", "Jugadores seleccionados")}: ${result.population_count} · ${t("Assigned", "Asignados")}: ${result.assigned.length} · ${t("Unknown", "Desconocidos")}: ${result.unknown.length}</p>`;
    const managerIds = [...new Set(result.assigned.map(r => r.manager_id))].sort(order);
    const groups = managerIds.map(id => {
      const rows = result.assigned.filter(r => r.manager_id === id).sort((a, b) => order(a.member_id, b.member_id));
      const name = label(model.managers, id);
      return `<tbody><tr><th scope="rowgroup" colspan="5">${esc(name)} · ${rows.length}</th></tr>${rows.map(r => `<tr><th scope="row">${esc(label(model.players, r.member_id))}</th><td>${esc(name)}</td>${entryCells(own(model.entries, r.event_id))}<td>${t("Manager in charge at effective entry", "Entrenador al mando al inicio efectivo")}</td></tr>`).join("")}</tbody>`;
    }).join("");
    const unknowns = [...result.unknown].sort((a, b) => order(a.member_id, b.member_id));
    const unknownRows = unknowns.length ? `<tbody><tr><th scope="rowgroup" colspan="5">${t("Unknown manager", "Entrenador desconocido")} · ${unknowns.length}</th></tr>${unknowns.map(r => `<tr><th scope="row">${esc(label(model.players, r.member_id))}</th><td>${missing}</td>${entryCells(model.unknown_entries ? own(model.unknown_entries, r.member_id) : undefined)}<td>${reason[r.reason]}</td></tr>`).join("")}</tbody>` : "";
    table = `${counts}${result.population_count ? `<div class="comparison-table" role="region" tabindex="0" aria-label="${title}"><table aria-describedby="arrivals-summary arrivals-interpretation"><caption>${title} · ${esc(request.as_of)}</caption><thead><tr>${[t("Player", "Jugador"), t("Manager", "Entrenador"), t("Chosen joining event", "Inicio elegido"), t("Effective date", "Fecha efectiva"), t("Assignment / limitation", "Asignación / limitación")].map(h => `<th scope="col">${h}</th>`).join("")}</tr></thead>${groups}${unknownRows}</table></div>` : `<p>${result.coverage === "complete" ? t("The evidenced dated selection contains no players.", "La selección fechada con evidencia no contiene jugadores.") : t("No players are evidenced in this incomplete selection; this does not establish an empty squad.", "No hay jugadores acreditados en esta selección incompleta; esto no demuestra una plantilla vacía.")}</p>`}`;
  }
  const refs = [...new Set([...result.lineage, ...result.assigned.flatMap(r => r.lineage), ...result.unknown.flatMap(r => r.lineage)])];
  const credit = (ref: string) => { const value = own(model.credits, ref); return typeof value === "string" && value.trim() ? value : undefined; };
  const credits = [...new Set(refs.map(credit).filter((c): c is string => c !== undefined))];
  const sources = `<section aria-label="${t("Sources and snapshot", "Fuentes y versión de datos")}"><h2>${t("Sources and snapshot", "Fuentes y versión de datos")}</h2>${credits.map(c => `<p>${esc(c)}</p>`).join("")}${!refs.length || refs.some(ref => !credit(ref)) ? `<p>${t("Source attribution unavailable for some data.", "Atribución de fuente no disponible para algunos datos.")}</p>` : ""}<p>${t("Snapshot", "Versión de datos")}: ${esc(result.snapshot_id)}</p></section>`;
  return `${head}${status}${summary}${roster}${table}${sources}${revisit}`;
}
