import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Fixed dev target: never forward service credentials to redirects or prod.
const origin = 'https://iammufc-dev.aaron-cf2.workers.dev';
const accessHost = 'odd-fog-375d.cloudflareaccess.com';
const denialCases = [
  '/en', '/es', '/en/compare', '/es/compare', '/en/data', '/es/data',
  '/en/season/2014-15', '/es/season/2014-15', '/en/season/2015-16', '/es/season/2015-16',
  '/api/catalog', '/api/health', '/api/chat', '/api/query', '/en/ask', '/es/ask',
  '/style.css', '/robots.txt', '/sitemap.xml', '/', '/q', '/data', '/player/access-probe',
  '/season/access-probe', '/season/2015-16', '/__access_probe_not_found__',
];
const playerCompareParams = new URLSearchParams({
  schema_version: '1', competition: 'PL', metric: 'goals', normalization: 'total',
  min_minutes: '0', viz: 'table',
});
const denialPostCases = [
  { path: '/en/ask', contentType: 'application/x-www-form-urlencoded', body: 'q=Top+assists+2023-24' },
  { path: '/es/ask', contentType: 'application/x-www-form-urlencoded', body: 'q=Top+asistencias+2023-24' },
  { path: '/api/chat', contentType: 'application/json', body: JSON.stringify({ question: 'Top goals 2024-25' }) },
  { path: '/api/query', contentType: 'application/json', body: '{}' },
];

const topKeys = ['ai_bound', 'coverage_cells', 'coverage_through', 'data_state',
  'last_successful_refresh_at', 'metrics', 'ok', 'snapshot_id', 'snapshot_prepared_at', 'sources'];
const sourceKeys = ['coverage_through', 'id', 'retrieved_at', 'source_as_of', 'status'];
const sourceIds = ['fpl', 'football_data_couk', 'openfootball_cl'];
const modelStatuses = ['not_configured', 'disabled', 'accepted', 'provider_error', 'invalid_output',
  'unsupported_intent'];
const chatKeys = ['confidence', 'feasibility', 'model_status', 'next', 'notes',
  'proposed_intent', 'source'];
const intentKeys = ['competition', 'dimensions', 'entity_id', 'entity_type', 'filters', 'limit',
  'metric', 'season', 'viz'];
const feasibilityKeys = new Set(['attribution_asset', 'attribution_text', 'cost_class',
  'nearest_alternative', 'reason', 'source_name', 'state']);
const queryKeys = ['artifact_key', 'attribution', 'feasibility', 'intent', 'rows', 'snapshot_id'];
const queryRowKeys = ['label', 'route_key', 'secondary', 'value'];
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
const safeErrorClass = (error) => ['AbortError', 'TimeoutError', 'TypeError', 'SyntaxError'].includes(error?.name)
  ? error.name : 'Error';
const triageContextPath = '/internal/question-triage-bridge/answer-now/context';
const triageContextLimit = 128 * 1024;

/** Validate the deployed context contract without returning private metadata. */
export function validateTriageContextPayload(value) {
  if (!exactKeys(value, ['version', 'kind', 'payload']) || value.version !== 1 ||
      value.kind !== 'answer_now_context' ||
      !exactKeys(value.payload, ['triage_protocol', 'glossary_protocol', 'catalog_json',
        'snapshot_id', 'catalog_digest', 'people', 'has_more'])) return null;
  const context = value.payload;
  if (context.triage_protocol !== 2 || context.glossary_protocol !== 1 ||
      typeof context.catalog_json !== 'string' || Buffer.byteLength(context.catalog_json, 'utf8') > 65536 ||
      typeof context.snapshot_id !== 'string' || context.snapshot_id.length < 1 ||
      context.snapshot_id.length > 128 || /[^a-zA-Z0-9:_-]/.test(context.snapshot_id) ||
      typeof context.catalog_digest !== 'string' ||
      context.catalog_digest.length !== 64 || /[^a-f0-9]/.test(context.catalog_digest) ||
      !Array.isArray(context.people) || context.people.length > 200 ||
      typeof context.has_more !== 'boolean') return null;
  try { JSON.parse(context.catalog_json); } catch { return null; }
  if (createHash('sha256').update(context.catalog_json, 'utf8').digest('hex') !== context.catalog_digest) return null;
  for (const person of context.people) {
    if (!exactKeys(person, ['id', 'label']) || typeof person.id !== 'string' ||
        person.id.length < 1 || person.id.length > 64 || !/^[a-z0-9]/.test(person.id) ||
        /[^a-z0-9:_-]/.test(person.id) || typeof person.label !== 'string' ||
        person.label.length < 1 || person.label.length > 120 || /[\p{Cc}\p{Cf}]/u.test(person.label)) return null;
  }
  return 'ready';
}

