import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import { page } from "../worker/src/views/layout";

describe("localized page links", () => {
  it("uses the registered homepage paths without trailing slashes", () => {
    for (const locale of Object.values(LOCALES)) {
      const markup = page("", { title: "Home", locale, unprefixedPath: "/" });
      expect(markup).toContain('href="/en"');
      expect(markup).toContain('href="/es"');
      expect(markup).not.toContain('href="/en/"');
      expect(markup).not.toContain('href="/es/"');
    }
  });

  it("preserves nested paths and query strings", () => {
    const markup = page("", {
      title: "Query", locale: LOCALES.en,
      unprefixedPath: "/q?metric=goals&season=2024-25",
    });
    expect(markup).toContain('href="/en/q?metric=goals&amp;season=2024-25"');
    expect(markup).toContain('href="/es/q?metric=goals&amp;season=2024-25"');
  });
});
