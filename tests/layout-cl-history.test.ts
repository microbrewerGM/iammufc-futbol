import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import { page } from "../worker/src/views/layout";

describe("Champions League history navigation", () => {
  it("renders a localized, semantic link in the shared navigation", () => {
    for (const [code, href, label] of [
      ["en", "/en/seasons/champions-league", "Champions League history"],
      ["es", "/es/seasons/champions-league", "Historia de la Champions League"],
    ] as const) {
      const markup = page("", { title: "History", locale: LOCALES[code], unprefixedPath: "/" });
      const nav = markup.match(/<nav class="analysis-nav"[^>]*>([\s\S]*?)<\/nav>/)?.[1];

      expect(nav).toContain(`<a href="${href}">${label}</a>`);
      expect(nav).not.toContain('role="link"');
    }
  });
});
