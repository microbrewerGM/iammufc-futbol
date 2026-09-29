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
  /** Stable, caller-owned id prefix for unique title/description references. */
  id: string;
  title: string;
  unit: string;
  decimals: number;
  /** Generated from the computed values, not hand-written. */
  altText: string;
  /** Locale-aware number formatting (decimal comma for es-ES etc). Defaults
   *  to formatValue's plain decimal-point behaviour if omitted. */
  formatValue?: (value: number | null, decimals: number) => string;
  language?: "en" | "es";
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
  opts: { title: string; decimals: number; formatValue?: typeof formatValue; language?: "en" | "es" },
): string {
  const fmt = opts.formatValue ?? formatValue;
  const language = opts.language ?? "en";
  if (rows.length === 0) return language === "es"
    ? `${opts.title}: sin resultados.`
    : `${opts.title}: no results.`;
  const top = rows[0]!;
  const parts = rows
    .slice(0, 3)
    .map((r) => `${r.label} ${fmt(r.value, opts.decimals)}`)
    .join(", ");
  const leaders = language === "es"
    ? rows.length === 1 ? "Primer resultado" : rows.length === 2 ? "Dos primeros" : "Tres primeros"
    : rows.length === 1 ? "Top result" : rows.length === 2 ? "Top two" : "Top three";
  return language === "es"
    ? `${opts.title}. ${rows.length} resultado${rows.length === 1 ? "" : "s"}, ` +
      `${rows.length === 1 ? "encabezado" : "encabezados"} por ${top.label} con ${fmt(top.value, opts.decimals)}. ${leaders}: ${parts}.`
    : `${opts.title}. ${rows.length} result${rows.length === 1 ? "" : "s"}, ` +
      `led by ${top.label} on ${fmt(top.value, opts.decimals)}. ${leaders}: ${parts}.`;
}

function chartFrame(content: string, height: number, opts: ChartOptions): string {
  const titleId = `${opts.id}-title`;
  const descId = `${opts.id}-desc`;
  return `<svg viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}" role="img" aria-labelledby="${esc(titleId)} ${esc(descId)}" class="chart">
<title id="${esc(titleId)}">${esc(opts.title)}</title>
<desc id="${esc(descId)}">${esc(opts.altText)}</desc>
${content}
</svg>`;
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
  return chartFrame(bars, height, opts);
}

/** Horizontal dot plot for categorical rankings. Unlike a line chart it does
 * not imply continuity between players. Its domain always includes zero, and
 * null remains unavailable rather than becoming a numeric zero. */
export function dotPlotSvg(rows: ResultRow[], opts: ChartOptions): string {
  if (rows.length === 0) return "";
  const fmt = opts.formatValue ?? formatValue;
  const numeric = rows.flatMap((row) => row.value === null || Number.isNaN(row.value) ? [] : [row.value]);
  let min = Math.min(0, ...numeric);
  let max = Math.max(0, ...numeric);
  if (min === max) { min = -1; max = 1; }
  const plotWidth = WIDTH - LABEL_WIDTH - VALUE_WIDTH - PAD * 2;
  const scale = (value: number) => LABEL_WIDTH + ((value - min) / (max - min)) * plotWidth;
  const zeroX = scale(0);
  const height = rows.length * ROW_HEIGHT + PAD * 2;
  const marks = rows.map((row, index) => {
    const y = PAD + index * ROW_HEIGHT + 15;
    const dot = row.value === null || Number.isNaN(row.value)
      ? ""
      : `<circle cx="${scale(row.value).toFixed(1)}" cy="${y}" r="5" class="dot"/>`;
    return `<text x="${LABEL_WIDTH - 8}" y="${y + 4}" class="lbl" text-anchor="end">${esc(row.label)}</text>` +
      `<line x1="${LABEL_WIDTH}" y1="${y}" x2="${LABEL_WIDTH + plotWidth}" y2="${y}" class="dot-guide"/>` +
      dot +
      `<text x="${LABEL_WIDTH + plotWidth + 8}" y="${y + 4}" class="val">${esc(fmt(row.value, opts.decimals))}</text>`;
  }).join("");
  const axis = `<line x1="${zeroX.toFixed(1)}" y1="${PAD}" x2="${zeroX.toFixed(1)}" y2="${height - PAD}" class="zero-axis"/>`;
  return chartFrame(`${axis}${marks}`, height, opts);
}
