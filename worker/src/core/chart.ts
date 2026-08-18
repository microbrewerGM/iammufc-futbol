/**
 * Inline SVG horizontal bar chart.
 *
 * Rendered server-side from separated data and labels, so the Spanish tree at
 * M2 re-labels the same numbers rather than regenerating a second image.
 *
 * No client-side charting library, which means:
 *   * CSP can stay at `script-src 'none'` -- no nonce gymnastics, no
 *     'unsafe-inline' compromise to rationalise later
 *   * the chart works with JavaScript disabled
 *   * output is deterministic, which content-addressed caching requires
 *
 * Vega-Lite arrives when interactivity earns its cost. It cannot express pitch
 * overlays anyway, so the M4 mplsoccer path is unaffected by this choice.
 */

import type { ResultRow } from "./db";

export interface ChartOptions {
  title: string;
  unit: string;
  decimals: number;
  /** Generated from the computed values, not hand-written. */
  altText: string;
  /** Locale-aware number formatting (decimal comma for es-ES etc). Defaults
   *  to formatValue's plain decimal-point behaviour if omitted. */
  formatValue?: (value: number | null, decimals: number) => string;
}

const WIDTH = 720;
const ROW_HEIGHT = 30;
const LABEL_WIDTH = 132;
const VALUE_WIDTH = 64;
const PAD = 12;

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatValue(value: number | null, decimals: number): string {
  if (value === null || Number.isNaN(value)) return "—";
  return value.toFixed(decimals);
}

export function buildAltText(
  rows: ResultRow[],
  opts: { title: string; decimals: number; formatValue?: typeof formatValue },
): string {
  const fmt = opts.formatValue ?? formatValue;
  if (rows.length === 0) return `${opts.title}: no results.`;
  const top = rows[0]!;
  const parts = rows
    .slice(0, 3)
    .map((r) => `${r.label} ${fmt(r.value, opts.decimals)}`)
    .join(", ");
  return (
    `${opts.title}. ${rows.length} result${rows.length === 1 ? "" : "s"}, ` +
    `led by ${top.label} on ${fmt(top.value, opts.decimals)}. Top three: ${parts}.`
  );
}

export function barChartSvg(rows: ResultRow[], opts: ChartOptions): string {
  if (rows.length === 0) return "";

  const fmt = opts.formatValue ?? formatValue;
  const max = Math.max(...rows.map((r) => r.value ?? 0), 1);
  const barMax = WIDTH - LABEL_WIDTH - VALUE_WIDTH - PAD * 2;
  const height = rows.length * ROW_HEIGHT + PAD * 2;

  const bars = rows
    .map((row, i) => {
      const y = PAD + i * ROW_HEIGHT;
      const value = row.value ?? 0;
      const w = Math.max((value / max) * barMax, value > 0 ? 2 : 0);
      return [
        `<text x="${LABEL_WIDTH - 8}" y="${y + 19}" class="lbl" text-anchor="end">${esc(row.label)}</text>`,
        `<rect x="${LABEL_WIDTH}" y="${y + 6}" width="${w.toFixed(1)}" height="18" rx="3" class="bar"/>`,
        `<text x="${LABEL_WIDTH + w + 8}" y="${y + 19}" class="val">${esc(fmt(row.value, opts.decimals))}</text>`,
      ].join("");
    })
    .join("");

  // role="img" plus a title/desc pair is what makes this legible to a screen
  // reader. The data table below the chart is the real fallback.
  return `<svg viewBox="0 0 ${WIDTH} ${height}" width="100%" height="${height}" role="img" aria-labelledby="cht cdesc" class="chart">
<title id="cht">${esc(opts.title)}</title>
<desc id="cdesc">${esc(opts.altText)}</desc>
${bars}
</svg>`;
}
