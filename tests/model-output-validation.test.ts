/** Synthetic provider responses only: no remote calls or real credentials. */
import { expect, it } from "vitest";
import compiled from "../worker/src/generated/catalog.json";
import { Catalog, type CompiledCatalog } from "../worker/src/core/feasibility";
import { proposeWithAI } from "../worker/src/core/parser";
import { withDefaults } from "../worker/src/core/intent";

const catalog = new Catalog(compiled as unknown as CompiledCatalog);
const base = { metric: "goals", season: "2024-25", entity_id: "all", viz: "bar" };

it("preserves a supported complete proposal and canonical defaults", async () => {
  const intent = withDefaults({ metric: "goals", season: "2024-25", entity_type: "player", entity_id: "Rashford", competition: "PL", viz: "table", limit: 3 });
  const proposal = await proposeWithAI("Synthetic football question", catalog,
    { run: async () => ({ response: JSON.stringify(intent) }) }, "synthetic-model");
  expect(proposal.proposal?.intent).toEqual(intent);
  expect(proposal.proposal?.model_status).toBe("accepted");
  const minimal = { metric: "goals", season: "2024-25" };
  const defaults = await proposeWithAI("Synthetic football question", catalog,
    { run: async () => ({ response: JSON.stringify(minimal) }) }, "synthetic-model");
  expect(defaults.proposal?.intent).toEqual(withDefaults(minimal));
  const season = withDefaults({ metric: "goals", season: "2023-24", entity_type: "season", entity_id: "all", competition: "CL", viz: "table", limit: 2 });
  const preserved = await proposeWithAI("Synthetic football question", catalog,
    { run: async () => ({ response: JSON.stringify(season) }) }, "synthetic-model");
  expect(preserved.proposal?.intent).toEqual(season);
});

it("refuses malformed/unsupported model fields without silently discarding them", async () => {
  const failures = [];
  for (const [id, override] of [
    ["numeric_identity", { entity_id: 5 }],
    ["unknown_visualization", { viz: "pie" }],
    ["position_filter", { filters: { position: "GK" } }],
    ["grouping", { dimensions: ["position"] }],
  ] as const) {
    const proposal = await proposeWithAI("Synthetic football question", catalog,
      { run: async () => ({ response: JSON.stringify({ ...base, ...override }) }) }, "synthetic-model");
    if (proposal.proposal !== null) failures.push({ id, acceptedIntent: proposal.proposal.intent });
  }
  // These are valid vocabulary, not malformed: preserve exactly or refuse.
  for (const [field, value] of [["competition", "CL"], ["entity_type", "season"]] as const) {
    const proposal = await proposeWithAI("Synthetic football question", catalog,
      { run: async () => ({ response: JSON.stringify({ ...base, [field]: value }) }) }, "synthetic-model");
    if (proposal.proposal && proposal.proposal.intent[field] !== value) {
      failures.push({ id: field, acceptedIntent: proposal.proposal.intent });
    }
  }
  expect(failures, JSON.stringify({ cases: 6, modelCalls: 0, failures }, null, 2)).toEqual([]);
});

it("returns finite failure codes without provider output", async () => {
  expect(await proposeWithAI("Synthetic football question", catalog,
    { run: async () => { throw new Error("synthetic-provider-error"); } }, "synthetic-model"))
    .toEqual({ proposal: null, failure: "provider_error" });
  expect(await proposeWithAI("Synthetic football question", catalog,
    { run: async () => ({ response: "not JSON" }) }, "synthetic-model"))
    .toEqual({ proposal: null, failure: "invalid_output" });
  expect(await proposeWithAI("Synthetic football question", catalog,
    { run: async () => ({ response: 42 }) }, "synthetic-model"))
    .toEqual({ proposal: null, failure: "invalid_output" });
  expect(await proposeWithAI("Synthetic football question", catalog,
    { run: async () => ({ response: JSON.stringify({ ...base, filters: { position: "GK" } }) }) }, "synthetic-model"))
    .toEqual({ proposal: null, failure: "unsupported_intent" });
});