async function readTriageContext(response, text = false) {
  let reader;
  let complete = false;
  try {
    reader = response.body?.getReader();
    if (!reader) return null;
    let size = 0;
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) { complete = true; break; }
      if (!(value instanceof Uint8Array)) return null;
      size += value.byteLength;
      if (size > triageContextLimit) return null;
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text ? decoded : JSON.parse(decoded);
  } catch { return null; }
  finally {
    if (reader) {
      if (!complete) { try { await reader.cancel(); } catch { /* finite invalid result below */ } }
      try { reader.releaseLock(); } catch { /* no diagnostic data */ }
    }
  }
}

export function classifySeasonExplore(body, locale, canonical) {
  const languagePass = body.includes(`lang="${locale}"`);
  const canonicalPass = body.includes(`<link rel="canonical" href="${canonical}">`);
  const states = locale === 'es' ? [
    ['result_table', 'Rendimiento por temporada'],
    ['season_absent', '2014-15: Sin cobertura de desgloses'],
    ['capability_unavailable', 'La capacidad de desgloses por temporada no está publicada.'],
  ] : [
    ['result_table', 'Season performance'],
    ['season_absent', '2014-15: Missing split coverage'],
    ['capability_unavailable', 'Season splits capability is not published.'],
  ];
  const state = states.find(([, marker]) => body.includes(marker))?.[0] ?? null;
  const assertion = !languagePass ? 'language' : !canonicalPass ? 'canonical' : !state ? 'state_marker' : null;
  return { state, assertion };
}

const OPPONENT_UNPUBLISHED = {
  en: 'Season splits capability is not published.',
  es: 'La capacidad de desgloses por temporada no está publicada.',
};

/** Require the localized route shell and a positive rendered result state. */
export function classifyOpponentHistory(body, locale, path) {
  if (!['en', 'es'].includes(locale) || !body.includes(`<html lang="${locale}">`)) return 'invalid';
  const title = locale === 'es' ? 'Historial contra rivales' : 'Opponent history';
  const unpublished = body.includes(`<h1>${title}</h1><p>${OPPONENT_UNPUBLISHED[locale]}</p>`);
  const published = body.includes(`<caption>${title}</caption>`) ||
    body.includes(`<caption>${title} · `);
  if (!unpublished && !published) return 'invalid';
  // The existing unpublished page deliberately omits filters from its canonical.
  const canonical = unpublished ? `/${locale}/opponents/history` : path;
  if (!canonical || !body.includes(`<link rel="canonical" href="${canonical.replaceAll('&', '&amp;')}">`)) return 'invalid';
  return unpublished ? 'capability_unavailable' : 'published';
}

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

/** Compare a protected health payload to a producer expectation in memory.
 * Only the finite match verdict may leave the caller. */
export function validateSnapshotMatch(value, expectedSnapshotId) {
  return typeof expectedSnapshotId === 'string' && /^[a-f0-9]{64}$/.test(expectedSnapshotId) &&
    validateHealthPayload(value) !== null && value.snapshot_id === expectedSnapshotId;
}

/** Read the protected deployment health endpoint and return no publication IDs. */
export async function snapshotContinuitySmoke(env, request = fetch, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const id = env.CF_ACCESS_CLIENT_ID;
  const secret = env.CF_ACCESS_CLIENT_SECRET;
  const expectedSnapshotId = env.EXPECTED_PRIVATE_SNAPSHOT_ID;
  if (!id || !secret) throw new Error('Missing dev Access service credentials.');
  if (typeof expectedSnapshotId !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSnapshotId)) {
    return false;
  }
  let response;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      response = await request(origin + '/api/health', {
    method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: {
      'CF-Access-Client-Id': id,
      'CF-Access-Client-Secret': secret,
      Origin: origin,
    },
      });
      if (response.status === 200) break;
    } catch (error) {
      if (attempt === 6) throw error;
    }
    if (attempt < 6) await delay(10000);
  }
  const privateResponse = response.headers.get('cache-control')?.includes('no-store');
  const isJson = /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '');
  let payload = null;
  if (response.status === 200 && privateResponse && isJson) {
    try { payload = JSON.parse(await response.text()); } catch { payload = null; }
  }
  return response.status === 200 && Boolean(privateResponse) && isJson &&
    validateSnapshotMatch(payload, expectedSnapshotId);
}

/** Validate only the stable proposal boundary and return a finite model status.
 * Provider text, notes, response bodies and proposed values never leave memory. */
