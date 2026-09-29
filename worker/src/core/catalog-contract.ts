import type {
  CompiledCatalog,
  CoverageCell,
  Granularity,
  MetricDef,
} from "./feasibility";

const GRANULARITIES = new Set(["box_score", "event_with_coords", "tracking"]);
const ENTITY_TYPES = new Set(["player", "match", "season", "opponent", "competition"]);
const COST_CLASSES = new Set(["cheap", "expensive"]);
const SOURCE_ID = /^[a-z][a-z0-9_]*$/;

const ROOT_KEYS = ["version", "metrics", "coverage"];
const METRIC_KEYS = [
  "metric_id",
  "label_en",
  "label_es",
  "description",
  "description_es",
  "granularity",
  "unit",
  "decimals",
];
const COVERAGE_KEYS = [
  "metric",
  "entity_type",
  "granularity",
  "season",
  "competition",
  "source_id",
  "redistributable",
  "cost_class",
  "attribution_asset",
  "attribution_text",
  "attribution_text_es",
  "source_name",
];

function invalid(path: string, message: string): never {
  throw new Error(`invalid public catalog at ${path}: ${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[], path: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid(path, `must contain exactly: ${wanted.join(", ")}`);
  }
}

function nonemptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(path, "must be a non-empty string");
  }
  return value;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") invalid(path, "must be a string");
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return stringValue(value, path);
}

function enumString<T extends string>(
  value: unknown,
  allowed: Set<string>,
  path: string,
): T {
  const decoded = nonemptyString(value, path);
  if (!allowed.has(decoded)) invalid(path, `unsupported value: ${decoded}`);
  return decoded as T;
}

function decodeMetric(value: unknown, index: number): MetricDef {
  const path = `$.metrics[${index}]`;
  const item = record(value, path);
  exactKeys(item, METRIC_KEYS, path);
  if (typeof item.decimals !== "number" || !Number.isInteger(item.decimals) || item.decimals < 0 || item.decimals > 6) {
    invalid(`${path}.decimals`, "must be an integer from 0 through 6");
  }
  return {
    metric_id: nonemptyString(item.metric_id, `${path}.metric_id`),
    label_en: stringValue(item.label_en, `${path}.label_en`),
    label_es: stringValue(item.label_es, `${path}.label_es`),
    description: stringValue(item.description, `${path}.description`),
    description_es: stringValue(item.description_es, `${path}.description_es`),
    granularity: enumString<Granularity>(item.granularity, GRANULARITIES, `${path}.granularity`),
    unit: stringValue(item.unit, `${path}.unit`),
    decimals: item.decimals,
  };
}

function decodeCoverage(value: unknown, index: number): CoverageCell {
  const path = `$.coverage[${index}]`;
  const item = record(value, path);
  exactKeys(item, COVERAGE_KEYS, path);
  if (typeof item.redistributable !== "boolean") {
    invalid(`${path}.redistributable`, "must be boolean");
  }
  const sourceId = nonemptyString(item.source_id, `${path}.source_id`);
  if (!SOURCE_ID.test(sourceId)) {
    invalid(`${path}.source_id`, "does not match the public contract");
  }
  return {
    metric: nonemptyString(item.metric, `${path}.metric`),
    entity_type: enumString(item.entity_type, ENTITY_TYPES, `${path}.entity_type`),
    granularity: enumString<Granularity>(item.granularity, GRANULARITIES, `${path}.granularity`),
    season: nonemptyString(item.season, `${path}.season`),
    competition: nonemptyString(item.competition, `${path}.competition`),
    source_id: sourceId,
    redistributable: item.redistributable,
    cost_class: enumString(item.cost_class, COST_CLASSES, `${path}.cost_class`),
    attribution_asset: nullableString(item.attribution_asset, `${path}.attribution_asset`),
    attribution_text: nullableString(item.attribution_text, `${path}.attribution_text`),
    attribution_text_es: nullableString(item.attribution_text_es, `${path}.attribution_text_es`),
    source_name: nonemptyString(item.source_name, `${path}.source_name`),
  };
}

export function decodeCompiledCatalog(value: unknown): CompiledCatalog {
  const root = record(value, "$");
  exactKeys(root, ROOT_KEYS, "$");
  if (root.version !== 1) invalid("$.version", "must be integer 1");
  if (!Array.isArray(root.metrics)) invalid("$.metrics", "must be an array");
  if (!Array.isArray(root.coverage)) invalid("$.coverage", "must be an array");

  const metrics = root.metrics.map(decodeMetric);
  const metricsById = new Map<string, MetricDef>();
  for (const metric of metrics) {
    if (metricsById.has(metric.metric_id)) {
      invalid("$.metrics", `duplicate metric_id: ${metric.metric_id}`);
    }
    metricsById.set(metric.metric_id, metric);
  }

  const coverage = root.coverage.map(decodeCoverage);
  const seenCells = new Set<string>();
  const sourceDisplay = new Map<string, string>();
  for (const cell of coverage) {
    const key = [cell.metric, cell.entity_type, cell.granularity, cell.season, cell.competition].join("\u0000");
    if (seenCells.has(key)) invalid("$.coverage", `duplicate coverage cell: ${key}`);
    seenCells.add(key);

    const metric = metricsById.get(cell.metric);
    if (!metric) invalid("$.coverage", `references missing metric: ${cell.metric}`);
    if (cell.granularity !== metric.granularity) {
      invalid("$.coverage", `granularity disagrees with metric ${cell.metric}`);
    }

    const display = JSON.stringify([
      cell.source_name,
      cell.redistributable,
      cell.attribution_asset,
      cell.attribution_text,
      cell.attribution_text_es,
    ]);
    const prior = sourceDisplay.get(cell.source_id);
    if (prior !== undefined && prior !== display) {
      invalid("$.coverage", `source display disagrees for ${cell.source_id}`);
    }
    sourceDisplay.set(cell.source_id, display);
  }

  return { version: 1, metrics, coverage };
}
