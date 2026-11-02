import { describe, expect, it } from "vitest";
import { mapQuestionVerdict } from "../worker/src/core/question-request-intent";
import { claimQuestionResult, completeQuestionResult, confirmQuestionResult, proposeQuestionResult, recoverQuestionResult, type QuestionResult, type ResultDeps } from "../worker/src/core/question-request-results";
import { Catalog } from "../worker/src/core/feasibility";
import { decodeCompiledCatalog } from "../worker/src/core/catalog-contract";
import compiled from "../worker/src/generated/catalog.json";

async function fixture() {
  const id = "a".repeat(64);
  const mapped = await mapQuestionVerdict({ version: 1, request_id: id, relevant: true, junk_reason: null, restated_question: "Show goals", tables: [{ fields: ["goals"], filters: { season: ["2024-25"], competition: ["PL"], person_id: ["fpl:code:1"], opponent_id: [] } }], visuals: [{ kind: "bar", table_index: 0 }], field_status: [], families: [] }, { requestId: id, revision: 4, locale: "en", snapshotId: "snapshot-1", resolvePerson: async x => x });
  if (mapped.kind !== "ready") throw new Error("fixture_not_ready");
  let row: QuestionResult | null = null;
  let now = Date.parse("2026-11-02T04:00:00Z"), lease = 0;
  const binding = { revision: 4, snapshotId: "snapshot-1" as string | null };
  const deps: ResultDeps = {
    now: () => new Date(now), newLeaseId: () => `lease-${++lease}`,
    currentBinding: async () => ({ ...binding }),
    store: {
      get: async request => row?.requestId === request ? structuredClone(row) : null,
      compareAndSet: async (before, value) => {
        if (row?.revision !== before?.revision || binding.revision !== value.requestRevision) return false;
        if (!["expired", "failed"].includes(value.state) && (binding.snapshotId !== value.spec.data_snapshot_id || Date.parse(value.expiresAt) <= now)) return false;
        if (before?.state === "confirmation_required" && value.state === "building" && Date.parse(before.responseDeadline) <= now) return false;
        if (value.state === "released" && (before?.leaseExpiresAt === null || before?.leaseExpiresAt === undefined || Date.parse(before.leaseExpiresAt) <= now)) return false;
        row = structuredClone(value); return true;
      },
    },
  };
  const response = { artifact_key: mapped.spec.artifact_key, intent: mapped.intent, snapshot_id: "snapshot-1", feasibility: { state: "computable_now_queued" }, rows: [{ label: "Player", route_key: "fpl:code:1", value: 0 }], attribution: [new Catalog(decodeCompiledCatalog(compiled)).checkFeasibility(mapped.intent, "en").attribution_text] };
  const read = () => { if (!row) throw new Error("missing"); return structuredClone(row); };
  const propose = () => proposeQuestionResult(deps, "owner", mapped.spec, "2026-12-01T00:00:00Z");
  await propose();
  return { id, deps, read, response, binding, propose, advance: (seconds: number) => { now += seconds * 1000; } };
}
describe("request result transitions", () => {
  it("requires owner confirmation, then leases and verifies a genuine zero", async () => {
    const x = await fixture();
    expect(x.read().state).toBe("confirmation_required");
    expect(await claimQuestionResult(x.deps, x.id, 1, "service")).toBe("conflict");
    expect(await confirmQuestionResult(x.deps, x.id, 1, "owner")).toBe("accepted");
    expect(await claimQuestionResult(x.deps, x.id, 2, "service")).toBe("accepted");
    const row = x.read();
    expect(await completeQuestionResult(x.deps, x.id, row.revision, "service", row.leaseId!, x.response)).toBe("accepted");
    expect(x.read().state).toBe("released");
    expect(x.read().evidence?.value).toBe(0);
    expect(x.read().leaseExpiresAt).toBeNull();
  });
  it("hides another account's record and rejects stale confirmation/duplicate proposals", async () => {
    const x = await fixture();
    expect(await x.propose()).toBe("conflict");
    expect(await confirmQuestionResult(x.deps, x.id, 1, "other")).toBe("not_found");
    expect(await confirmQuestionResult(x.deps, x.id, 0, "owner")).toBe("conflict");
    expect(x.read().revision).toBe(1);
  });
  it("allows only one live lease and rejects a different caller or lease", async () => {
    const x = await fixture(); await confirmQuestionResult(x.deps, x.id, 1, "owner");
    await claimQuestionResult(x.deps, x.id, 2, "service"); const row = x.read();
    expect(await claimQuestionResult(x.deps, x.id, row.revision, "other")).toBe("conflict");
    expect(await completeQuestionResult(x.deps, x.id, row.revision, "other", row.leaseId!, x.response)).toBe("conflict");
    expect(await completeQuestionResult(x.deps, x.id, row.revision, "service", "wrong", x.response)).toBe("conflict");
  });
  it("never releases empty data or stale parent bindings", async () => {
    const x = await fixture(); await confirmQuestionResult(x.deps, x.id, 1, "owner"); await claimQuestionResult(x.deps, x.id, 2, "service"); const row = x.read();
    expect(await completeQuestionResult(x.deps, x.id, row.revision, "service", row.leaseId!, { ...x.response, rows: [] })).toBe("invalid_result");
    x.binding.snapshotId = "snapshot-2";
    expect(await completeQuestionResult(x.deps, x.id, row.revision, "service", row.leaseId!, x.response)).toBe("invalid_result");
    expect(x.read().state).toBe("in_review");
  });
  it("expires unconfirmed proposals after a day", async () => {
    const x = await fixture(); x.advance(86400);
    expect(await confirmQuestionResult(x.deps, x.id, 1, "owner")).toBe("conflict");
    expect(await recoverQuestionResult(x.deps, x.id, 1)).toBe("accepted");
    expect(x.read().state).toBe("expired");
  });
  it("retries expired execution leases at most three times", async () => {
    const x = await fixture(); await confirmQuestionResult(x.deps, x.id, 1, "owner");
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await claimQuestionResult(x.deps, x.id, x.read().revision, "service")).toBe("accepted");
      expect(x.read().attempt).toBe(attempt); x.advance(900);
      const row = x.read();
      expect(await completeQuestionResult(x.deps, x.id, row.revision, "service", row.leaseId!, x.response)).toBe("conflict");
      expect(await recoverQuestionResult(x.deps, x.id, row.revision)).toBe("accepted");
    }
    expect(x.read().state).toBe("failed");
    expect(await claimQuestionResult(x.deps, x.id, x.read().revision, "service")).toBe("conflict");
  });
  it("fences simultaneous claims using CAS", async () => {
    const x = await fixture(); await confirmQuestionResult(x.deps, x.id, 1, "owner");
    const outcomes = await Promise.all([claimQuestionResult(x.deps, x.id, 2, "one"), claimQuestionResult(x.deps, x.id, 2, "two")]);
    expect(outcomes.sort()).toEqual(["accepted", "conflict"]);
  });
  it("rechecks the confirmation deadline after asynchronous binding lookup", async () => {
    const x = await fixture(), original = x.deps.currentBinding;
    x.deps.currentBinding = async id => { x.advance(86400); return original(id); };
    expect(await confirmQuestionResult(x.deps, x.id, 1, "owner")).toBe("conflict");
    expect(x.read().state).toBe("confirmation_required");
  });
  it("persists only evidence from an immutable verified response copy", async () => {
    const x = await fixture(); await confirmQuestionResult(x.deps, x.id, 1, "owner"); await claimQuestionResult(x.deps, x.id, 2, "service");
    const original = x.deps.currentBinding; let reads = 0;
    x.deps.currentBinding = async id => { if (++reads === 2) { x.response.rows[0]!.value = 999; x.response.attribution = ["forged"]; } return original(id); };
    const row = x.read();
    expect(await completeQuestionResult(x.deps, x.id, row.revision, "service", row.leaseId!, x.response)).toBe("accepted");
    expect(x.read().evidence?.value).toBe(0);
    expect(x.read().evidence?.attribution).not.toBe("forged");
  });
  it("requires the store to fence confirmation expiry at the actual CAS boundary", async () => {
    const x = await fixture(), original = x.deps.store.compareAndSet;
    x.deps.store.compareAndSet = async (before, after) => { x.advance(86400); return original(before, after); };
    expect(await confirmQuestionResult(x.deps, x.id, 1, "owner")).toBe("conflict");
    expect(x.read().state).toBe("confirmation_required");
  });
  it("requires the store to fence lease expiry at the actual CAS boundary", async () => {
    const x = await fixture(); await confirmQuestionResult(x.deps, x.id, 1, "owner"); await claimQuestionResult(x.deps, x.id, 2, "service");
    const original = x.deps.store.compareAndSet;
    x.deps.store.compareAndSet = async (before, after) => { x.advance(900); return original(before, after); };
    const row = x.read();
    expect(await completeQuestionResult(x.deps, x.id, row.revision, "service", row.leaseId!, x.response)).toBe("conflict");
    expect(x.read().state).toBe("in_review");
  });
});
