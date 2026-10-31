// @ts-expect-error Node's built-in module is available in the configured test runtime.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("CI test job shape", () => {
  it("disables checkout credential persistence and typechecks before Vitest", () => {
    const workflow = readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    const testStart = workflow.indexOf("  test:\n");
    const nextJob = workflow.indexOf("\n  supply-chain:", testStart);
    const testJob = testStart >= 0 && nextJob >= 0
      ? workflow.slice(testStart, nextJob)
      : "";
    expect(testJob).not.toBe("");

    const checkout = testJob?.match(
      /^      - uses: actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1(?: #.*)?\n        with:\n          persist-credentials: false$/m,
    );
    expect(checkout).not.toBeNull();
    const typecheckIndex = testJob.indexOf("      - name: Typecheck");
    const testsIndex = testJob.indexOf("      - name: TypeScript tests");
    expect(typecheckIndex).toBeGreaterThanOrEqual(0);
    expect(testsIndex).toBeGreaterThanOrEqual(0);
    expect(typecheckIndex).toBeLessThan(testsIndex);
  });
});
