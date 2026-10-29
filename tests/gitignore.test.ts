import { describe, expect, it } from "vitest";
// @ts-expect-error Node built-ins are available in the configured test runtime.
import { readFileSync } from "node:fs";

const lines: string[] = (readFileSync(".gitignore", "utf8") as string)
  .split("\n")
  .map((line: string) => line.trim());

describe(".gitignore hardening", () => {
  it.each([".worktrees/", ".dev.vars.*", "*.key", "*.p12"])(
    "ignores %s",
    (pattern) => {
      expect(lines).toContain(pattern);
    },
  );
});
