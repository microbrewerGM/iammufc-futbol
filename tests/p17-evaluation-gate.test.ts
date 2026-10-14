import { describe, expect, it } from "vitest";
import compiled from "../worker/src/generated/catalog.json";
import { decodeCompiledCatalog } from "../worker/src/core/catalog-contract";
import { Catalog } from "../worker/src/core/feasibility";
import { canonicalize, type QueryIntent } from "../worker/src/core/intent";
import {
  hasAmbiguousPlayerReference,
  parseRuleBased,
  proposeWithAI,
} from "../worker/src/core/parser";
import { gateQuestion, type RejectCode } from "../worker/src/security/askguard";
import corpusJson from "./vectors/p17-intent-evaluation-v2.json";
import { scoreEvaluation, type EvaluationTrial } from "./support/p17-evaluator";

type Expected =
  | { outcome: "accepted"; intent?: QueryIntent }
  | { outcome: "clarification" }
  | { outcome: "rejected"; code: RejectCode }
  | { outcome: "refused"; failure: "provider_error" | "invalid_output" | "unsupported_intent" };
type CorpusCase = {
  id: string;
  split: "development" | "held_out";
  locale: "en" | "es";
  category: string;
  kind: "question" | "model_output";
  question?: string;
  response?: string;
  throws?: boolean;
  expected: Expected;
};

const corpus = corpusJson as CorpusCase[];
const catalog = new Catalog(decodeCompiledCatalog(compiled));
const knownPlayers = ["Rashford", "Fernandes", "Bruno Fernandes"];

async function outcomeSignature(outcome: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(outcome) ?? "");
  const runtimeCrypto = (globalThis as unknown as {
    crypto: { subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } };
  }).crypto;
  const digest = new Uint8Array(await runtimeCrypto.subtle.digest("SHA-256", encoded));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function exactOutcome(testCase: CorpusCase): Promise<{ exact: boolean; acceptedUnsupported: boolean; outcomeSignature: string }> {
  if (testCase.kind === "question") {
    const verdict = gateQuestion(testCase.question!, testCase.locale, knownPlayers);
    if (!verdict.allowed) {
      const exact = testCase.expected.outcome === "rejected" && verdict.code === testCase.expected.code;
      return {
        exact,
        acceptedUnsupported: false,
        outcomeSignature: await outcomeSignature({ outcome: "rejected", code: verdict.code }),
      };
    }
    const proposal = parseRuleBased(verdict.question, catalog);
    const ambiguous = hasAmbiguousPlayerReference(verdict.question, knownPlayers);
    if (proposal.confidence === "low" || ambiguous) {
      return {
        exact: testCase.expected.outcome === "clarification",
        acceptedUnsupported: testCase.expected.outcome === "rejected",
        outcomeSignature: await outcomeSignature({ outcome: "clarification" }),
      };
    }
    const expectedIntent = testCase.expected.outcome === "accepted" ? testCase.expected.intent : undefined;
    const exact = expectedIntent !== undefined
      && canonicalize(proposal.intent) === canonicalize(expectedIntent);
    return {
      exact,
      acceptedUnsupported: testCase.expected.outcome === "rejected",
      outcomeSignature: await outcomeSignature({ outcome: "accepted", canonicalIntent: canonicalize(proposal.intent) }),
    };
  }

  const result = await proposeWithAI(
    "Top goals 2024-25",
    catalog,
    { run: async () => {
      if (testCase.throws) throw new Error("synthetic provider failure");
      return { response: testCase.response };
    } },
    "synthetic-evaluation-model",
  );
  if (result.proposal) {
    const expectedIntent = testCase.expected.outcome === "accepted" ? testCase.expected.intent : undefined;
    return {
      exact: expectedIntent !== undefined
        && canonicalize(result.proposal.intent) === canonicalize(expectedIntent),
      acceptedUnsupported: testCase.expected.outcome === "refused",
      outcomeSignature: await outcomeSignature({ outcome: "accepted", canonicalIntent: canonicalize(result.proposal.intent) }),
    };
  }
  return {
    exact: testCase.expected.outcome === "refused" && result.failure === testCase.expected.failure,
    acceptedUnsupported: false,
    outcomeSignature: await outcomeSignature({ outcome: "refused", failure: result.failure }),
  };
}

