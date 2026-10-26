import type { LocaleCode } from "../core/locale";
import { esc } from "./layout";

/** One era row. Counters are nullable so an unknown value renders as a dash, never 0. */
export interface ManagerEraViewRow {
  manager: string;
  role?: "manager" | "caretaker" | null;
  played: number | null;
  won: number | null;
  drawn: number | null;
  lost: number | null;
  points: number | null;
  /** ISO dates (YYYY-MM-DD); absent or null renders a dash. */
  start_date?: string | null;
  end_date?: string | null;
}

export interface ManagerErasView {
  eras: readonly ManagerEraViewRow[];
}

interface ManagerErasStrings {
  heading: string;
  caption: string;
  manager: string;
  played: string;
  record: string;
  points: string;
  period: string;
  caretaker: string;
  noData: string;
}

// Local until T8-WIRE moves these into the locale dictionary.
const strings: Record<LocaleCode, ManagerErasStrings> = {
  en: { heading: "Managerial eras", caption: "Record by manager era", manager: "Manager", played: "Games", record: "W-D-L", points: "Points", period: "Period", caretaker: "caretaker", noData: "No manager era data is available for this selection." },
  es: { heading: "Etapas de entrenadores", caption: "Balance por etapa de entrenador", manager: "Entrenador", played: "Partidos", record: "G-E-P", points: "Puntos", period: "Periodo", caretaker: "interino", noData: "No hay datos de etapas de entrenadores para esta selección." },
};

const DASH = "—";

/** Accessible server-rendered table with one row per manager era. */
export function managerErasBody(model: ManagerErasView, locale: LocaleCode): string {
  const s = strings[locale];
  const fmt = new Intl.NumberFormat(locale === "es" ? "es-ES" : "en-GB");
  const num = (v: number | null | undefined): string => typeof v === "number" && Number.isFinite(v) ? fmt.format(v) : DASH;
  const date = (v: string | null | undefined): string => typeof v === "string" && v ? v : "";
  const heading = `<h2>${esc(s.heading)}</h2>`;
  if (model.eras.length === 0) return `${heading}<p role="status">${esc(s.noData)}</p>`;
  const rows = model.eras.map(era => {
    const name = `${esc(era.manager)}${era.role === "caretaker" ? ` (${esc(s.caretaker)})` : ""}`;
    const wdl = [era.won, era.drawn, era.lost];
    const record = wdl.every(v => typeof v === "number" && Number.isFinite(v)) ? wdl.map(num).join("-") : DASH;
    const start = date(era.start_date), end = date(era.end_date);
    const period = start || end ? `${start || DASH} – ${end || DASH}` : DASH;
    return `<tr><th scope="row">${name}</th><td>${num(era.played)}</td><td>${record}</td><td>${num(era.points)}</td><td>${esc(period)}</td></tr>`;
  }).join("");
  const headers = [s.manager, s.played, s.record, s.points, s.period].map(h => `<th scope="col">${esc(h)}</th>`).join("");
  return `${heading}<div class="comparison-table" role="region" tabindex="0" aria-label="${esc(s.heading)}"><table><caption>${esc(s.caption)}</caption><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
