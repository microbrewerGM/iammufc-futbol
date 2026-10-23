import { describe, expect, it } from "vitest";
import type { Job, Publication } from "../worker/src/core/exploration-bridge.js";
import { createPublicationVerifier, requestIdFor, type PublicationEvidenceReader } from "../worker/src/core/exploration-bridge-verifier.js";

const request = { version: 1, family: "arrival_manager", as_of: "2026-10-23", population: "first_team_available",
  joining_basis: "effective_first_team_spell_entry", academy_basis: "documented_first_team_promotion", visualization: "table" };
const job: Job = { job_id: "a".repeat(64), request, status: "running", attempt: 1, lease_id: "lease-1",
  lease_expires_at: "2026-10-23T12:15:00Z", retry_after: null, failure: null, publication: null };
const publication: Publication = { artifact_key: "b".repeat(64), request_id: "0".repeat(64), validation_record_id: "validation-1",
  publication_id: "publication-1", loaded_snapshot_id: "loaded-1", coverage_record_id: "coverage-1",
  loaded_at: "2026-10-23T12:00:00Z", lineage: ["source:a", "source:b"] };

function evidence(candidate = publication, requestId = candidate.request_id): PublicationEvidenceReader {
  return {
    async validationRecord() { return { id: candidate.validation_record_id, request_id: requestId, artifact_key: candidate.artifact_key,
      snapshot_id: "snapshot-1", outcome: "valid", input_manifest: { snapshot_ids: ["snapshot-1"], lineage: [...candidate.lineage] } }; },
    async publicationRecord() { return { id: candidate.publication_id, request_id: requestId, artifact_key: candidate.artifact_key,
      snapshot_id: "snapshot-1", validation_record_id: candidate.validation_record_id,
      loaded_snapshot_id: candidate.loaded_snapshot_id, coverage_record_id: candidate.coverage_record_id,
      lineage: [...candidate.lineage], loaded_at: candidate.loaded_at }; },
    async loadedSnapshot() { return { id: candidate.loaded_snapshot_id, snapshot_id: "snapshot-1", loaded_at: candidate.loaded_at }; },
    async coverageRecord() { return { id: candidate.coverage_record_id, snapshot_id: "snapshot-1", lineage: [...candidate.lineage] }; },
  };
}

describe("exploration bridge publication verifier", () => {
  it("accepts a complete set of matching validation, manifest, publication, load, and coverage evidence", async () => {
    const candidate = { ...publication, request_id: (await requestIdFor(request))! };
    expect(await createPublicationVerifier(evidence(candidate)).verify(job, candidate)).toBe(true);
  });

  it("fails closed for every mismatched candidate reference", async () => {
    const candidate = { ...publication, request_id: (await requestIdFor(request))! };
    const variants: Publication[] = [
      { ...candidate, artifact_key: "c".repeat(64) }, { ...candidate, request_id: "d".repeat(64) },
      { ...candidate, validation_record_id: "validation-other" }, { ...candidate, publication_id: "publication-other" },
      { ...candidate, loaded_snapshot_id: "loaded-other" }, { ...candidate, coverage_record_id: "coverage-other" },
      { ...candidate, lineage: ["source:other"] },
    ];
    for (const item of variants) expect(await createPublicationVerifier(evidence(candidate)).verify(job, item)).toBe(false);
  });

  it("rejects missing load time, retrieval-only success, missing evidence, and reader errors", async () => {
    const candidate = { ...publication, request_id: (await requestIdFor(request))! };
    expect(await createPublicationVerifier({ ...evidence(candidate), async loadedSnapshot(id) {
      return { id, snapshot_id: "snapshot-1", loaded_at: null };
    } }).verify(job, candidate)).toBe(false);
    expect(await createPublicationVerifier({ ...evidence(candidate), async publicationRecord(id) {
      return { id, request_id: candidate.request_id, artifact_key: candidate.artifact_key, snapshot_id: "snapshot-1",
        validation_record_id: candidate.validation_record_id, loaded_snapshot_id: candidate.loaded_snapshot_id,
        coverage_record_id: candidate.coverage_record_id, lineage: candidate.lineage, loaded_at: null };
    } }).verify(job, candidate)).toBe(false);
    expect(await createPublicationVerifier({ ...evidence(candidate), async publicationRecord() { return null; } }).verify(job, candidate)).toBe(false);
    expect(await createPublicationVerifier({ ...evidence(candidate), async validationRecord() { throw new Error("unavailable"); } }).verify(job, candidate)).toBe(false);
  });

  it("rejects denied evidence, malformed manifests, and jobs outside a live running candidate state", async () => {
    const candidate = { ...publication, request_id: (await requestIdFor(request))! };
    expect(await createPublicationVerifier({ ...evidence(candidate), async validationRecord(id) {
      return { id, request_id: candidate.request_id, artifact_key: candidate.artifact_key, snapshot_id: "snapshot-1",
        outcome: "invalid", input_manifest: { snapshot_ids: ["snapshot-1"], lineage: candidate.lineage } };
    } }).verify(job, candidate)).toBe(false);
    expect(await createPublicationVerifier({ ...evidence(candidate), async validationRecord(id) {
      return { id, request_id: candidate.request_id, artifact_key: candidate.artifact_key, snapshot_id: "snapshot-1",
        outcome: "valid", input_manifest: { snapshot_ids: [], lineage: candidate.lineage } };
    } }).verify(job, candidate)).toBe(false);
    expect(await createPublicationVerifier(evidence(candidate)).verify({ ...job, status: "queued" }, candidate)).toBe(false);
  });
});
