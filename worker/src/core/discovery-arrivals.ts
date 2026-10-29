/** B15-PROPOSE: pure proposal only. B15-GUARD/WIRE own admission and execution.
 * The caller supplies a validated roster's effective date; this module cannot
 * establish coverage, freshness, rights, current membership or job admission.
 */
export interface ArrivalManagerRequest {
  version: 1;
  family: "arrival_manager";
  as_of: string;
  population: "first_team_available";
  joining_basis: "effective_first_team_spell_entry";
  academy_basis: "documented_first_team_promotion";
  visualization: "table";
}

export type ArrivalClarificationReason =
  | "invalid_question" | "unsupported_wording" | "date_required" | "invalid_date" | "conflicting_dates";
export type ArrivalProposal =
  | { status: "not_applicable" }
  | { status: "clarification"; reason: ArrivalClarificationReason; message: string }
  | {
      status: "proposed";
      request: ArrivalManagerRequest;
      canonical: string;
      interpretation: string;
      confirmation_required: true;
    };

type Locale = "en" | "es";
const MESSAGES: Record<Locale, Record<ArrivalClarificationReason, string>> = {
  en: {
    invalid_question: "Enter a question of 1–1024 characters using ordinary text.",
    unsupported_wording: "Do you mean the dated United first-team squad, grouped by the manager in charge when each player joined? Ask this question separately, without extra filters or statistics.",
    date_required: "Choose a validated squad date before confirming this question.",
    invalid_date: "Use one valid squad date in YYYY-MM-DD format.",
    conflicting_dates: "The question date and selected squad date differ. Choose the intended date.",
  },
  es: {
    invalid_question: "Escribe una pregunta de 1–1024 caracteres con texto normal.",
    unsupported_wording: "¿Te refieres a la plantilla del primer equipo del United en una fecha concreta, agrupada por el entrenador al mando cuando llegó cada jugador? Haz esta pregunta por separado, sin filtros ni estadísticas adicionales.",
    date_required: "Elige una fecha de plantilla validada antes de confirmar esta pregunta.",
    invalid_date: "Usa una única fecha de plantilla válida con el formato AAAA-MM-DD.",
    conflicting_dates: "La fecha de la pregunta y la plantilla seleccionada no coinciden. Elige la fecha deseada.",
  },
};

// Deliberately finite, whole-question patterns. Unknown wording is a clarification,
// never evidence for guessing identities, population, statistics or arrival dates.
const ENGLISH = /^(?:which current (?:united |manchester united )?players joined under which manager|(?:show|list)(?: me)? (?:the )?current (?:united |manchester united )?players (?:grouped by the manager (?:in charge|who was in charge) when they joined|that were acquired or joined for which managers were in charge of the team at the time of joining))$/;
const SPANISH = /^(?:que jugadores actuales llegaron con cada entrenador|(?:muestra|mostrar|lista) (?:los )?jugadores actuales (?:del united |del manchester united )?agrupados por el entrenador que estaba al mando cuando llegaron)$/;
const CANDIDATE = /\b(?:manager[a-z]*|manag[a-z]*|mang[a-z]*|coach[a-z]*|acquir[a-z]*|sign(?:ed|ing|ings|s)?|recruit[a-z]*|promot[a-z]*|academy|debut[a-z]*|entren[a-z]*|tecnic[a-z]*|arriv[a-z]*|join[a-z]*|joined|adquir[a-z]*|fich[a-z]*|lleg[a-z]*|contrat[a-z]*)\b/;

function realDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const stamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
}

/** Inline dates pin the same request as a selected squad date. Conflicting dates
 * need confirmation before a proposal exists. No wall-clock or catalog default.
 * This is a narrow recognizer, not a security gate or general language parser.
 */
export function proposeArrivalManager(
  question: unknown,
  locale: Locale,
  resolvedAsOf?: string | null,
): ArrivalProposal {
  const language = locale === "es" ? "es" : "en";
  const clarify = (reason: ArrivalClarificationReason): ArrivalProposal => ({
    status: "clarification", reason, message: MESSAGES[language][reason],
  });
  if (typeof question !== "string" || question.length < 1 || question.length > 1024 ||
      /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Default_Ignorable_Code_Point}]/u.test(question)) {
    return clarify("invalid_question");
  }
  let text = question.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .trim().replace(/^[¿¡]+/, "").replace(/[.?!]$/, "").trim().replace(/\s+/g, " ");
  if (!text) return clarify("invalid_question");
  if (!CANDIDATE.test(text)) return { status: "not_applicable" };

  let explicitDate: string | undefined;
  const suffix = text.match(/ (?:as of|a fecha de) (\d{4}-\d{2}-\d{2})$/);
  if (suffix) {
    explicitDate = suffix[1]!;
    text = text.slice(0, suffix.index);
  }
  if (!ENGLISH.test(text) && !SPANISH.test(text)) return clarify("unsupported_wording");
  if ((explicitDate !== undefined && !realDate(explicitDate)) ||
      (resolvedAsOf !== undefined && resolvedAsOf !== null && !realDate(resolvedAsOf))) {
    return clarify("invalid_date");
  }
  if (explicitDate && resolvedAsOf && explicitDate !== resolvedAsOf) return clarify("conflicting_dates");
  const asOf = explicitDate ?? resolvedAsOf;
  if (!asOf) return clarify("date_required");

  // Lexicographic key order is the frozen canonical UTF-8 JSON contract.
  const request: ArrivalManagerRequest = {
    academy_basis: "documented_first_team_promotion",
    as_of: asOf,
    family: "arrival_manager",
    joining_basis: "effective_first_team_spell_entry",
    population: "first_team_available",
    version: 1,
    visualization: "table",
  };
  const interpretation = language === "es"
    ? `Plantilla del primer equipo del United a fecha de ${asOf}, agrupada por el entrenador al mando cuando cada jugador entró en su etapa actual en el primer equipo. Incluye cedidos entrantes, excluye cedidos salientes y conserva lesionados y sancionados. Para canteranos se usa la promoción documentada al primer equipo; si falta, se muestra como desconocida. No indica quién fichó al jugador. La fecha no acredita que la plantilla esté actualizada.`
    : `United first-team squad as of ${asOf}, grouped by the manager in charge when each player entered their current first-team spell. Includes incoming loans, excludes outgoing loans and retains injured and suspended members. Academy players use documented first-team promotion; absent evidence stays unknown. This does not identify who recruited the player. The date does not establish current freshness.`;
  return { status: "proposed", request, canonical: JSON.stringify(request), interpretation, confirmation_required: true };
}