export function validateChatPayload(value) {
  if (!exactKeys(value, chatKeys) || !exactKeys(value.proposed_intent, intentKeys) ||
      !plain(value.feasibility) || Object.keys(value.feasibility).some((key) => !feasibilityKeys.has(key)) ||
      !['rules', 'ai'].includes(value.source) || !modelStatuses.includes(value.model_status) ||
      value.confidence !== 'high' || !Array.isArray(value.notes) ||
      value.notes.some((note) => typeof note !== 'string') ||
      value.next !== 'POST the proposed_intent to /api/query to execute it.') return null;
  const intent = value.proposed_intent;
  if (intent.metric !== 'goals' || intent.entity_type !== 'player' || intent.entity_id !== 'all' ||
      intent.season !== '2024-25' || intent.competition !== 'PL' || intent.viz !== 'bar' ||
      intent.limit !== 10 || !Array.isArray(intent.dimensions) || intent.dimensions.length !== 0 ||
      !plain(intent.filters) || Object.keys(intent.filters).length !== 0) return null;
  if ((value.source === 'ai') !== (value.model_status === 'accepted')) return null;
  const expectedNotes = ['accepted', 'not_configured'].includes(value.model_status)
    ? [] : [`AI proposal unavailable (${value.model_status}); using rules.`];
  if (value.notes.length !== expectedNotes.length ||
      value.notes.some((note, index) => note !== expectedNotes[index])) return null;
  return value.model_status;
}

/** Validate the deterministic query boundary without returning rows or keys to
 * output. The caller keeps the key in memory only to compare two requests. */
export function validateQueryPayload(value) {
  if (!exactKeys(value, queryKeys) || !exactKeys(value.intent, intentKeys) ||
      !plain(value.feasibility) || Object.keys(value.feasibility).some((key) => !feasibilityKeys.has(key)) ||
      !['available', 'computable_now_queued'].includes(value.feasibility.state) ||
      typeof value.artifact_key !== 'string' || !/^[a-f0-9]{64}$/.test(value.artifact_key) ||
      typeof value.snapshot_id !== 'string' || !/^[a-f0-9]{64}$/.test(value.snapshot_id) ||
      !Array.isArray(value.attribution) || value.attribution.length !== 1 ||
      typeof value.attribution[0] !== 'string' || value.attribution[0].length === 0 ||
      !Array.isArray(value.rows) || value.rows.length === 0 || value.rows.length > 10) return null;
  const intent = value.intent;
  if (intent.metric !== 'goals' || intent.entity_type !== 'player' || intent.entity_id !== 'all' ||
      intent.season !== '2024-25' || intent.competition !== 'PL' || intent.viz !== 'bar' ||
      intent.limit !== 10 || !Array.isArray(intent.dimensions) || intent.dimensions.length !== 0 ||
      !plain(intent.filters) || Object.keys(intent.filters).length !== 0) return null;
  for (const row of value.rows) {
    if (!exactKeys(row, queryRowKeys) || typeof row.label !== 'string' || row.label.length === 0 ||
        (row.value !== null && (typeof row.value !== 'number' || !Number.isFinite(row.value))) ||
        typeof row.secondary !== 'string' || !/^fpl:code:[1-9]\d*$/.test(row.route_key)) return null;
  }
  return { artifactKey: value.artifact_key, state: value.feasibility.state };
}

function validateUnsupportedPayload(value) {
  return exactKeys(value, ['code', 'feasibility', 'proposed_intent', 'reason', 'rejected', 'suggestion']) &&
    value.rejected === true && value.code === 'unsupported_semantics' &&
    typeof value.reason === 'string' && typeof value.suggestion === 'string' &&
    value.proposed_intent === null && value.feasibility === null;
}

