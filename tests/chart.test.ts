import { describe, expect, it } from "vitest";
import { barChartSvg, buildAltText, dotPlotSvg } from "../worker/src/core/chart";
import type { ResultRow } from "../worker/src/core/db";

const rows: ResultRow[] = [
  { label: "Negative", value: -2 },
  { label: "Zero", value: 0 },
  { label: "Positive", value: 2 },
  { label: "Unavailable", value: null },
];

const options = {
  id: "chart-deadbeef",
  title: "Goals",
  unit: "goals",
  decimals: 2,
  altText: "Computed summary",
} as const;

describe("server-rendered charts", () => {
  it("renders a deterministic dot plot across negative, zero, positive and null values", () => {
    const markup = dotPlotSvg(rows, options);
    expect(dotPlotSvg(rows, options)).toBe(markup);
    expect(markup).toContain('width="720"');
    expect(markup).toContain('aria-labelledby="chart-deadbeef-title chart-deadbeef-desc"');
    expect(markup).toContain('cx="132.0"');
    expect(markup).toContain('cx="382.0"');
    expect(markup).toContain('cx="632.0"');
    expect(markup.match(/<circle /g)).toHaveLength(3);
    expect(markup).toContain("Unavailable");
    expect(markup).toContain("—");
    expect(markup).not.toMatch(/NaN|Infinity/);
  });

  it("keeps ties aligned and centers an all-zero domain", () => {
    const tied = dotPlotSvg([
      { label: "First", value: 0 },
      { label: "Second", value: 0 },
    ], options);
    expect(tied.match(/cx="382.0"/g)).toHaveLength(2);
    expect(tied.indexOf("First")).toBeLessThan(tied.indexOf("Second"));
  });

  it("localizes generated chart summaries and values", () => {
    const format = (value: number | null, decimals: number) => value === null
      ? "—"
      : value.toFixed(decimals).replace(".", ",");
    expect(buildAltText([{ label: "Jugador", value: 1.5 }], {
      title: "Goles", decimals: 2, formatValue: format, language: "es",
    })).toContain("1 resultado, encabezado por Jugador con 1,50. Primer resultado:");
    expect(buildAltText([], { title: "Goles", decimals: 0, language: "es" })).toBe("Goles: sin resultados.");
  });

  it("escapes labels and gives separate charts unique accessible ids", () => {
    const hostile = [{ label: '<script>&"', value: 1 }];
    const dot = dotPlotSvg(hostile, { ...options, id: "dot-one" });
    const bar = barChartSvg(hostile, { ...options, id: "bar-one" });
    expect(dot).toContain("&lt;script&gt;&amp;&quot;");
    expect(dot).not.toContain("<script>");
    expect(dot).toContain("dot-one-title");
    expect(bar).toContain("bar-one-title");
    expect(dotPlotSvg([], options)).toBe("");
  });
});
