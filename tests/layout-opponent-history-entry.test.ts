import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import { page } from "../worker/src/views/layout";

describe("opponent history navigation entry", () => {
  for (const code of ["en", "es"] as const) {
    it(`opens the ${code} selection form without a preset scope`, () => {
      const locale = LOCALES[code];
      const markup = page("", { title: "Home", locale, unprefixedPath: "/" });
      expect(markup).toContain(
        `<a href="/${code}/opponents/history">${locale.strings.opponentHistoryLink}</a>`,
      );
      expect(markup).not.toContain(`/opponents/history?`);
    });
  }
});