export async function smoke(env, request = fetch) {
  const id = env.CF_ACCESS_CLIENT_ID;
  const secret = env.CF_ACCESS_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Missing dev Access service credentials.');
  const headers = { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret, Origin: origin };
  const cases = [
    { path: '/en', marker: 'Ask about Manchester United' },
    { path: '/es', marker: 'Pregunta sobre el Manchester United' },
    { path: '/en/data', marker: 'Data and sources' },
    { path: '/es/data', marker: 'Datos y fuentes' },
    { path: '/en/seasons/explore?schema_version=1&competition=PL&seasons=2014-15&group_by=venue', locale: 'en', seasonExplore: true, canonical: '/en/seasons/explore?schema_version=1&amp;competition=PL&amp;seasons=2014-15&amp;group_by=venue' },
    { path: '/es/seasons/explore?schema_version=1&competition=PL&seasons=2014-15&group_by=venue', locale: 'es', seasonExplore: true, canonical: '/es/seasons/explore?schema_version=1&amp;competition=PL&amp;seasons=2014-15&amp;group_by=venue' },
    { path: '/en/seasons/champions-league', marker: 'Champions League history' },
    { path: '/es/seasons/champions-league', marker: 'Historial de la Liga de Campeones' },
    { path: '/en', marker: 'Try asking' },
    { path: '/es', marker: 'Prueba preguntando' },
    { path: '/en/season/2015-16', markers: ['League season comparison', '49–35 goals', '>1.74</td>'] },
    { path: '/es/season/2015-16', markers: ['Comparación de temporadas de liga', '49–35 goles', '>1,74</td>'] },
    { path: '/en/season/2014-15', markers: ['League season comparison', '62–37 goals', '>1.84</td>'] },
    { path: '/es/season/2014-15', markers: ['Comparación de temporadas de liga', '62–37 goles', '>1,84</td>'] },
    { path: '/en/q?metric=goals&entity_type=player&entity_id=all&season=2024-25&competition=PL&viz=dot_plot&limit=10',
      markers: ['class="dot"', 'aria-current="page">Dots</a>', '<table>'] },
    { path: '/es/q?metric=goals&entity_type=player&entity_id=all&season=2024-25&competition=PL&viz=dot_plot&limit=10',
      markers: ['class="dot"', 'aria-current="page">Gráfico de puntos</a>', '<table>'] },
    { path: '/style.css', marker: 'font-family' },
    { path: '/en/ask', marker: 'Assists — 2023-24 PL', method: 'POST', body: 'q=Top+assists+2023-24' },
    { path: '/api/health', health: true },
    { path: triageContextPath, triageContext: true, method: 'POST',
      body: JSON.stringify({ version: 1, kind: 'context', payload: {} }), contentType: 'application/json' },
    { path: '/api/chat', chat: true, method: 'POST',
      body: JSON.stringify({ question: 'Top goals 2024-25' }), contentType: 'application/json' },
    { path: '/api/chat', unsupported: true, method: 'POST',
      body: JSON.stringify({ question: 'Top goals per 90 2024-25' }), contentType: 'application/json' },
    { path: '/api/query', query: 'first', method: 'POST',
      body: JSON.stringify({ metric: 'goals', entity_type: 'player', entity_id: 'all',
        season: '2024-25', competition: 'PL', dimensions: [], filters: {}, viz: 'bar', limit: 10 }),
      contentType: 'application/json' },
    { path: '/api/query', query: 'repeat', method: 'POST',
      body: JSON.stringify({ metric: 'goals', entity_type: 'player', entity_id: 'all',
        season: '2024-25', competition: 'PL', dimensions: [], filters: {}, viz: 'bar', limit: 10 }),
      contentType: 'application/json' },
  ];
  const results = [];
  let queryIdentity = null;
  let compareIds = null;
  for (const check of cases) {
    try {
    const requestHeaders = { ...headers, ...(check.locale ? { 'Sec-Fetch-Site': 'same-origin' } : {}), ...(check.body ? {
      'Content-Type': check.contentType ?? 'application/x-www-form-urlencoded',
    } : {}) };
    const response = await request(origin + check.path, {
      method: check.method ?? 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: requestHeaders,
      ...(check.body ? { body: check.body } : {}),
    });
    const privateResponse = response.headers.get('cache-control')?.includes('no-store');
    if (check.triageContext) {
      const privateContext = (response.headers.get('cache-control') ?? '').split(',')
        .some((directive) => directive.trim().toLowerCase() === 'no-store');
      const jsonContext = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() === 'application/json';
      let state = null;
      if (response.status === 200 && privateContext && jsonContext) {
        state = validateTriageContextPayload(await readTriageContext(response));
      } else {
        try { await response.body?.cancel(); } catch { /* do not expose body or errors */ }
      }
      results.push({ path: check.path, status: response.status, pass: state === 'ready', triage_state: state ?? 'invalid' });
      continue;
    }
    // Never print response bodies, headers, credentials, exceptions or raw
    // health metadata. Only the finite current/degraded/invalid state may leave.
    const body = await response.text();
    let healthState = null;
    let modelStatus = null;
    let unsupported = false;
    let queryResult = null;
    if (check.health && /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      try { healthState = validateHealthPayload(JSON.parse(body)); } catch { healthState = null; }
    }
    if (check.chat && /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      try { modelStatus = validateChatPayload(JSON.parse(body)); } catch { modelStatus = null; }
    }
    if (check.unsupported && /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      try { unsupported = validateUnsupportedPayload(JSON.parse(body)); } catch { unsupported = false; }
    }
    if (check.query && /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      try { queryResult = validateQueryPayload(JSON.parse(body)); } catch { queryResult = null; }
    }
    const queryPass = check.query === 'first'
      ? queryResult !== null
      : check.query === 'repeat'
        ? queryResult !== null && queryIdentity !== null &&
          queryResult.artifactKey === queryIdentity && queryResult.state === 'available'
        : false;
    if (check.query === 'first' && queryResult) {
      queryIdentity = queryResult.artifactKey;
      try {
        const payload = JSON.parse(body);
        compareIds = [...new Set(payload.rows.map((row) => row.route_key))].slice(0, 2);
      } catch { compareIds = null; }
    }
    const expectedStatus = check.unsupported ? 422 : 200;
    let seasonState = null;
    let seasonAssertion = null;
    if (check.seasonExplore) {
      ({ state: seasonState, assertion: seasonAssertion } = classifySeasonExplore(body, check.locale, check.canonical));
    }
    const contentPass = check.seasonExplore ? seasonAssertion === null
      : check.locale ? body.includes(`lang="${check.locale}"`) &&
      body.includes(`<link rel="canonical" href="${check.canonical}">`)
      : check.health ? healthState !== null
      : check.chat ? modelStatus !== null
      : check.unsupported ? unsupported
      : check.query ? queryPass
      : (check.markers ?? [check.marker]).every((marker) => body.includes(marker));
    const pass = response.status === expectedStatus && Boolean(privateResponse) &&
      (!check.locale || requestHeaders['Sec-Fetch-Site'] === 'same-origin') && contentPass;
    results.push({ path: check.path, status: response.status, pass,
      ...(check.health ? { health_state: pass ? healthState : 'invalid' } : {}),
      ...(check.chat ? { model_status: pass ? modelStatus : 'invalid' } : {}),
      ...(check.unsupported ? { gate_status: pass ? 'unsupported_semantics' : 'invalid' } : {}),
      ...(check.seasonExplore ? { season_state: pass ? seasonState : `assertion_failed:${seasonAssertion ?? 'status_or_access'}` } : {}) });
    if (check.query) results.at(-1).query_state = pass ? queryResult.state : 'invalid';
    } catch (error) {
      results.push({ path: check.path, pass: false, error_class: safeErrorClass(error),
        ...(check.triageContext ? { triage_state: 'invalid' } : {}) });
    }
  }
  for (const locale of ['en', 'es']) {
    if (compareIds?.length !== 2) {
      results.push({ path: `/${locale}/players/compare`, pass: false, error_class: 'PrerequisiteError' });
      continue;
    }
    const params = new URLSearchParams(playerCompareParams);
    for (const id of [...compareIds].sort()) params.append('person_ids', id);
    params.append('seasons', '2024-25');
    const path = `/${locale}/players/compare?${params.toString()}`;
    try {
    const response = await request(origin + path, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { ...headers, 'Sec-Fetch-Site': 'same-origin' },
    });
    const body = await response.text();
    const canonicalParams = new URLSearchParams({ schema_version: '1', competition: 'PL' });
    for (const id of [...compareIds].sort()) canonicalParams.append('person_ids', id);
    canonicalParams.append('seasons', '2024-25');
    canonicalParams.set('metric', 'goals');
    canonicalParams.set('normalization', 'total');
    canonicalParams.set('min_minutes', '0');
    canonicalParams.set('viz', 'table');
    const canonical = `<link rel="canonical" href="/${locale}/players/compare?${canonicalParams.toString().replaceAll('&', '&amp;')}">`;
    const pass = response.status === 200 &&
      response.headers.get('cache-control')?.includes('no-store') &&
      body.includes(locale === 'es' ? 'Comparar jugadores' : 'Compare players') && body.includes(canonical);
    results.push({ path, status: response.status, pass });
    } catch (error) {
      results.push({ path: `/${locale}/players/compare`, pass: false, error_class: safeErrorClass(error) });
    }
  }
  const trendId = compareIds?.[0];
  for (const [locale, marker] of [['en', 'Player trends'], ['es', 'Evolución de jugadores']]) {
    if (!trendId) {
      results.push({ path: `/${locale}/players/trends`, pass: false, error_class: 'PrerequisiteError' });
      continue;
    }
    const params = new URLSearchParams({ schema_version: '1', competition: 'PL',
      person_ids: trendId, seasons: '2024-25' });
    const path = `/${locale}/players/trends?${params.toString()}`;
    try {
      const response = await request(origin + path, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000),
        headers: { ...headers, 'Sec-Fetch-Site': 'same-origin' },
      });
      const body = await response.text();
      const pass = response.status === 200 &&
        response.headers.get('cache-control')?.includes('no-store') && body.includes(marker);
      results.push({ path, status: response.status, pass });
    } catch (error) {
      results.push({ path: `/${locale}/players/trends`, pass: false, error_class: safeErrorClass(error) });
    }
  }
  for (const [locale, marker] of [['en', 'Per-90 leaderboard'], ['es', 'Clasificación por 90 minutos']]) {
    if (!trendId) {
      results.push({ path: `/${locale}/players/trends`, pass: false, error_class: 'PrerequisiteError' });
      continue;
    }
    const params = new URLSearchParams({ schema_version: '1', competition: 'PL',
      person_ids: trendId, seasons: '2024-25', metric: 'goals', normalization: 'per90', viz: 'table' });
    const path = `/${locale}/players/trends?${params.toString()}`;
    try {
      const response = await request(origin + path, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000),
        headers: { ...headers, 'Sec-Fetch-Site': 'same-origin' },
      });
      const body = await response.text();
      const url = new URL(origin + path);
      const queryPass = url.searchParams.get('schema_version') === '1' &&
        url.searchParams.get('competition') === 'PL' && url.searchParams.get('person_ids') === trendId &&
        url.searchParams.get('seasons') === '2024-25' && url.searchParams.get('metric') === 'goals' &&
        url.searchParams.get('normalization') === 'per90' && url.searchParams.get('viz') === 'table' &&
        !url.searchParams.has('min_minutes');
      const pass = response.status === 200 &&
        response.headers.get('cache-control')?.includes('no-store') && queryPass && body.includes(marker);
      results.push({ path, status: response.status, pass });
    } catch (error) {
      results.push({ path: `/${locale}/players/trends`, pass: false, error_class: safeErrorClass(error) });
    }
  }
  for (const locale of ['en', 'es']) {
    const params = new URLSearchParams({ schema_version: '1', competition: 'PL' });
    params.append('seasons', '2024-25');
    params.append('seasons', '2025-26');
    params.set('group_by', 'opponent');
    params.set('opponent_id', 'club:1001');
    const path = `/${locale}/opponents/history?${params.toString()}`;
    try {
      const response = await request(origin + path, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000),
        headers: { ...headers, 'Sec-Fetch-Site': 'same-origin' },
      });
      const body = await response.text();
      const state = classifyOpponentHistory(body, locale, path);
      const pass = response.status === 200 && Boolean(response.headers.get('cache-control')?.includes('no-store')) && state !== 'invalid';
      results.push({ path, status: response.status, pass,
        opponent_state: pass ? state : 'invalid' });
    } catch (error) {
      results.push({ path: `/${locale}/opponents/history`, pass: false, error_class: safeErrorClass(error) });
    }
  }
  return results;
}

