import { pathToFileURL } from 'node:url';

// Fixed dev target: never forward service credentials to redirects or prod.
const origin = 'https://iammufc-dev.aaron-cf2.workers.dev';

const topKeys = ['ai_bound', 'coverage_cells', 'coverage_through', 'data_state',
  'last_successful_refresh_at', 'metrics', 'ok', 'snapshot_id', 'snapshot_prepared_at', 'sources'];
const sourceKeys = ['coverage_through', 'id', 'retrieved_at', 'source_as_of', 'status'];
const sourceIds = ['fpl', 'football_data_couk', 'openfootball_cl'];
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exactKeys = (value, expected) => {
  if (!plain(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const normalizedIso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const season = (value) => typeof value === 'string' && /^\d{4}-\d{2}$/.test(value);

/** Independent deployed-wire validator. Returns only a safe finite state; raw
 * publication metadata never reaches CLI output. */
export function validateHealthPayload(value) {
  if (!exactKeys(value, topKeys) || value.ok !== true ||
      !['current', 'degraded'].includes(value.data_state) ||
      typeof value.snapshot_id !== 'string' || !/^[a-f0-9]{64}$/.test(value.snapshot_id) ||
      !normalizedIso(value.snapshot_prepared_at) || !normalizedIso(value.last_successful_refresh_at) ||
      Date.parse(value.last_successful_refresh_at) < Date.parse(value.snapshot_prepared_at) ||
      !season(value.coverage_through) || !Number.isSafeInteger(value.metrics) || value.metrics < 1 ||
      !Number.isSafeInteger(value.coverage_cells) || value.coverage_cells < 1 ||
      typeof value.ai_bound !== 'boolean' || !Array.isArray(value.sources) || value.sources.length !== 3) {
    return null;
  }
  const byId = new Map();
  for (const source of value.sources) {
    if (!exactKeys(source, sourceKeys) || !sourceIds.includes(source.id) || byId.has(source.id) ||
        source.source_as_of !== null) return null;
    byId.set(source.id, source);
  }
  const core = ['fpl', 'football_data_couk'].map((id) => byId.get(id));
  if (core.some((source) => !source || source.status !== 'observed' ||
      !season(source.coverage_through) || !normalizedIso(source.retrieved_at))) return null;
  const optional = byId.get('openfootball_cl');
  const optionalObserved = optional?.status === 'observed' && season(optional.coverage_through) &&
    normalizedIso(optional.retrieved_at);
  const optionalUnavailable = optional?.status === 'unavailable' && optional.coverage_through === null &&
    optional.retrieved_at === null;
  if (!optionalObserved && !optionalUnavailable) return null;
  if ((value.data_state === 'current') !== Boolean(optionalObserved)) return null;
  if (value.coverage_through !== core.map((source) => source.coverage_through).sort()[0]) return null;
  return value.data_state;
}

export async function smoke(env, request = fetch) {
  const id = env.CF_ACCESS_CLIENT_ID;
  const secret = env.CF_ACCESS_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Missing dev Access service credentials.');
  const headers = { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret, Origin: origin };
  const cases = [
    { path: '/en', marker: 'Ask about Manchester United' },
    { path: '/es', marker: 'Pregunta sobre el Manchester United' },
    { path: '/style.css', marker: 'font-family' },
    { path: '/en/ask', marker: 'Assists — 2023-24 PL', method: 'POST', body: 'q=Top+assists+2023-24' },
    { path: '/api/health', health: true },
  ];
  const results = [];
  for (const check of cases) {
    const response = await request(origin + check.path, {
      method: check.method ?? 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { ...headers, ...(check.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      ...(check.body ? { body: check.body } : {}),
    });
    const privateResponse = response.headers.get('cache-control')?.includes('no-store');
    // Never print response bodies, headers, credentials, exceptions or raw
    // health metadata. Only the finite current/degraded/invalid state may leave.
    const body = await response.text();
    let healthState = null;
    if (check.health && /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      try { healthState = validateHealthPayload(JSON.parse(body)); } catch { healthState = null; }
    }
    const pass = response.status === 200 && Boolean(privateResponse) &&
      (check.health ? healthState !== null : body.includes(check.marker));
    results.push({ path: check.path, status: response.status, pass,
      ...(check.health ? { health_state: pass ? healthState : 'invalid' } : {}) });
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const results = await smoke(process.env);
    console.log(JSON.stringify(results));
    if (results.some((result) => !result.pass)) process.exitCode = 1;
  } catch {
    console.error('Dev Access smoke failed; check credential provisioning and connectivity. Details suppressed.');
    process.exitCode = 1;
  }
}
