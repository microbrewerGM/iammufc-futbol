import { describe, expect, it } from "vitest";
// @ts-expect-error Node's built-in module is available in the configured test runtime.
import * as nodeFs from "node:fs";

const { readFileSync } = nodeFs as unknown as {
  readFileSync(path: URL, encoding: "utf8"): string;
};
const css = readFileSync(new URL("../worker/public/style.css", import.meta.url), "utf8");

describe("served focus and button states", () => {
  it("provides visible focus styles for each interactive element", () => {
    for (const selector of ["a", "button", "input", "select", "summary"]) {
      expect(css).toMatch(new RegExp(`(?:^|,)\\s*${selector}:focus-visible\\s*(?:,|\\{)`, "m"));
    }
  });

  it("provides hover, active, and disabled button feedback", () => {
    for (const state of ["hover", "active", "disabled"]) {
      expect(css).toMatch(new RegExp(`button:${state}\\s*\\{`));
    }
  });

  it("defines the shared focus ring with light and dark scheme colors", () => {
    expect(css).toMatch(/:root\s*\{[^}]*--focus-ring:\s*#[\da-f]{6}/i);
    expect(css).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)[\s\S]*?:root\s*\{[^}]*--focus-ring:\s*#[\da-f]{6}/i);
    expect(css).toMatch(/outline:\s*2px solid var\(--focus-ring\)/);
  });

  it("keeps the response states in the external stylesheet", () => {
    expect(css).not.toMatch(/<script\b|<style\b|\sstyle\s*=/i);
  });
});
