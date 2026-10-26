import { pathToFileURL } from 'node:url';

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
      results.push({ path: check.path, pass: false, error_class: safeErrorClass(error) });
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
  for (const locale of ['en', 'es']) {
    const params = new URLSearchParams({ schema_version: '1', competition: 'PL' });
    params.append('seasons', '2024-25');
    params.append('seasons', '2025-26');
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
    } catch (error) {
      console.error(`Dev Access smoke failed; error_class=${safeErrorClass(error)}`);
      process.exitCode = 1;
    }
  }
}
