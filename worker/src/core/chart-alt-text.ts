export interface ChartAltTextTemplates {
  summary: (args: { min: string; max: string; firstSeason: string; lastSeason: string }) => string;
  noData: () => string;
  gap: (season: string) => string;
}

export const chartAltTextTemplates = {
  en: {
    summary: ({ min, max, firstSeason, lastSeason }) => `Values range from ${min} to ${max}, from ${firstSeason} to ${lastSeason}.`,
    noData: () => "No data is available for this series.",
    gap: (season) => `No data for ${season}`,
  },
  es: {
    summary: ({ min, max, firstSeason, lastSeason }) => `Los valores van de ${min} a ${max}, desde ${firstSeason} hasta ${lastSeason}.`,
    noData: () => "No hay datos disponibles para esta serie.",
    gap: (season) => `No hay datos para ${season}`,
  },
} satisfies Record<string, ChartAltTextTemplates>;

export interface ChartAltTextPoint { season: string; value: number | null }

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** Build accessible chart copy from caller-supplied localized templates. Nulls remain gaps. */
export function buildChartAltText(points: readonly ChartAltTextPoint[], templates: ChartAltTextTemplates): string {
  const supported = points.filter((point) => point.value !== null);
  if (supported.length === 0) return escapeText(templates.noData());

  const values = supported.map((point) => point.value!);
  const summary = templates.summary({
    min: String(Math.min(...values)),
    max: String(Math.max(...values)),
    firstSeason: supported[0]!.season,
    lastSeason: supported[supported.length - 1]!.season,
  });
  const gaps = points.filter((point) => point.value === null).map((point) => templates.gap(point.season));
  return escapeText([summary, ...gaps].join(" "));
}