const accessChallenge = (response) => {
  if (response.status !== 302) return false;
  try {
    const target = new URL(response.headers.get('location'));
    return target.protocol === 'https:' && target.port === '' && target.username === '' &&
      target.password === '' && target.hostname === accessHost &&
      target.pathname.startsWith('/cdn-cgi/access/login/');
  } catch {
    return false;
  }
};

const denied = (response) => accessChallenge(response);

/** Prove that the known dev hostname is closed to anonymous and trivially
 * forged identity requests. Never follow redirects or consume response bodies,
 * and expose only a finite verdict rather than Access response details. */
export async function denialSmoke(request = fetch, env = {}) {
  const results = [];
  const probe = async (path, details, options) => {
    try {
      const response = await request(origin + path, options);
      return { ...details, path, status: response.status, pass: denied(response) };
    } catch (error) {
      return { ...details, path, pass: false, error_class: safeErrorClass(error) };
    }
  };
  for (const path of denialCases) {
    for (const method of ['GET', 'HEAD']) {
      results.push(await probe(path, { mode: 'anonymous', method }, {
        method, redirect: 'manual', signal: AbortSignal.timeout(15000), headers: {},
      }));
    }
  }
  for (const check of denialPostCases) {
    results.push(await probe(check.path, { mode: 'anonymous', method: 'POST' }, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': check.contentType }, body: check.body,
    }));
  }
  for (const path of ['/en', '/api/health', '/style.css']) {
    results.push(await probe(path, { mode: 'forged-identity', method: 'GET' }, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: {
        'CF-Access-Jwt-Assertion': 'synthetic-invalid-assertion',
        'CF-Access-Authenticated-User-Email': 'nobody@example.invalid',
      },
    }));
  }
  let queryResponse = null;
  try { queryResponse = await request(origin + '/api/query', {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: { 'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
      'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET, Origin: origin,
      'Content-Type': 'application/json' },
    body: JSON.stringify({ metric: 'goals', entity_type: 'player', entity_id: 'all',
      season: '2024-25', competition: 'PL', dimensions: [], filters: {}, viz: 'bar', limit: 10 }),
  }); } catch (error) {
    results.push({ mode: 'discovery', method: 'POST', path: '/api/query', pass: false,
      error_class: safeErrorClass(error) });
  }
  let ids = [];
  if (queryResponse?.status === 200) {
    try { ids = [...new Set(JSON.parse(await queryResponse.text()).rows.map((row) => row.route_key))]
      .filter((id) => /^fpl:code:[1-9]\d*$/.test(id)).slice(0, 2); } catch { ids = []; }
  }
  for (const locale of ['en', 'es']) {
    if (ids.length !== 2) {
      results.push({ mode: 'cross-site', method: 'GET', path: `/${locale}/players/compare`,
        ...(queryResponse ? { status: queryResponse.status } : {}), pass: false });
      continue;
    }
    const params = new URLSearchParams(playerCompareParams);
    for (const id of [...ids].sort()) params.append('person_ids', id);
    params.append('seasons', '2024-25');
    const path = `/${locale}/players/compare?${params.toString()}`;
    const result = await probe(path, { mode: 'cross-site', method: 'GET' }, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { 'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET, Origin: 'https://foreign.invalid', 'Sec-Fetch-Site': 'cross-site' },
    });
    if (result.status !== undefined) result.pass = result.status === 403;
    results.push(result);
  }
  return results;
}