describe("P17 evaluation gate v2", () => {
  it("freezes forty-eight balanced questions plus a separate output-safety matrix", () => {
    expect(corpus).toHaveLength(60);
    expect(new Set(corpus.map(({ id }) => id)).size).toBe(60);
    const questions = corpus.filter(({ kind }) => kind === "question");
    expect(questions).toHaveLength(48);
    expect(questions.filter(({ split }) => split === "held_out")).toHaveLength(24);
    expect(questions.filter(({ locale }) => locale === "en")).toHaveLength(24);
    expect(questions.filter(({ locale }) => locale === "es")).toHaveLength(24);
    expect(Array.from(new Set(corpus.map(({ category }) => category)))).toEqual(expect.arrayContaining([
      "supported",
      "identity",
      "clarification",
      "unsupported",
      "scope",
      "irrelevant",
      "injection",
      "coverage",
      "malformed_output",
      "unsupported_output",
      "provider_failure",
    ]));
  });

  it("proves the deterministic boundary's exact expected outcome before live model spend", async () => {
    const failures = [];
    for (const testCase of corpus) {
      const outcome = await exactOutcome(testCase);
      if (!outcome.exact || outcome.acceptedUnsupported) {
        failures.push({
          id: testCase.id,
          exact: outcome.exact,
          acceptedUnsupported: outcome.acceptedUnsupported,
        });
      }
    }
    expect(failures).toEqual([]);
  });

  it("scores three trials per case without retaining questions or provider output", async () => {
    const trials: EvaluationTrial[] = [];
    for (const testCase of corpus) {
      for (let sample = 0; sample < 3; sample += 1) {
        const outcome = await exactOutcome(testCase);
        trials.push({
          caseId: testCase.id,
          caseKind: testCase.kind,
          split: testCase.split,
          category: testCase.category,
          exact: outcome.exact,
          acceptedUnsupported: outcome.acceptedUnsupported,
          latencyMs: 10 + sample,
          costUsd: 0,
          outcomeSignature: outcome.outcomeSignature,
          fieldMatches: testCase.expected.outcome === "accepted"
            ? Object.fromEntries(["metric", "entity_type", "entity_id", "season", "competition", "dimensions", "filters", "viz", "limit"].map((field) => [field, outcome.exact]))
            : undefined,
        });
      }
    }
    const report = scoreEvaluation(trials, {
      fallbackVerified: true,
      withinPredeclaredCostGate: true,
    });
    expect(report).toMatchObject({
      cases: 60,
      questionCases: 48,
      heldOutQuestionCases: 24,
      trials: 180,
      heldOutExactAgreement: 1,
      withinCaseStability: 1,
      acceptedUnsupported: 0,
      meanLatencyMs: 11,
      measuredCostUsd: 0,
      passesReleaseGate: true,
    });
    expect(JSON.stringify(report)).not.toContain("Top goals 2024-25");
    expect(JSON.stringify(report)).not.toContain("not json");
  });

  it("fails closed on incomplete trials or any accepted unsupported outcome", () => {
    expect(() => scoreEvaluation([{
      caseId: "one",
      caseKind: "question",
      split: "held_out",
      category: "unsupported",
      exact: true,
      acceptedUnsupported: false,
      latencyMs: 1,
      costUsd: 0,
      outcomeSignature: "a".repeat(64),
    }], { fallbackVerified: true, withinPredeclaredCostGate: true })).toThrow("exactly three trials");

    const trials = corpus.flatMap((testCase) => Array.from({ length: 3 }, () => ({
      caseId: testCase.id,
      caseKind: testCase.kind,
      split: testCase.split,
      category: testCase.category,
      exact: true,
      acceptedUnsupported: testCase.id === "m-en-04",
      latencyMs: 1,
      costUsd: 0,
      outcomeSignature: "a".repeat(64),
    })));
    expect(scoreEvaluation(trials, {
      fallbackVerified: true,
      withinPredeclaredCostGate: true,
    }).passesReleaseGate).toBe(false);
    expect(scoreEvaluation(trials.map((trial) => ({ ...trial, acceptedUnsupported: false })), {
      fallbackVerified: false,
      withinPredeclaredCostGate: true,
    }).passesReleaseGate).toBe(false);
  });

  it("measures divergent canonical outcomes even when exact-match booleans agree", () => {
    const trials: EvaluationTrial[] = corpus.flatMap((testCase) => Array.from({ length: 3 }, (_, index) => ({
      caseId: testCase.id,
      caseKind: testCase.kind,
      split: testCase.split,
      category: testCase.category,
      exact: true,
      acceptedUnsupported: false,
      latencyMs: 1,
      costUsd: 0,
      outcomeSignature: index === 2 && testCase.id === "m-en-04" ? "b".repeat(64) : "a".repeat(64),
    })));
    const report = scoreEvaluation(trials, {
      fallbackVerified: true,
      withinPredeclaredCostGate: true,
    });
    expect(report.withinCaseStability).toBe(59 / 60);
    expect(report.passesReleaseGate).toBe(false);
    expect(JSON.stringify(report)).not.toMatch(/[ab]{64}/);
  });

  it("rejects inconsistent metadata and malformed or missing outcome signatures", () => {
    const trials: EvaluationTrial[] = corpus.flatMap((testCase) => Array.from({ length: 3 }, () => ({
      caseId: testCase.id,
      caseKind: testCase.kind,
      split: testCase.split,
      category: testCase.category,
      exact: true,
      acceptedUnsupported: false,
      latencyMs: 1,
      costUsd: 0,
      outcomeSignature: "a".repeat(64),
    })));
    expect(() => scoreEvaluation([
      ...trials,
      { ...trials[0]!, caseId: "m-en-01", category: "changed-category" },
      { ...trials[1]!, caseId: "m-en-01" },
    ], { fallbackVerified: true, withinPredeclaredCostGate: true })).toThrow("mismatched metadata");
    expect(() => scoreEvaluation(trials.map((trial, index) => index === 0
      ? { ...trial, outcomeSignature: "not-a-digest" }
      : trial), { fallbackVerified: true, withinPredeclaredCostGate: true })).toThrow("valid sanitized outcome signature");
    expect(() => scoreEvaluation(trials.map(({ outcomeSignature: _signature, ...trial }, index) => index === 0
      ? trial as unknown as EvaluationTrial
      : { ...trial, outcomeSignature: "a".repeat(64) }), {
      fallbackVerified: true,
      withinPredeclaredCostGate: true,
    })).toThrow("valid sanitized outcome signature");
  });
});
