import { LOCALES, type LocaleCode } from "../core/locale";
import { esc, page } from "./layout";
import { type QueryIntent } from "../core/intent";
import { parseIntent, validateExecutionSupport } from "../core/validate-intent";
import { requestResultPath } from "../core/question-request-intent";
import compiled from "../generated/catalog.json";
import { decodeCompiledCatalog } from "../core/catalog-contract";
import { Catalog } from "../core/feasibility";

const catalog = new Catalog(decodeCompiledCatalog(compiled));
export interface QuestionResultView {
  requestId: string;
  revision: number;
  state: "triaging" | "clarification_required" | "confirmation_required" | "building" | "in_review" | "released" | "unsupported" | "unavailable" | "failed" | "expired" | "stale";
  /** Resolved from the server-owned player identity table, never the model restatement. */
  personLabel?: string;
  intent?: QueryIntent;
  resultPath?: string;
  /** Route must compare the stored acceptance with current catalog/snapshot. */
  currentBinding?: boolean;
  /** Explicitly disable the form until the clarification handler is available. */
  clarificationAvailable?: boolean;
  /** Validated retained execution metadata; does not imply historical serving. */
  executedSnapshotId?: string;
}
const PROVENANCE_STRINGS = {
  en: { title: "Data provenance", snapshot: "Result data snapshot" },
  es: { title: "Procedencia de los datos", snapshot: "Instantánea de datos del resultado" },
} as const;
const RESULT_STRINGS = {
  en: { triaging: "Reviewing your clarification", clarification_required: "Please clarify your question", confirmation_required: "Confirm your selection", building: "Preparing your result", in_review: "Checking your result", released: "Your result is ready", unsupported: "This request is not supported yet", unavailable: "The requested data is unavailable", failed: "We could not prepare this result", expired: "This request has expired", stale: "The data has changed; this result needs checking", clarifyLabel: "Your clarified question", clarify: "Send clarification", confirm: "Confirm selection", open: "View result", table: "Table", bar: "Bar chart", dot_plot: "Dot plot" },
  es: { triaging: "Revisando tu aclaración", clarification_required: "Aclara tu pregunta", confirmation_required: "Confirma tu selección", building: "Preparando tu resultado", in_review: "Comprobando tu resultado", released: "Tu resultado está listo", unsupported: "Esta solicitud aún no es compatible", unavailable: "Los datos solicitados no están disponibles", failed: "No pudimos preparar este resultado", expired: "Esta solicitud ha caducado", stale: "Los datos han cambiado; hay que comprobar este resultado", clarifyLabel: "Tu pregunta aclarada", clarify: "Enviar aclaración", confirm: "Confirmar selección", open: "Ver resultado", table: "Tabla", bar: "Gráfico de barras", dot_plot: "Gráfico de puntos" },
} as const;

