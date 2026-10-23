import { describe, expect, it } from "vitest";
// Node APIs are available in Vitest's Node runtime; this project omits Node typings.
// @ts-expect-error Node runtime module.
import { readFileSync } from "node:fs";
// @ts-expect-error Node runtime module.
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import {
  artifactKey,
  canonicalize,
  RENDERER_VERSION,
  TRANSFORM_CODE_VERSION,
  withDefaults,
  type QueryIntent,
} from "../worker/src/core/intent";
import { parseIntent } from "../worker/src/core/validate-intent";
import vectors from "./vectors/artifact-keys.json" with { type: "json" };

// R8's fallback scope: this protects the existing query/cache identity. Neither
// arrival-manager nor season-split exploration has a four-input key wired here.
const request = withDefaults({
  metric: "goals", entity_type: "player", entity_id: "p1", season: "2024-25",
});
const snapshot = vectors.snapshot_id;

/** Exercise the real source with a build-time constant changed in memory only.
 * Export mocks cannot change same-module lexical references. No fixture or
 * production file is rewritten, and the unmodified copy must match real keys.
 */
function isolatedIdentity(version?: "TRANSFORM_CODE_VERSION" | "RENDERER_VERSION") {
  let source: string = readFileSync("worker/src/core/intent.ts", "utf8");
  if (version) {
    const declaration = new RegExp(`export const ${version} = "[^"]+";`, "g");
    expect(source.match(declaration)).toHaveLength(1);
    source = source.replace(declaration, `export const ${version} = "test-only-next-version";`);
  }
  const { outputText, diagnostics } = transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  expect(diagnostics).toEqual([]);
  const exports = {} as typeof import("../worker/src/core/intent");
  runInNewContext(outputText, { exports, crypto, TextEncoder }, { timeout: 1000 });
  return exports;
}

describe("existing query/cache identity replay contract (exploration fallback)", () => {
  it("repeats the frozen identity across independent equivalent requests", async () => {
    const vector = vectors.vectors[0]!;
    expect(await artifactKey(request, snapshot)).toBe(vector.key);
    expect(await artifactKey(JSON.parse(JSON.stringify(request)) as QueryIntent, snapshot)).toBe(vector.key);
    expect(await artifactKey(withDefaults({
      metric: "goals", entity_type: "player", entity_id: "p1", season: "2024-25",
      competition: "PL", dimensions: [], filters: {}, viz: "table", limit: 10,
    }), snapshot)).toBe(vector.key);
  });

  it("ignores object/filter key order and dimension order without mutating requests", async () => {
    const first = { ...request, dimensions: ["season", "opponent"], filters: { venue: "home", opponent: "Arsenal" } };
    const reordered = Object.fromEntries(Object.entries({
      ...first, dimensions: ["opponent", "season"], filters: { opponent: "Arsenal", venue: "home" },
    }).reverse()) as unknown as QueryIntent;
    const before = JSON.stringify(first);
    expect(canonicalize(reordered)).toBe(canonicalize(first));
    expect(await artifactKey(reordered, snapshot)).toBe(await artifactKey(first, snapshot));
    expect(JSON.stringify(first)).toBe(before);
  });

  const changes: [keyof QueryIntent, QueryIntent[keyof QueryIntent]][] = [
    ["metric", "assists"], ["entity_type", "season"], ["entity_id", "p2"],
    ["season", "2023-24"], ["competition", "CL"], ["dimensions", ["opponent"]],
    ["filters", { venue: "away" }], ["viz", "bar"], ["limit", 5],
  ];
  it.each(changes)("invalidates when canonical %s changes", async (field, value) => {
    expect(await artifactKey({ ...request, [field]: value }, snapshot))
      .not.toBe(await artifactKey(request, snapshot));
  });

  it("invalidates on a corrected snapshot and reproduces the original on replay", async () => {
    const original = await artifactKey(request, snapshot);
    expect(await artifactKey(request, `${snapshot}-corrected`)).not.toBe(original);
    expect(await artifactKey(request, snapshot)).toBe(original);
  });

  it("keeps locale/account/question context outside the closed query contract", async () => {
    const baseline = await artifactKey(request, snapshot);
    for (const context of [
      { locale: "en", account: "synthetic-a", question: "Show goals" },
      { locale: "es", account: "synthetic-b", question: "Muestra los goles" },
    ]) {
      // Existing defaults project known fields only; the public parser instead
      // rejects context embedded in an intent. Do not hash an unvalidated object.
      expect(await artifactKey(withDefaults({ ...request, ...context }), snapshot)).toBe(baseline);
      for (const [field, value] of Object.entries(context)) {
        expect(parseIntent({ ...request, [field]: value })).toEqual({
          ok: false, issue: { code: "unsupported_field", field: "intent" },
        });
      }
    }
  });

  it("validates the isolated source against every committed vector and the actual module", async () => {
    const isolated = isolatedIdentity();
    expect(isolated.TRANSFORM_CODE_VERSION).toBe(TRANSFORM_CODE_VERSION);
    expect(isolated.RENDERER_VERSION).toBe(RENDERER_VERSION);
    for (const vector of vectors.vectors) {
      const intent = withDefaults(vector.input as Partial<QueryIntent>);
      expect(await isolated.artifactKey(intent, snapshot)).toBe(vector.key);
      expect(await isolated.artifactKey(intent, snapshot)).toBe(await artifactKey(intent, snapshot));
    }
  });

  it.each(["TRANSFORM_CODE_VERSION", "RENDERER_VERSION"] as const)(
    "invalidates on an independent %s build change",
    async (version) => {
      const baseline = isolatedIdentity();
      const changed = isolatedIdentity(version);
      const other = version === "TRANSFORM_CODE_VERSION" ? "RENDERER_VERSION" : "TRANSFORM_CODE_VERSION";
      expect(changed[version]).not.toBe(baseline[version]);
      expect(changed[other]).toBe(baseline[other]);
      for (const vector of vectors.vectors) {
        const intent = withDefaults(vector.input as Partial<QueryIntent>);
        expect(changed.canonicalize(intent)).toBe(baseline.canonicalize(intent));
        expect(await changed.artifactKey(intent, snapshot)).not.toBe(await baseline.artifactKey(intent, snapshot));
      }
    },
  );
});
