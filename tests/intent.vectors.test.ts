/**
 * Cross-language contract: TypeScript must reproduce the committed vectors.
 *
 * The same fixture is asserted by tests/test_intent_vectors.py. If the two
 * languages disagree, one of these suites fails -- which is the entire point.
 * The fixture is read-only here. If this suite fails, fix the TypeScript
 * implementation; regenerating the fixture would defeat the check.
 */

import { describe, expect, it } from "vitest";

import {
  RENDERER_VERSION,
  TRANSFORM_CODE_VERSION,
  artifactKey,
  canonicalize,
  withDefaults,
  type EntityType,
  type QueryIntent,
  type VizType,
} from "../worker/src/core/intent";
import vectors from "./vectors/artifact-keys.json" with { type: "json" };

interface RawInput {
  metric: string;
  entity_type: string;
  entity_id: string;
  season: string;
  competition?: string;
  dimensions?: string[];
  filters?: Record<string, string>;
  viz?: string;
  limit?: number;
}

function build(raw: RawInput): QueryIntent {
  return withDefaults({
    metric: raw.metric,
    entity_type: raw.entity_type as EntityType,
    entity_id: raw.entity_id,
    season: raw.season,
    competition: raw.competition,
    dimensions: raw.dimensions,
    filters: raw.filters,
    viz: raw.viz as VizType | undefined,
    limit: raw.limit,
  });
}

const byName = (name: string) => vectors.vectors.find((v) => v.name === name)!;

describe("cross-language artifact key contract", () => {
  it("agrees with the fixture on version constants", () => {
    // A bumped constant must be a deliberate, reviewed change -- not silent
    // cache invalidation discovered in production.
    expect(vectors.transform_code_version).toBe(TRANSFORM_CODE_VERSION);
    expect(vectors.renderer_version).toBe(RENDERER_VERSION);
  });

  for (const vec of vectors.vectors) {
    it(`canonical form: ${vec.name}`, () => {
      expect(canonicalize(build(vec.input as RawInput))).toBe(vec.canonical);
    });

    it(`artifact key: ${vec.name}`, async () => {
      expect(await artifactKey(build(vec.input as RawInput), vectors.snapshot_id)).toBe(vec.key);
    });
  }
});

describe("canonicalization invariants", () => {
  it("treats omitted and explicitly-default fields identically", () => {
    // The builder path and the chat path fill these slots differently. If they
    // hashed differently, the same question would miss its own cache entry.
    expect(byName("minimal defaults applied").key).toBe(
      byName("explicit defaults hash the same as omitted ones").key,
    );
  });

  it("treats dimension order as non-semantic", () => {
    expect(byName("dimension order is not semantic").key).toBe(
      byName("same dimensions, reversed input order").key,
    );
  });

  it("treats filter key order as non-semantic", () => {
    expect(byName("filter key order is not semantic").key).toBe(
      byName("same filters, reversed key order").key,
    );
  });

  it("emits non-ASCII literally rather than escaped", () => {
    // Must match Python's ensure_ascii=False, or every accented player name
    // would hash differently across the two implementations.
    expect(byName("non-ascii entity id survives round trip").canonical).toContain(
      "garnacho-fernández",
    );
  });

  it("changes the key when the visualisation changes", () => {
    expect(byName("minimal defaults applied").key).not.toBe(
      byName("event-coordinate viz changes the key").key,
    );
  });
});

describe("snapshot participation in the key", () => {
  it("invalidates when the data snapshot changes", async () => {
    // Retroactive corrections are routine in football. Without this, corrected
    // data would never reach the site.
    const intent = build(byName("minimal defaults applied").input as RawInput);
    expect(await artifactKey(intent, "snap-a")).not.toBe(await artifactKey(intent, "snap-b"));
  });
});
