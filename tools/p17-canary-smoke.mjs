import { pathToFileURL } from 'node:url';

const origin = 'https://iammufc-dev.aaron-cf2.workers.dev';
const intentKeys = ['competition', 'dimensions', 'entity_id', 'entity_type', 'filters', 'limit',
  'metric', 'season', 'viz'];
const chatKeys = ['confidence', 'feasibility', 'model_status', 'next', 'notes',
  'proposed_intent', 'source'];
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exactKeys = (value, expected) => plain(value) &&
  Object.keys(value).sort().join('|') === [...expected].sort().join('|');
const stable = (value) => Array.isArray(value)
  ? value.map(stable)
  : plain(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
    : value;
const canonical = (value) => JSON.stringify(stable(value));

const expectedIntent = (metric, season, entityId = 'all', viz = 'bar') => ({
  metric, entity_type: 'player', entity_id: entityId, season, competition: 'PL',
  dimensions: [], filters: {}, viz, limit: 10,
});

const cases = [
  { id: 'en_supported', question: 'Top goals 2024-25',
    expected: expectedIntent('goals', '2024-25') },
  { id: 'es_supported', question: 'Más asistencias 2023-24 tabla',
    expected: expectedIntent('assists', '2023-24', 'all', 'table') },
  { id: 'quoted_identity', question: '"Rashford" goals 2024-25',
    expected: expectedIntent('goals', '2024-25', 'Rashford') },
  { id: 'unsupported_rate', question: 'Top goals per 90 2024-25', rejection: 'unsupported_semantics' },
  { id: 'ambiguous_identity', question: 'Fernandes goals 2024-25', clarification: true,
    expected: expectedIntent('goals', '2024-25') },
  { id: 'missing_season', question: 'Most assists', clarification: true,
    expected: expectedIntent('assists', '2025-26') },
];

function validateAccepted(value, expected) {
  return exactKeys(value, chatKeys) && exactKeys(value.proposed_intent, intentKeys) &&
    value.source === 'ai' && value.model_status === 'accepted' && value.confidence === 'high' &&
    Array.isArray(value.notes) && value.notes.length === 0 &&
    canonical(value.proposed_intent) === canonical(expected);
}

function validateClarification(value, expected) {
  return exactKeys(value, chatKeys) && exactKeys(value.proposed_intent, intentKeys) &&
    value.source === 'rules' && value.model_status === 'not_attempted_ambiguous' &&
    value.confidence === 'low' && Array.isArray(value.notes) && plain(value.feasibility) &&
    canonical(value.proposed_intent) === canonical(expected);
}

function validateRejection(value, code) {
  return exactKeys(value, ['code', 'feasibility', 'proposed_intent', 'reason', 'rejected', 'suggestion']) &&
    value.rejected === true && value.code === code && value.proposed_intent === null &&
    value.feasibility === null && typeof value.reason === 'string' && typeof value.suggestion === 'string';
}

export async function runP17Canary(env, request = fetch) {
  const id = env.CF_ACCESS_CLIENT_ID;
  const secret = env.CF_ACCESS_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Missing dev Access service credentials.');
  const headers = {
    'CF-Access-Client-Id': id,
    'CF-Access-Client-Secret': secret,
    'X-IAMMUFC-P17-Canary': 'v1',
    Origin: origin,
    'Content-Type': 'application/json',
  };
  const aggregates = [];
  for (const testCase of cases) {
    let latency = 0;
    for (let trial = 1; trial <= 3; trial += 1) {
      const started = performance.now();
      const response = await request(`${origin}/api/chat`, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000), headers,
        body: JSON.stringify({ question: testCase.question }),
      });
      latency += performance.now() - started;
      const privateResponse = response.headers.get('cache-control')?.includes('no-store');
      const isJson = /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '');
      let value = null;
      if (isJson) {
        try { value = JSON.parse(await response.text()); } catch { value = null; }
      }
      const valid = testCase.rejection
        ? response.status === 422 && validateRejection(value, testCase.rejection)
        : testCase.clarification
          ? response.status === 200 && validateClarification(value, testCase.expected)
          : response.status === 200 && validateAccepted(value, testCase.expected);
      if (!privateResponse || !valid) {
        throw new Error(`P17 canary stopped at ${testCase.id} trial ${trial}`);
      }
    }
    aggregates.push({ id: testCase.id, trials: 3, passed: true,
      mean_latency_ms: Math.round(latency / 3) });
  }
  return aggregates;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await runP17Canary(process.env)));
  } catch {
    console.error('P17 canary failed; provider and response details suppressed.');
    process.exitCode = 1;
  }
}
