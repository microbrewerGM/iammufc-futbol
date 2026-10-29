import { LOCALES, type LocaleCode } from "../core/locale";
import { esc, page } from "./layout";

const STRINGS = {
  en: { title: "Ask for football data", intro: "Suggest a football question for review.", label: "Your question", submit: "Send question", received: "Received", triaging: "Being reviewed", triaged: "Reviewed", junk: "Not accepted", triage_failed: "Review failed", queued: "Queued", filled: "Available", partial: "Partly available", no_data: "No data available", invalid: "Enter a question of 1 to 500 characters without control or invisible formatting characters.", unavailable: "Questions are temporarily unavailable." },
  es: { title: "Solicitar datos de fútbol", intro: "Propón una pregunta de fútbol para su revisión.", label: "Tu pregunta", submit: "Enviar pregunta", received: "Recibida", triaging: "En revisión", triaged: "Revisada", junk: "No aceptada", triage_failed: "Error en la revisión", queued: "En cola", filled: "Disponible", partial: "Parcialmente disponible", no_data: "No hay datos disponibles", invalid: "Escribe una pregunta de 1 a 500 caracteres, sin controles ni caracteres invisibles de formato.", unavailable: "Las solicitudes no están disponibles temporalmente." },
} as const;
export function questionRequestPage(code: LocaleCode, status?: string, error?: "invalid" | "unavailable"): string {
  const t = STRINGS[code];
  const body = `<h1>${esc(t.title)}</h1><p>${esc(t.intro)}</p>${error ? `<p role="alert">${esc(t[error])}</p>` : ""}<form method="post" action="/${code}/requests"><label for="question">${esc(t.label)}</label><textarea id="question" name="text" maxlength="500" required></textarea><button type="submit">${esc(t.submit)}</button></form>${status ? `<p role="status">${esc((t as Record<string, string>)[status] ?? t.received)}</p>` : ""}`;
  return page(body, { title: t.title, locale: LOCALES[code], unprefixedPath: "/requests" });
}
