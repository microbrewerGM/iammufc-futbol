import type { Job, Publication, PublicationVerifier } from "./exploration-bridge.js";

/** Read-only evidence available to the publication verifier. Implementations must
 * read authoritative stored records; this module never fetches remote resources. */
export interface PublicationEvidenceReader {
  validationRecord(id: string): Promise<ValidationRecord | null>;
  publicationRecord(id: string): Promise<PublicationRecord | null>;
  loadedSnapshot(id: string): Promise<LoadedSnapshot | null>;
  coverageRecord(id: string): Promise<CoverageRecord | null>;
}

export interface ValidationRecord {
  id: string; request_id: string; artifact_key: string; snapshot_id: string;
  outcome: "valid" | "invalid"; input_manifest: InputManifest;
}
export interface PublicationRecord {
  id: string; request_id: string; artifact_key: string; snapshot_id: string;
  validation_record_id: string; loaded_snapshot_id: string; coverage_record_id: string;
  lineage: string[]; loaded_at: string | null;
}
export interface LoadedSnapshot { id: string; snapshot_id: string; loaded_at: string | null; }
export interface CoverageRecord { id: string; snapshot_id: string; lineage: string[]; }
/** The exact source snapshot set used to build a candidate result. */
export interface InputManifest { snapshot_ids: string[]; lineage: string[]; }

const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9][a-z0-9:_-]{0,95}$/.test(v);
const hash = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const time = (v: unknown): v is string => typeof v === "string"
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) && !Number.isNaN(Date.parse(v));
const ids = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= 32
  && v.every(id) && new Set(v).size === v.length;
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length
  && [...a].sort().every((value, i) => value === [...b].sort()[i]);

function validManifest(value: unknown): value is InputManifest {
  return object(value) && Object.keys(value).length === 2 && ids(value.snapshot_ids)
    && ids(value.lineage);
}
function validRequest(value: unknown): value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).length !== 7) return false;
  return value.version === 1 && value.family === "arrival_manager"
    && typeof value.as_of === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.as_of)
    && value.population === "first_team_available"
    && value.joining_basis === "effective_first_team_spell_entry"
    && value.academy_basis === "documented_first_team_promotion"
    && value.visualization === "table";
}

/** Canonical request identity used by the bridge publication contract. */
export async function requestIdFor(request: unknown): Promise<string | null> {
  if (!validRequest(request)) return null;
  try {
    const keys = Object.keys(request).sort();
    const canonical = `{${keys.map(k => `${JSON.stringify(k)}:${JSON.stringify(request[k])}`).join(",")}}`;
    const bytes = new TextEncoder().encode(`${canonical}\narrival_manager:1`);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  } catch { return null; }
}

export function createPublicationVerifier(reader: PublicationEvidenceReader): PublicationVerifier {
  return {
    async verify(job: Job, candidate: Publication): Promise<boolean> {
      try {
        if (!object(job) || job.status !== "running" || !hash(job.job_id) || !object(candidate)) return false;
        if (!hash(candidate.artifact_key) || !hash(candidate.request_id)
          || !id(candidate.validation_record_id) || !id(candidate.publication_id)
          || !id(candidate.loaded_snapshot_id) || !id(candidate.coverage_record_id)
          || !time(candidate.loaded_at) || !ids(candidate.lineage)) return false;

        const expectedRequestId = await requestIdFor(job.request);
        if (!expectedRequestId || expectedRequestId !== candidate.request_id) return false;
        const [validation, publication, loaded, coverage] = await Promise.all([
          reader.validationRecord(candidate.validation_record_id),
          reader.publicationRecord(candidate.publication_id),
          reader.loadedSnapshot(candidate.loaded_snapshot_id),
          reader.coverageRecord(candidate.coverage_record_id),
        ]);
        if (!validation || !publication || !loaded || !coverage) return false;
        if (validation.outcome !== "valid" || !validManifest(validation.input_manifest)) return false;
        if (!hash(validation.request_id) || !hash(validation.artifact_key) || !id(validation.snapshot_id)) return false;
        if (validation.request_id !== expectedRequestId || validation.artifact_key !== candidate.artifact_key) return false;
        if (publication.id !== candidate.publication_id || publication.request_id !== expectedRequestId
          || publication.artifact_key !== candidate.artifact_key || publication.snapshot_id !== validation.snapshot_id
          || publication.validation_record_id !== candidate.validation_record_id
          || publication.loaded_snapshot_id !== candidate.loaded_snapshot_id
          || publication.coverage_record_id !== candidate.coverage_record_id
          || !time(publication.loaded_at) || publication.loaded_at !== candidate.loaded_at
          || !ids(publication.lineage) || !sameSet(publication.lineage, candidate.lineage)) return false;
        if (loaded.id !== candidate.loaded_snapshot_id || loaded.snapshot_id !== validation.snapshot_id
          || !time(loaded.loaded_at) || loaded.loaded_at !== candidate.loaded_at) return false;
        if (coverage.id !== candidate.coverage_record_id || coverage.snapshot_id !== validation.snapshot_id
          || !ids(coverage.lineage) || !sameSet(coverage.lineage, candidate.lineage)) return false;
        return sameSet(validation.input_manifest.snapshot_ids, [validation.snapshot_id])
          && sameSet(validation.input_manifest.lineage, candidate.lineage);
      } catch { return false; }
    },
  };
}
