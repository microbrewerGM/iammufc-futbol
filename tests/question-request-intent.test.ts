import { describe, expect, it } from "vitest";
import { mapQuestionVerdict, verifyQuestionResult, type RequestContext } from "../worker/src/core/question-request-intent";
import compiled from "../worker/src/generated/catalog.json";
import { Catalog } from "../worker/src/core/feasibility";
import { decodeCompiledCatalog } from "../worker/src/core/catalog-contract";

const id = "a".repeat(64);
function verdict() {
  return { version: 1, request_id: id, relevant: true, junk_reason: null, restated_question: "Show goals for a player", tables: [{ fields: ["goals"], filters: { season: ["2024-25"], competition: ["PL"], person_id: ["person-1"], opponent_id: [] as string[] } }], visuals: [{ kind: "bar", table_index: 0 }], field_status: [{ field: "goals", status: "missing" }], families: [] as string[] };
}
const context = (locale: "en" | "es" = "en"): RequestContext => ({ requestId: id, revision: 2, locale, snapshotId: "snapshot-1", resolvePerson: async p => p === "person-1" ? p : null });
async function ready() {
  const mapped = await mapQuestionVerdict(verdict(), context());
  expect(mapped.kind).toBe("ready");
  if (mapped.kind !== "ready") throw new Error("expected ready");
  return mapped;
}
describe("tier-0 request mapping", () => {
  it.each(["en", "es"] as const)("preserves the exact selection and localized route (%s)", async locale => {
    const mapped = await mapQuestionVerdict(verdict(), context(locale));
    expect(mapped.kind).toBe("ready");
    if (mapped.kind !== "ready") return;
    expect(mapped.intent).toEqual({ metric: "goals", entity_type: "player", entity_id: "person-1", season: "2024-25", competition: "PL", dimensions: [], filters: {}, viz: "bar", limit: 1 });
    expect(mapped.spec.result_path).toBe(`/${locale}/q?metric=goals&entity_type=player&entity_id=person-1&season=2024-25&competition=PL&viz=bar&limit=1`);
    expect(mapped.spec.catalog_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(mapped.spec)).not.toContain("Show goals");
    expect(mapped.spec.expected_cell_state).toBe("computable_now_queued");
  });
  it.each(["season", "competition", "person_id"] as const)("clarifies absent %s rather than defaulting", async field => {
    const v = verdict(); v.tables[0]!.filters[field] = [];
    expect(await mapQuestionVerdict(v, context())).toEqual({ kind: "clarification_required", field });
  });
  it("does not infer rankings, accept invented IDs, or resolve an alias silently", async () => {
    for (const person of ["all", "invented", "alias"]) {
      const v = verdict(); v.tables[0]!.filters.person_id = [person];
      expect(await mapQuestionVerdict(v, { ...context(), resolvePerson: async p => p === "alias" ? "person-1" : null })).toEqual({ kind: "clarification_required", field: "person_id" });
    }
  });
  it("rejects unsupported composition instead of choosing its first value", async () => {
    const variants = [verdict(), verdict(), verdict(), verdict()];
    variants[0]!.tables[0]!.fields.push("assists");
    variants[1]!.tables[0]!.filters.season.push("2023-24");
    variants[2]!.tables[0]!.filters.person_id.push("person-2");
    variants[3]!.visuals.push({ kind: "table", table_index: 0 });
    for (const v of variants) expect(await mapQuestionVerdict(v, context())).toEqual({ kind: "unsupported", reason: "composition" });
  });
  it("does not queue a family, discard an opponent or substitute for a line chart", async () => {
    const a = verdict(); a.families = ["arrival_manager"];
    const b = verdict(); b.tables[0]!.filters.opponent_id = ["opponent-1"];
    const c = verdict(); c.visuals[0]!.kind = "line";
    expect(await mapQuestionVerdict(a, context())).toEqual({ kind: "unsupported", reason: "family" });
    expect(await mapQuestionVerdict(b, context())).toEqual({ kind: "unsupported", reason: "opponent" });
    expect(await mapQuestionVerdict(c, context())).toEqual({ kind: "unsupported", reason: "execution" });
  });
  it("validates model output and request binding before entity lookups", async () => {
    for (const v of [null, { ...verdict(), request_id: "b".repeat(64) }, { ...verdict(), command: "bad" }]) {
      expect(await mapQuestionVerdict(v, { ...context(), resolvePerson: async () => { throw new Error("must not call"); } })).toEqual({ kind: "invalid" });
    }
  });
  it("requires a server snapshot", async () => {
    expect(await mapQuestionVerdict(verdict(), { ...context(), snapshotId: null })).toEqual({ kind: "unavailable", state: "snapshot_unavailable" });
  });
  it("preserves a real no-data cell despite the model claiming availability", async () => {
    const v = verdict(); v.tables[0]!.fields = ["xg"]; v.tables[0]!.filters.season = ["2018-19"]; v.field_status = [{ field: "xg", status: "available" }];
    expect(await mapQuestionVerdict(v, context())).toEqual({ kind: "unavailable", state: "no_data" });
  });
});
describe("release evidence", () => {
  async function evidence() {
    const mapped = await ready();
    const source = new Catalog(decodeCompiledCatalog(compiled)).checkFeasibility(mapped.intent, "en").attribution_text;
    return { ...mapped, response: { artifact_key: mapped.spec.artifact_key, snapshot_id: "snapshot-1", intent: mapped.intent, feasibility: { state: mapped.spec.expected_cell_state }, rows: [{ label: "Player", route_key: "person-1", value: 0 }], attribution: [source] }, current: { requestId: id, revision: 2, snapshotId: "snapshot-1" } };
  }
  it("accepts a genuine zero and matching binding", async () => {
    const x = await evidence(); expect(await verifyQuestionResult(x.spec, x.response, x.current)).toBe(true);
  });
  it("rejects a 200-style response without data, lineage or matching execution", async () => {
    const x = await evidence();
    for (const change of [{ rows: [] }, { rows: [{ label: "Player", value: null }] }, { rows: [{ label: "Player", value: NaN }] }, { attribution: [] }, { snapshot_id: "other" }, { artifact_key: "b".repeat(64) }, { intent: { ...x.intent, season: "2023-24" } }, { feasibility: { state: "no_data" } }]) expect(await verifyQuestionResult(x.spec, { ...x.response, ...change }, x.current)).toBe(false);
  });
  it("rejects snapshot/revision races and stale or tampered acceptance", async () => {
    const x = await evidence();
    expect(await verifyQuestionResult(x.spec, x.response, { ...x.current, snapshotId: "snapshot-2" })).toBe(false);
    expect(await verifyQuestionResult(x.spec, x.response, { ...x.current, revision: 3 })).toBe(false);
    for (const change of [{ catalog_digest: "b".repeat(64) }, { renderer_version: "old" }, { result_path: "https://example.com" }, { canonical_intent: "{" }]) expect(await verifyQuestionResult({ ...x.spec, ...change }, x.response, x.current)).toBe(false);
  });
  it("rejects another player's row and fabricated attribution despite matching envelope", async () => {
    const x = await evidence();
    expect(await verifyQuestionResult(x.spec, { ...x.response, rows: [{ ...x.response.rows[0], route_key: "person-2" }] }, x.current)).toBe(false);
    expect(await verifyQuestionResult(x.spec, { ...x.response, attribution: ["fabricated source"] }, x.current)).toBe(false);
  });
});