export function questionResultPanel(code: LocaleCode, result: QuestionResultView): string {
  if (result.requestId.length !== 64 || !/^[0-9a-f]{64}$/.test(result.requestId) || !Number.isSafeInteger(result.revision) || result.revision < 1 || !Object.hasOwn(RESULT_STRINGS[code], result.state)) return "";
  const t = RESULT_STRINGS[code];
  const parsed = parseIntent(result.intent);
  const intent = parsed.ok && !validateExecutionSupport(parsed.intent) && parsed.intent.entity_type === "player" && parsed.intent.entity_id !== "all" && parsed.intent.limit === 1 ? parsed.intent : null;
  const metric = intent ? catalog.metric(intent.metric) : null;
  const summary = intent && metric && result.personLabel
    ? `<p>${esc(result.personLabel)} · ${esc(code === "es" ? metric.label_es : metric.label_en)} · ${esc(intent.season)} · ${esc(intent.competition)} · ${esc(t[intent.viz as "table" | "bar" | "dot_plot"])}</p>` : "";
  let action = "";
  if (result.state === "clarification_required" && result.clarificationAvailable !== false) {
    action = `<form method="post" action="/${code}/requests/${result.requestId}/clarify"><input type="hidden" name="expected_revision" value="${result.revision}"><label for="clarified-question">${esc(t.clarifyLabel)}</label><textarea id="clarified-question" name="text" maxlength="500" required></textarea><button type="submit">${esc(t.clarify)}</button></form>`;
  } else if (result.state === "confirmation_required" && summary && result.currentBinding === true) {
    action = `<form method="post" action="/${code}/requests/${result.requestId}/confirm"><input type="hidden" name="expected_revision" value="${result.revision}"><button type="submit">${esc(t.confirm)}</button></form>`;
  } else if (result.state === "released" && intent && result.currentBinding === true && result.resultPath === requestResultPath(intent, code)) {
    action = `<p><a href="${esc(result.resultPath)}">${esc(t.open)}</a></p>`;
  }
  const state = (result.state === "released" || result.state === "confirmation_required") && !action ? "stale" : result.state;
  const snapshot = result.executedSnapshotId, provenanceText = PROVENANCE_STRINGS[code];
  const provenance = (result.state === "released" || result.state === "stale")
    && typeof snapshot === "string" && snapshot.length > 0 && snapshot.length <= 128 && !/[^A-Za-z0-9:_-]/.test(snapshot)
    ? `<details><summary>${esc(provenanceText.title)}</summary><p>${esc(provenanceText.snapshot)}: <code>${snapshot.match(/.{1,16}/g)!.map(chunk => esc(chunk)).join("<wbr>")}</code></p></details>` : "";
  return `<section aria-labelledby="request-result-heading"><h2 id="request-result-heading">${esc(t[state])}</h2>${summary}${action}${provenance}</section>`;
}

const STRINGS = {
  en: { title: "Ask for football data", intro: "Suggest a football question for review.", label: "Your question", submit: "Send question", received: "Received", triaging: "Being reviewed", triaged: "Reviewed", junk: "Not accepted", triage_failed: "Review failed", queued: "Queued", filled: "Available", partial: "Partly available", no_data: "No data available", invalid: "Enter a question of 1 to 500 characters without control or invisible formatting characters.", unavailable: "Questions are temporarily unavailable." },
  es: { title: "Solicitar datos de fútbol", intro: "Propón una pregunta de fútbol para su revisión.", label: "Tu pregunta", submit: "Enviar pregunta", received: "Recibida", triaging: "En revisión", triaged: "Revisada", junk: "No aceptada", triage_failed: "Error en la revisión", queued: "En cola", filled: "Disponible", partial: "Parcialmente disponible", no_data: "No hay datos disponibles", invalid: "Escribe una pregunta de 1 a 500 caracteres, sin controles ni caracteres invisibles de formato.", unavailable: "Las solicitudes no están disponibles temporalmente." },
} as const;
export function questionRequestPage(code: LocaleCode, status?: string, error?: "invalid" | "unavailable", result?: QuestionResultView): string {
  const t = STRINGS[code];
  const body = `<h1>${esc(t.title)}</h1><p>${esc(t.intro)}</p>${error ? `<p role="alert">${esc(t[error])}</p>` : ""}<form method="post" action="/${code}/requests"><label for="question">${esc(t.label)}</label><textarea id="question" name="text" maxlength="500" required></textarea><button type="submit">${esc(t.submit)}</button></form>${status && !result ? `<p role="status">${esc((t as Record<string, string>)[status] ?? t.received)}</p>` : ""}`;
  const requestPath = result && result.requestId.length === 64 && /^[0-9a-f]{64}$/.test(result.requestId) ? `/requests?id=${result.requestId}` : "/requests";
  return page(body + (result ? questionResultPanel(code, result) : ""), { title: t.title, locale: LOCALES[code], unprefixedPath: requestPath });
}
