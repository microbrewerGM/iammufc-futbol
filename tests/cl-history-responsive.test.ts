import { describe, expect, it } from "vitest";
// @ts-expect-error Node's built-in module is available in the configured test runtime.
import * as nodeFs from "node:fs";

const { readFileSync } = nodeFs as unknown as { readFileSync(path: URL, encoding: "utf8"): string };
const css = readFileSync(new URL("../worker/public/style.css", import.meta.url), "utf8");

describe("Champions League history responsive table styles", () => {
  it("limits sticky season labels to the history table on narrow screens", () => {
    const mediaBlocks = [...css.matchAll(/@media\s*\(\s*max-width\s*:[^)]*\)\s*\{([\s\S]*?)\n\}/g)];
    const stickyRule = mediaBlocks.flatMap((match) => {
      const block = match[1] ?? "";
      return [...block.matchAll(/((?:[^{}]+))\{([^{}]*)\}/g)];
    }).find((match) => {
      const selector = match[1] ?? "";
      const declarations = match[2] ?? "";
      return /position:\s*sticky/.test(declarations) && /left:\s*0/.test(declarations) && selector.includes("Champions League history");
    });

    expect(stickyRule).toBeDefined();
    const selector = stickyRule?.[1] ?? "";
    expect(selector).toContain('.comparison-table[aria-label="Champions League history"]');
    expect(selector).toContain('.comparison-table[aria-label="Historial de la Liga de Campeones"]');
    expect(selector).not.toMatch(/aria-label=(?!"Champions League history"|"Historial de la Liga de Campeones")/);
    expect(selector).toMatch(/th:first-child/);
    expect(selector).toMatch(/td:first-child/);
  });

  it("keeps the history scroll region visibly focused for keyboard users", () => {
    const focusRule = css.match(/((?:[^{}]+))\{([^{}]*)\}/g)?.find((rule) => rule.includes(".comparison-table:focus-visible"));
    expect(focusRule).toMatch(/outline:\s*[^;]+;/);
  });
});
