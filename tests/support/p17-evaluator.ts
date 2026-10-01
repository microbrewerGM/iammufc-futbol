export type EvaluationSplit = "development" | "held_out";

export interface EvaluationTrial {
  caseId: string;
  caseKind: "question" | "model_output";
  split: EvaluationSplit;
  category: string;
  exact: boolean;
  acceptedUnsupported: boolean;
  latencyMs: number;
  costUsd: number;
  fieldMatches?: Partial<Record<QueryIntentField, boolean>>;
}

export type QueryIntentField = "metric" | "entity_type" | "entity_id" | "season" | "competition" | "dimensions" | "filters" | "viz" | "limit";

export interface EvaluationGateEvidence {
  fallbackVerified: boolean;
  withinPredeclaredCostGate: boolean;
}

export interface EvaluationReport {
  cases: number;
  questionCases: number;
  heldOutQuestionCases: number;
  trials: number;
  heldOutExactAgreement: number;
  acceptedUnsupported: number;
  meanLatencyMs: number;
  measuredCostUsd: number;
  categories: Record<string, { trials: number; exactAgreement: number }>;
  fieldAccuracy: Partial<Record<QueryIntentField, number>>;
  fallbackVerified: boolean;
  withinPredeclaredCostGate: boolean;
  passesReleaseGate: boolean;
}

/** Aggregate-only scoring. Raw questions and provider output are deliberately
 * absent from both the input and report so an evaluation run cannot turn into
 * a prompt-content log. */
export function scoreEvaluation(
  trials: readonly EvaluationTrial[],
  evidence: EvaluationGateEvidence,
): EvaluationReport {
  const caseIds = new Set(trials.map((trial) => trial.caseId));
  for (const caseId of caseIds) {
    const count = trials.filter((trial) => trial.caseId === caseId).length;
    if (count !== 3) throw new Error(`case ${caseId} must have exactly three trials`);
  }

  const heldOut = trials.filter((trial) => trial.split === "held_out");
  if (!heldOut.length) throw new Error("held-out trials are required");
  const heldOutExactAgreement = heldOut.filter((trial) => trial.exact).length / heldOut.length;
  const acceptedUnsupported = trials.filter((trial) => trial.acceptedUnsupported).length;
  const questionCases = new Set(trials.filter((trial) => trial.caseKind === "question").map((trial) => trial.caseId)).size;
  const heldOutQuestionCases = new Set(trials.filter(
    (trial) => trial.caseKind === "question" && trial.split === "held_out",
  ).map((trial) => trial.caseId)).size;
  const categories: EvaluationReport["categories"] = {};
  for (const trial of trials) {
    const aggregate = categories[trial.category] ?? { trials: 0, exactAgreement: 0 };
    const exactCount = aggregate.exactAgreement * aggregate.trials + Number(trial.exact);
    aggregate.trials += 1;
    aggregate.exactAgreement = exactCount / aggregate.trials;
    categories[trial.category] = aggregate;
  }
  const fieldAccuracy: EvaluationReport["fieldAccuracy"] = {};
  for (const field of ["metric", "entity_type", "entity_id", "season", "competition", "dimensions", "filters", "viz", "limit"] as const) {
    const values = trials.flatMap((trial) => trial.fieldMatches?.[field] === undefined ? [] : [trial.fieldMatches[field]]);
    if (values.length) fieldAccuracy[field] = values.filter(Boolean).length / values.length;
  }

  return {
    cases: caseIds.size,
    questionCases,
    heldOutQuestionCases,
    trials: trials.length,
    heldOutExactAgreement,
    acceptedUnsupported,
    meanLatencyMs: trials.reduce((sum, trial) => sum + trial.latencyMs, 0) / trials.length,
    measuredCostUsd: trials.reduce((sum, trial) => sum + trial.costUsd, 0),
    categories,
    fieldAccuracy,
    fallbackVerified: evidence.fallbackVerified,
    withinPredeclaredCostGate: evidence.withinPredeclaredCostGate,
    passesReleaseGate:
      questionCases >= 40
      && heldOutQuestionCases >= 20
      && heldOutExactAgreement >= 0.95
      && acceptedUnsupported === 0
      && evidence.fallbackVerified
      && evidence.withinPredeclaredCostGate,
  };
}
