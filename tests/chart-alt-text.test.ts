import { describe, expect, it } from "vitest";
import { buildChartAltText, chartAltTextTemplates } from "../worker/src/core/chart-alt-text";

describe("chart alt text", () => {
  it("describes range, first and last supported seasons, and gaps in English", () => {
    expect(buildChartAltText([
      { season: "2021-22", value: null }, { season: "2022-23", value: 4 },
      { season: "2023-24", value: null }, { season: "2024-25", value: 7 },
    ], chartAltTextTemplates.en)).toBe("Values range from 4 to 7, from 2022-23 to 2024-25. No data for 2021-22 No data for 2023-24");
  });

  it("uses supplied Spanish templates", () => {
    expect(buildChartAltText([{ season: "2023-24", value: 2 }], chartAltTextTemplates.es))
      .toBe("Los valores van de 2 a 2, desde 2023-24 hasta 2023-24.");
  });

  it("returns a localized no-data sentence for an all-gap series", () => {
    expect(buildChartAltText([{ season: "2023-24", value: null }], chartAltTextTemplates.en))
      .toBe("No data is available for this series.");
  });

  it("escapes template text and season labels", () => {
    const malicious = { season: "<img&'\"", value: null };
    const result = buildChartAltText([malicious], {
      summary: () => "<summary>", noData: () => "<none>", gap: (season) => `gap ${season}`,
    });
    expect(result).toBe("&lt;none&gt;");
  });
});
