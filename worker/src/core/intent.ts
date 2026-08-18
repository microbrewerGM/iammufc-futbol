/**
 * QueryIntent, canonicalization, and the content-addressed artifact key.
 *
 * DUAL IMPLEMENTATION WARNING
 * ---------------------------
 * This logic exists twice: here (request path) and in
 * pipeline/contracts/intent.py (precompute path). They MUST produce
 * byte-identical canonical JSON and identical sha256 digests, or the Worker
 * will miss cache entries the pipeline wrote and regenerate forever.
 *
 * Drift is caught by tests/vectors/artifact-keys.json, which both suites
 * assert against read-only. If this file disagrees with the fixture, fix this
 * file -- do not regenerate the fixture.
 */

export const TRANSFORM_CODE_VERSION = "2026.08.1";
export const RENDERER_VERSION = "vega-lite-poc-1";

export type EntityType = "player" | "match" | "season" | "opponent" | "competition";
export type VizType = "table" | "bar" | "line" | "shot_map" | "pass_map" | "heatmap";

export interface QueryIntent {
  metric: string;
  entity_type: EntityType;
  entity_id: string;
  season: string;
  competition: string;
  dimensions: string[];
  filters: Record<string, string>;
  viz: VizType;
  limit: number;
}

/** Defaults must be applied BEFORE serialization so an omitted field and an
 *  explicitly-default field hash identically. Mirrors the Pydantic defaults. */
export function withDefaults(partial: Partial<QueryIntent>): QueryIntent {
  return {
    metric: partial.metric ?? "",
    entity_type: partial.entity_type ?? "player",
    entity_id: partial.entity_id ?? "",
    season: partial.season ?? "",
    competition: partial.competition ?? "PL",
    dimensions: partial.dimensions ?? [],
    filters: partial.filters ?? {},
    viz: partial.viz ?? "table",
    limit: partial.limit ?? 10,
  };
}

/**
 * Sort by Unicode code point, matching Python's `sorted()` on str.
 *
 * JavaScript's default Array#sort compares UTF-16 code units, which orders
 * astral-plane characters differently from Python. Field names here are ASCII,
 * but `filters` keys can originate from an LLM proposal, so the divergence is
 * reachable. Cheap to eliminate; expensive to debug as a cache miss.
 */
function byCodePoint(a: string, b: string): number {
  const ai = Array.from(a);
  const bi = Array.from(b);
  const n = Math.min(ai.length, bi.length);
  for (let i = 0; i < n; i++) {
    const d = ai[i]!.codePointAt(0)! - bi[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return ai.length - bi.length;
}

/** Stable stringify: keys sorted at every level, no whitespace, non-ASCII
 *  emitted literally. Equivalent to Python's
 *  json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort(byCodePoint);
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") +
    "}"
  );
}

/**
 * Deterministic canonical form.
 *
 * Two semantically identical requests MUST serialize identically so their
 * hashes collide and dedup works. Ordering in `dimensions` and `filters` is
 * semantically meaningless and must not produce a new key.
 */
export function canonicalize(intent: QueryIntent): string {
  return stableStringify({
    ...intent,
    dimensions: [...intent.dimensions].sort(byCodePoint),
    filters: Object.fromEntries(
      Object.entries(intent.filters).sort(([a], [b]) => byCodePoint(a, b)),
    ),
  });
}

/**
 * Bazel-style action key over the version 4-tuple:
 * (canonical query, data snapshot, transform code version, renderer version).
 *
 * The data snapshot is part of the key rather than metadata specifically
 * because football data is retroactively corrected. A correction bumps the
 * snapshot, which changes the key, which invalidates affected artifacts
 * automatically.
 */
export async function artifactKey(
  intent: QueryIntent,
  dataSnapshotId: string,
): Promise<string> {
  const material = [
    canonicalize(intent),
    dataSnapshotId,
    TRANSFORM_CODE_VERSION,
    RENDERER_VERSION,
  ].join("|");

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