export async function runSmoke(env, request = fetch) {
  return [...await smoke(env, request), ...await denialSmoke(request, env)];
}

// Fixed pilot selections: clarification cases use their confirmed selection.
// No question text, arbitrary intent or caller-supplied URL enters this reader.
const oracleCases = [
  { case_id: 1, season: '2025-26', metric: 'goals' },
  { case_id: 2, season: '2024-25', metric: 'minutes' },
  { case_id: 3, season: '2024-25', metric: 'assists' },
  { case_id: 4, season: '2024-25', metric: 'goals' },
  { case_id: 9, season: '2025-26', metric: 'goals' },
];
// pipeline/sources/run.py:454 derives this stable ID from the FPL person code.
const oraclePersonId = 'fpl:code:141746';
const oracleEscape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/** Optional bounded disclosure; never contributes to smoke assertions or exits. */
export async function oracleSmoke(env, request = fetch) {
  let reason = 'error';
  const contextRecords = [];
  const unresolvedOracle = oracle_reason => [...contextRecords, ...oracleCases.map(({ case_id }) =>
    ({ case_id, oracle_state: 'unresolved', oracle_reason }))];
  try {
    if (!env.CF_ACCESS_CLIENT_ID || !env.CF_ACCESS_CLIENT_SECRET) return unresolvedOracle('credentials');
    const headers = { 'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
      'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET, Origin: origin };
    const read = async (path, context = false) => {
      const response = await request(origin + path, {
        method: context ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000),
        headers: { ...headers, ...(context ? { 'Content-Type': 'application/json' } : {}) },
        ...(context ? { body: JSON.stringify({ version: 1, kind: 'context', payload: {} }) } : {}),
      });
      const privateResponse = (response.headers.get('cache-control') ?? '').split(',')
        .some(part => part.trim().toLowerCase() === 'no-store');
      const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (response.status !== 200 || !privateResponse || mime !== (context ? 'application/json' : 'text/html')) {
        try { await response.body?.cancel(); } catch { /* no diagnostics */ }
        reason = context ? 'context' : 'page_status';
        throw new Error();
      }
      // Reuse the streaming byte cap and fatal UTF-8 decoder for HTML as well.
      const payload = await readTriageContext(response, !context);
      if (payload === null) { reason = context ? 'context' : 'page_shape'; throw new Error(); }
      return payload;
    };
    const before = await read(triageContextPath, true);
    if (validateTriageContextPayload(before) !== 'ready') return unresolvedOracle('context');
    const context = before.payload;
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(context.snapshot_id)) return unresolvedOracle('snapshot_changed');
    contextRecords.push({ oracle_context: { has_more: context.has_more, people: context.people.length } });
    const catalog = JSON.parse(context.catalog_json);
    // Only attribution already present in this reviewed public checkout may leave.
    const local = JSON.parse(readFileSync(new URL('../worker/src/generated/catalog.json', import.meta.url), 'utf8'));
    const rows = [];
    for (const selection of oracleCases) {
      const cells = Array.isArray(catalog.coverage) ? catalog.coverage.filter(cell =>
        cell?.entity_type === 'player' && cell.metric === selection.metric && cell.season === selection.season &&
        cell.competition === 'PL' && cell.granularity === 'box_score') : [];
      const cell = cells[0];
      if (typeof cell?.attribution_text === 'string' && cell.attribution_text.includes('::')) return unresolvedOracle('attribution');
      if (cells.length !== 1 || cell.redistributable !== true || cell.cost_class !== 'cheap' ||
          typeof cell.attribution_text !== 'string' || !cell.attribution_text.trim() ||
          !local.coverage.some(known => known.entity_type === 'player' && known.metric === selection.metric &&
            known.season === selection.season && known.competition === 'PL' && known.granularity === 'box_score' &&
            known.source_id === cell.source_id && known.attribution_text === cell.attribution_text)) return unresolvedOracle('catalog');
      const path = '/en/q?' + new URLSearchParams({ metric: selection.metric, entity_type: 'player',
        entity_id: oraclePersonId, season: selection.season, competition: 'PL', viz: 'table', limit: '1' });
      const body = await read(path);
      const canonical = `<link rel="canonical" href="${oracleEscape(path)}">`;
      const href = `/en/player/${encodeURIComponent(oraclePersonId)}/${selection.season}`;
      const tableRows = [...body.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)];
      const pattern = /^<tr><td class="num">1<\/td><td><a href="([^"<>]*)">([^<>]*)<\/a><\/td><td>[^<>]*<\/td><td class="num">([^<>]*)<\/td><\/tr>$/;
      const row = tableRows.length === 1 ? pattern.exec(tableRows[0][1]) : null;
      // These metrics are integral: rendered EN values are exact, without rounding.
      const numeric = row?.[3];
      const value = typeof numeric === 'string' && /^(?:0|[1-9]\d{0,2}(?:,\d{3})*)$/.test(numeric)
        ? Number(numeric.replaceAll(',', '')) : NaN;
      const footers = [...body.matchAll(/<footer>([\s\S]*?)<\/footer>/g)];
      if (!body.includes('<html lang="en">') || !body.includes(canonical) || !row) return unresolvedOracle('page_shape');
      if (row[1] !== href) return unresolvedOracle('person_mismatch');
      const player = row[2].replace(/&(?:amp|lt|gt|quot|#39);/g, entity =>
        ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[entity]);
      if (!/^\p{L}[\p{L} .'-]{0,63}$/u.test(player) || /[\p{Cc}\p{Cf}]/u.test(player) ||
          oracleEscape(player) !== row[2]) return unresolvedOracle('page_shape');
      if (!Number.isSafeInteger(value)) return unresolvedOracle('value');
      if (footers.length !== 1 || !footers[0][1].includes(`<p>${oracleEscape(cell.attribution_text)}</p>`)) {
        return unresolvedOracle('attribution');
      }
      if (!footers[0][1].includes(`<p>Data snapshot ${oracleEscape(context.snapshot_id.slice(0, 12))} — every figure on this page can be regenerated from it.</p>`)) {
        return unresolvedOracle('snapshot_changed');
      }
      rows.push({ case_id: selection.case_id, snapshot_id: context.snapshot_id, person_id: oraclePersonId,
        player, season: selection.season, competition: 'PL', metric: selection.metric, value,
        attribution: cell.attribution_text });
    }
    const after = await read(triageContextPath, true);
    if (validateTriageContextPayload(after) !== 'ready') return unresolvedOracle('context');
    if (after.payload.snapshot_id !== context.snapshot_id ||
        after.payload.catalog_digest !== context.catalog_digest ||
        JSON.stringify(after.payload.people) !== JSON.stringify(context.people) || after.payload.has_more !== context.has_more ||
        JSON.stringify({ ...rows[0], case_id: 9 }) !== JSON.stringify(rows[4])) return unresolvedOracle('snapshot_changed');
    return [...contextRecords, ...rows];
  } catch { return unresolvedOracle(reason); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'snapshot') {
    try {
      const matched = await snapshotContinuitySmoke(process.env);
      console.log(`snapshot_match=${matched}`);
      if (!matched) process.exitCode = 1;
    } catch {
      console.error('snapshot_match=false');
      process.exitCode = 1;
    }
  } else {
    try {
      const results = await runSmoke(process.env);
      console.log(JSON.stringify(results));
      if (results.some((result) => !result.pass)) process.exitCode = 1;
      for (const row of await oracleSmoke(process.env)) console.log(JSON.stringify(row));
    } catch (error) {
      console.error(`Dev Access smoke failed; error_class=${safeErrorClass(error)}`);
      process.exitCode = 1;
    }
  }
}
