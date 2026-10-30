import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import { page } from "../worker/src/views/layout";

describe("opponent history navigation entry", () => {
  it("links each locale to its queryless opponent history selection route", () => {
    for (const locale of Object.values(LOCALES)) {
      const markup = page("", {
        title: "History",
        locale,
        unprefixedPath: "/",
      });

      expect(markup).toContain(
        `<a href="/${locale.code}/opponents/history">${locale.strings.opponentHistoryLink}</a>`,
      );
      expect(markup).not.toContain(`/${locale.code}/opponents/history?`);
    }
  });
});
