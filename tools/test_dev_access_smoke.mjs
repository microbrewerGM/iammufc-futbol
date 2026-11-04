import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { denialSmoke, runSmoke, smoke, validateChatPayload,
  snapshotContinuitySmoke, validateHealthPayload, validateQueryPayload,
  validateSnapshotMatch, validateTriageContextPayload, classifySeasonExplore, classifyOpponentHistory } from './dev-access-smoke.mjs';

const env = { CF_ACCESS_CLIENT_ID: 'synthetic-id', CF_ACCESS_CLIENT_SECRET: 'synthetic-secret' };
const snapshot = 'a'.repeat(64);
const expectedSnapshot = 'b'.repeat(64);
const contextPath = '/internal/question-triage-bridge/answer-now/context';
const catalogJson = JSON.stringify({ fixture: 'PRIVATE_CATALOG_Mañana' });
const catalogDigest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const validContext = {
  version: 1, kind: 'answer_now_context', payload: {
    triage_protocol: 2, glossary_protocol: 1, catalog_json: catalogJson,
    snapshot_id: 'PRIVATE_SNAPSHOT:fixture-1', catalog_digest: catalogDigest(catalogJson),
    people: [{ id: 'fpl:code:1', label: 'Fixture <Mañana>' }], has_more: false,
  },
};
const retrieved = '2026-09-23T12:00:00.000Z';
const observed = (id, coverage = '2025-26') => ({
  id, status: 'observed', coverage_through: coverage, source_as_of: null, retrieved_at: retrieved,
});
const validHealth = {
  ok: true,
  data_state: 'current',
  snapshot_id: snapshot,
  snapshot_prepared_at: retrieved,
  last_successful_refresh_at: '2026-09-23T12:00:01.000Z',
  coverage_through: '2025-26',
  sources: [observed('fpl'), observed('football_data_couk'), observed('openfootball_cl', '2023-24')],
  metrics: 5,
  coverage_cells: 25,
  ai_bound: false,
};
const validChat = {
  proposed_intent: { metric: 'goals', entity_type: 'player', entity_id: 'all',
    season: '2024-25', competition: 'PL', dimensions: [], filters: {}, viz: 'bar', limit: 10 },
  source: 'ai', model_status: 'accepted', confidence: 'high', notes: [],
  feasibility: { state: 'available' },
  next: 'POST the proposed_intent to /api/query to execute it.',
};
const unsupported = { rejected: true, code: 'unsupported_semantics', reason: 'private',
  suggestion: 'private', proposed_intent: null, feasibility: null };
const validQuery = (state = 'available') => ({
  artifact_key: 'b'.repeat(64), snapshot_id: snapshot,
  intent: validChat.proposed_intent,
  feasibility: { state },
  rows: [
    { label: 'Player', value: 9, secondary: 'FW', route_key: 'fpl:code:1' },
    { label: 'Player Two', value: 8, secondary: 'MF', route_key: 'fpl:code:2' },
  ],
  attribution: ['Source'],
});
const opponentPage = (locale, path, published = false) => {
  const title = locale === 'es' ? 'Historial contra rivales' : 'Opponent history';
  const message = locale === 'es' ? 'La capacidad de desgloses por temporada no está publicada.' : 'Season splits capability is not published.';
  const canonical = published ? path : `/${locale}/opponents/history`;
  return `<!doctype html><html lang="${locale}"><head><link rel="canonical" href="${canonical.replaceAll('&', '&amp;')}"></head><body>${published ? `<table><caption>${title}</caption></table>` : `<h1>${title}</h1><p>${message}</p>`}</body></html>`;
};

const opponentCanonical = (locale, { seasons = ['2024-25', '2025-26'], opponent = 'club:1001' } = {}) => {
  const params = new URLSearchParams({ schema_version: '1', competition: 'PL' });
  for (const season of seasons) params.append('seasons', season);
  params.set('group_by', 'opponent');
  params.set('opponent_id', opponent);
  return `/${locale}/opponents/history?${params.toString()}`;
};

test('opponent classification requires localized canonical and a positive state in both languages', () => {
  for (const locale of ['en', 'es']) {
    const path = opponentCanonical(locale);
    const title = locale === 'es' ? 'Historial contra rivales' : 'Opponent history';
    for (const published of [false, true]) {
      const body = opponentPage(locale, path, published);
      assert.equal(classifyOpponentHistory(body, locale, path), published ? 'published' : 'capability_unavailable');
      for (const invalid of [
        body.replace(`lang="${locale}"`, 'lang="xx"'),
        body.replace(`lang="${locale}"`, ''),
        body.replace('rel="canonical"', 'rel="alternate"'),
        body.replace(`href="/${locale}/opponents/history`, `href="/${locale}/ask`),
        body.replace(published ? `<caption>${title}</caption>` : `<h1>${title}</h1>`, `<a>${title}</a>`),
      ]) assert.equal(classifyOpponentHistory(invalid, locale, path), 'invalid');
    }
    assert.equal(classifyOpponentHistory(`<html lang="${locale}"><link rel="canonical" href="${path.replaceAll('&', '&amp;')}"><nav>${title}</nav></html>`, locale, path), 'invalid');
    const rendered = opponentPage(locale, path, true);
    assert.equal(classifyOpponentHistory(rendered, locale, path), 'published');
    assert.equal(classifyOpponentHistory(rendered.replace('opponent_id=club%3A1001', ''), locale, path), 'invalid');
    assert.equal(classifyOpponentHistory(rendered.replace('seasons=2025-26&amp;', ''), locale, path), 'invalid');
    assert.equal(classifyOpponentHistory(opponentPage(locale, path), locale, path), 'capability_unavailable');
  }
});

test('opponent smoke rejects nav-only, missing shell and incorrect selected canonical', async () => {
  for (const mutate of [
    body => body.replace(/<caption>[^<]+<\/caption>/, '<nav>Opponent history Historial contra rivales</nav>'),
    body => body.replace(/lang="[a-z]+"/, 'lang="xx"'),
    body => body.replace('rel="canonical"', 'rel="alternate"'),
    body => body.replace('seasons=2024-25', 'seasons=1900-01'),
  ]) {
    const results = await smoke(env, async url => {
      const parsed = new URL(url);
      return new Response(mutate(opponentPage(parsed.pathname.startsWith('/es/') ? 'es' : 'en', parsed.pathname + parsed.search, true)),
        { headers: { 'cache-control': 'private, no-store' } });
    });
    const opponents = results.filter(row => row.path.includes('/opponents/history'));
    assert.equal(opponents.length, 2);
    assert.ok(opponents.every(row => row.pass === false && row.opponent_state === 'invalid'));
  }
});

test('season explore accepts each localized rendered state and requires canonical link', () => {
  const markers = {
    en: [
      ['result_table', 'Season performance'],
      ['season_absent', '2014-15: Missing split coverage'],
      ['capability_unavailable', 'Season splits capability is not published.'],
    ],
    es: [
      ['result_table', 'Rendimiento por temporada'],
      ['season_absent', '2014-15: Sin cobertura de desgloses'],
      ['capability_unavailable', 'La capacidad de desgloses por temporada no está publicada.'],
    ],
  };
  for (const [locale, states] of Object.entries(markers)) {
    const canonical = `/${locale}/seasons/explore?schema_version=1&amp;competition=PL&amp;seasons=2014-15&amp;group_by=venue`;
    for (const [state, marker] of states) {
      const body = `<html lang="${locale}"><link rel="canonical" href="${canonical}">${marker}</html>`;
      assert.deepEqual(classifySeasonExplore(body, locale, canonical), { state, assertion: null });
      assert.equal(classifySeasonExplore(body.replace(canonical, 'missing'), locale, canonical).assertion, 'canonical');
    }
  }
  assert.deepEqual(classifySeasonExplore('<html lang="en">unexpected</html>', 'en', 'canonical'),
    { state: null, assertion: 'canonical' });
});

test('fixed dev origin, manual redirects, private response and all checks', async () => {
  const calls = [];
  let queryCalls = 0;
  const results = await smoke(env, async (url, init) => {
    calls.push({ url, init });
    assert.equal(new URL(url).origin, 'https://iammufc-dev.aaron-cf2.workers.dev');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Origin, new URL(url).origin);
    assert.equal(init.headers['CF-Access-Client-Secret'], env.CF_ACCESS_CLIENT_SECRET);
    const pathname = new URL(url).pathname;
    const path = pathname;
    const health = path === '/api/health';
    const chat = path === '/api/chat';
    const query = path === '/api/query';
    const rejected = chat && init.body.includes('per 90');
    if (path === contextPath) return new Response(JSON.stringify(validContext), { headers: {
      'cache-control': 'private, no-store', 'content-type': 'application/json; charset=UTF-8',
    } });
    if (new URL(url).pathname.includes('/players/compare')) {
      const locale = new URL(url).pathname.startsWith('/es/') ? 'es' : 'en';
      const params = new URL(url).searchParams;
      const canonicalParams = new URLSearchParams({ schema_version: '1', competition: 'PL' });
      for (const id of params.getAll('person_ids')) canonicalParams.append('person_ids', id);
      canonicalParams.append('seasons', '2024-25');
      canonicalParams.set('metric', 'goals');
      canonicalParams.set('normalization', 'total');
      canonicalParams.set('min_minutes', '0');
      canonicalParams.set('viz', 'table');
      const marker = locale === 'es' ? 'Comparar jugadores' : 'Compare players';
      return new Response(`${marker}<link rel="canonical" href="/${locale}/players/compare?${canonicalParams.toString().replaceAll('&', '&amp;')}">`,
        { status: 200, headers: { 'cache-control': 'private, no-store' } });
    }
    const trend = path.includes('/players/trends');
    const locale = path.startsWith('/es/') ? 'es' : 'en';
    return new Response(health
      ? JSON.stringify(validHealth)
      : chat ? JSON.stringify(rejected ? unsupported : validChat)
      : query ? JSON.stringify({ ...validQuery(queryCalls++ === 0 ? 'computable_now_queued' : 'available'),
        rows: [...validQuery().rows].reverse() })
      : ['/en/seasons/explore', '/es/seasons/explore'].includes(pathname) ? `<html lang="${pathname.startsWith('/es/') ? 'es' : 'en'}"><link rel="canonical" href="${pathname}?schema_version=1&amp;competition=PL&amp;seasons=2014-15&amp;group_by=venue">${pathname.startsWith('/es/') ? 'La capacidad de desgloses por temporada no está publicada.' : 'Season splits capability is not published.'}</html>`
      : trend ? (new URL(url).searchParams.get('normalization') === 'per90'
        ? (locale === 'es' ? 'Clasificación por 90 minutos' : 'Per-90 leaderboard')
        : (locale === 'es' ? 'Evolución de jugadores' : 'Player trends'))
      : ['/en/opponents/history', '/es/opponents/history'].includes(pathname) ? opponentPage(locale, pathname)
      : ['/en/seasons/champions-league', '/es/seasons/champions-league'].includes(pathname) ? (locale === 'es' ? 'Historial de la Liga de Campeones' : 'Champions League history')
      : path === '/en' || path === '/es' ? (url.includes('/es') ? 'Pregunta sobre el Manchester United Prueba preguntando' : 'Ask about Manchester United Try asking')
      : 'Ask about Manchester United Pregunta sobre el Manchester United Data and sources Datos y fuentes League season comparison Comparación de temporadas de liga 62–37 goals 62–37 goles >1.84</td> >1,84</td> 49–35 goals 49–35 goles >1.74</td> >1,74</td> font-family Assists — 2023-24 PL class="dot" aria-current="page">Dots</a> aria-current="page">Gráfico de puntos</a> <table>',
    { status: rejected ? 422 : 200, headers: { 'cache-control': 'private, no-store',
      ...((health || chat || query) ? { 'content-type': 'application/json; charset=UTF-8' } : {}),
      ...(['/en/opponents/history', '/es/opponents/history'].includes(pathname) ? { 'cache-control': 'private, no-store' } : {}) } });
  });
  assert.equal(calls.length, 32);
  const contextCalls = calls.filter(({ url }) => new URL(url).pathname === contextPath);
  assert.equal(contextCalls.length, 1);
  assert.equal(contextCalls[0].init.method, 'POST');
  assert.equal(contextCalls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(contextCalls[0].init.body), { version: 1, kind: 'context', payload: {} });
  assert.ok(contextCalls[0].init.signal instanceof AbortSignal);
  assert.equal(contextCalls[0].init.signal.aborted, false);
  assert.equal(calls.some(({ url }) => /\/(?:read|claim|ack)$/.test(new URL(url).pathname)), false);
  assert.deepEqual(results.find(row => row.path === contextPath), {
    path: contextPath, status: 200, pass: true, triage_state: 'ready',
  });
  for (const locale of ['en', 'es']) {
    const call = calls.find(({ url }) => new URL(url).pathname === `/${locale}/opponents/history`);
    const url = new URL(call.url);
    assert.equal(call.init.method, 'GET');
    assert.deepEqual([...url.searchParams.entries()], [
      ['schema_version', '1'], ['competition', 'PL'], ['seasons', '2024-25'],
      ['seasons', '2025-26'], ['group_by', 'opponent'], ['opponent_id', 'club:1001'],
    ]);
    const canonicalParams = new URLSearchParams({ schema_version: '1', competition: 'PL' });
    canonicalParams.append('seasons', '2024-25');
    canonicalParams.append('seasons', '2025-26');
    canonicalParams.set('group_by', 'opponent');
    canonicalParams.set('opponent_id', 'club:1001');
    assert.equal(call.url, `https://iammufc-dev.aaron-cf2.workers.dev/${locale}/opponents/history?${canonicalParams}`);
    assert.equal(new Headers(call.init.headers).has('CF-Access-Client-Id'), true);
    const row = results.find((result) => result.path === `${url.pathname}${url.search}`);
    assert.equal(row.pass, true);
    assert.equal(row.opponent_state, 'capability_unavailable');
  }
  assert.equal(calls.find((call) => new URL(call.url).pathname === '/en/ask').init.method, 'POST');
  assert.equal(calls.find((call) => new URL(call.url).pathname === '/api/health').init.method, 'GET');
  for (const locale of ['en', 'es']) {
    const call = calls.find(({ url }) => new URL(url).pathname === `/${locale}/seasons/explore`);
    const url = new URL(call.url);
    assert.deepEqual([...url.searchParams.entries()], [
      ['schema_version', '1'], ['competition', 'PL'], ['seasons', '2014-15'], ['group_by', 'venue'],
    ]);
    assert.equal(call.init.headers.Origin, url.origin);
    assert.equal(call.init.headers['Sec-Fetch-Site'], 'same-origin');
  }
  for (const [locale, marker] of [['en', 'Player trends'], ['es', 'Evolución de jugadores']]) {
    const call = calls.find(({ url }) => new URL(url).pathname === `/${locale}/players/trends`);
    assert.ok(call);
    const url = new URL(call.url);
    assert.equal(url.searchParams.get('schema_version'), '1');
    assert.equal(url.searchParams.get('competition'), 'PL');
    assert.equal(url.searchParams.get('person_ids'), 'fpl:code:2');
    assert.equal(url.searchParams.get('seasons'), '2024-25');
    assert.equal(call.init.headers['Sec-Fetch-Site'], 'same-origin');
    assert.ok(results.some((result) => result.path === `${url.pathname}${url.search}` && result.pass));
    assert.ok(marker === (locale === 'es' ? 'Evolución de jugadores' : 'Player trends'));
  }
  for (const [locale, marker] of [['en', 'Per-90 leaderboard'], ['es', 'Clasificación por 90 minutos']]) {
    const call = calls.find(({ url }) => new URL(url).pathname === `/${locale}/players/trends` && new URL(url).searchParams.get('normalization') === 'per90');
    assert.ok(call);
    const url = new URL(call.url);
    assert.deepEqual([...url.searchParams.entries()], [
      ['schema_version', '1'], ['competition', 'PL'], ['person_ids', 'fpl:code:2'],
      ['seasons', '2024-25'], ['metric', 'goals'], ['normalization', 'per90'], ['viz', 'table'],
    ]);
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.headers['Sec-Fetch-Site'], 'same-origin');
    assert.ok(results.some((result) => result.path === `${url.pathname}${url.search}` && result.pass));
    assert.ok(marker === (locale === 'es' ? 'Clasificación por 90 minutos' : 'Per-90 leaderboard'));
  }
  assert.ok(results.every((result) => result.pass), JSON.stringify(results.filter((result) => !result.pass)));
  assert.deepEqual(results.find((result) => result.path === '/api/chat' && result.status === 200), { path: '/api/chat', status: 200, pass: true,
    model_status: 'accepted' });
  assert.deepEqual(results.find((result) => result.path === '/api/chat' && result.status === 422), { path: '/api/chat', status: 422, pass: true,
    gate_status: 'unsupported_semantics' });
  assert.deepEqual(results.filter((result) => result.path === '/api/query')[0], { path: '/api/query', status: 200, pass: true,
    query_state: 'computable_now_queued' });
  assert.deepEqual(results.filter((result) => result.path === '/api/query')[1], { path: '/api/query', status: 200, pass: true,
    query_state: 'available' });
  for (const locale of ['en', 'es']) {
    const call = calls.find(({ url }) => new URL(url).pathname === `/${locale}/players/compare`);
    assert.ok(call);
    assert.equal(call.init.headers['Sec-Fetch-Site'], 'same-origin');
    const result = results.find(({ path }) => path.startsWith(`/${locale}/players/compare`));
    assert.deepEqual(result, { path: call && new URL(call.url).pathname + new URL(call.url).search,
      status: 200, pass: true });
  }
  assert.ok(!JSON.stringify(results).includes('synthetic'));
  assert.ok(!JSON.stringify(results).includes(snapshot));
  assert.ok(!JSON.stringify(results).includes(retrieved));
});

test('query validator binds finite result shape and hides identity from output', () => {
  assert.deepEqual(validateQueryPayload(validQuery()), {
    artifactKey: 'b'.repeat(64), state: 'available',
  });
  assert.equal(validateQueryPayload({ ...validQuery(), artifact_key: 'bad' }), null);
  assert.equal(validateQueryPayload({ ...validQuery(), rows: [{ ...validQuery().rows[0], extra: true }] }), null);
  assert.equal(validateQueryPayload({ ...validQuery(), intent: { ...validChat.proposed_intent, season: '2023-24' } }), null);
  assert.equal(validateQueryPayload({ ...validQuery(), feasibility: { state: 'no_rights' } }), null);
});

test('chat validator accepts finite model outcomes and rejects drift', () => {
  assert.equal(validateChatPayload(validChat), 'accepted');
  assert.equal(validateChatPayload({ ...validChat, source: 'rules',
    model_status: 'provider_error',
    notes: ['AI proposal unavailable (provider_error); using rules.'] }), 'provider_error');
  assert.equal(validateChatPayload({ ...validChat, model_status: 'private-provider-text' }), null);
  assert.equal(validateChatPayload({ ...validChat, source: 'rules', model_status: 'disabled',
    notes: ['AI proposal unavailable (disabled); using rules.'] }), 'disabled');
  assert.equal(validateChatPayload({ ...validChat, provider_exception: 'private' }), null);
  assert.equal(validateChatPayload({ ...validChat, notes: ['private-provider-text'] }), null);
  assert.equal(validateChatPayload({ ...validChat,
    proposed_intent: { ...validChat.proposed_intent, competition: 'CL' } }), null);
  assert.equal(validateChatPayload({ ...validChat,
    proposed_intent: { ...validChat.proposed_intent, dimensions: ['position'] } }), null);
  assert.equal(validateChatPayload({ ...validChat,
    proposed_intent: { ...validChat.proposed_intent, filters: { position: 'GK' } } }), null);
  assert.equal(validateChatPayload({ ...validChat,
    proposed_intent: { ...validChat.proposed_intent, raw_response: 'private' } }), null);
  assert.equal(validateChatPayload({ ...validChat, source: 'rules', model_status: 'accepted' }), null);
  assert.equal(validateChatPayload({ ...validChat, source: 'rules', model_status: 'provider_error',
    notes: ['AI proposal unavailable (provider_error); using rules.'] }), 'provider_error');
});
test('opponent history vector fails on 5xx even with the unpublished text', async () => {
  const results = await smoke(env, async (url) => new Response(
    new URL(url).pathname.includes('/opponents/history') ? 'Opponent history Season splits capability is not published.' : 'x',
    { status: new URL(url).pathname.includes('/opponents/history') ? 503 : 200, headers: { 'cache-control': 'private, no-store' } }));
  const opp = results.filter((result) => result.path.includes('/opponents/history'));
  assert.equal(opp.length, 2);
  assert.ok(opp.every((result) => result.status === 503 && result.pass === false && result.opponent_state === 'invalid'));
});
test('login redirects and non-private responses fail without following redirects', async () => {
  const results = await smoke(env, async () => new Response('', { status: 302,
    headers: { location: 'https://external.invalid' } }));
  assert.ok(results.every((result) => !result.pass));
  const publicResults = await smoke(env, async () => new Response('Assists'));
  assert.ok(publicResults.every((result) => !result.pass));
});
test('missing credentials never makes a request', async () => {
  await assert.rejects(smoke({}, () => { throw new Error('must not request'); }), /Missing dev/);
});
test('successful HTTP with wrong content does not pass', async () => {
  const results = await smoke(env, async () => new Response('Login required', {
    headers: { 'cache-control': 'private, no-store' },
  }));
  assert.ok(results.every((result) => !result.pass));
});

test('health validator accepts only consistent current or degraded states', () => {
  assert.equal(validateHealthPayload(validHealth), 'current');
  const degraded = {
    ...validHealth,
    data_state: 'degraded',
    sources: validHealth.sources.map((source) => source.id === 'openfootball_cl'
      ? { id: source.id, status: 'unavailable', coverage_through: null, source_as_of: null, retrieved_at: null }
      : source),
  };
  assert.equal(validateHealthPayload(degraded), 'degraded');
  assert.equal(validateHealthPayload({ ...degraded, data_state: 'current' }), null);
  assert.equal(validateHealthPayload({ ...validHealth, data_state: 'degraded' }), null);
});

test('health validator rejects extra, missing, duplicate and malformed data', () => {
  assert.equal(validateHealthPayload({ ...validHealth, extra: true }), null);
  const { metrics: _metrics, ...missing } = validHealth;
  assert.equal(validateHealthPayload(missing), null);
  assert.equal(validateHealthPayload({ ...validHealth, snapshot_id: 'bad' }), null);
  assert.equal(validateHealthPayload({ ...validHealth, metrics: 1.5 }), null);
  assert.equal(validateHealthPayload({ ...validHealth, ai_bound: 'false' }), null);
  assert.equal(validateHealthPayload({ ...validHealth,
    sources: [validHealth.sources[0], validHealth.sources[0], validHealth.sources[2]] }), null);
  assert.equal(validateHealthPayload({ ...validHealth,
    sources: validHealth.sources.map((source, index) => index === 0 ? { ...source, extra: true } : source) }), null);
  assert.equal(validateHealthPayload({ ...validHealth,
    sources: validHealth.sources.map((source, index) => index === 0 ? { ...source, id: 'unknown' } : source) }), null);
  assert.equal(validateHealthPayload({ ...validHealth,
    snapshot_prepared_at: '2026-09-23T13:00:00.000Z' }), null);
  assert.equal(validateHealthPayload(null), null);
  assert.equal(validateHealthPayload([]), null);
});

test('snapshot continuity check compares the protected health ID without returning it', async () => {
  const requests = [];
  const result = await snapshotContinuitySmoke({ ...env, EXPECTED_PRIVATE_SNAPSHOT_ID: snapshot },
    async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify(validHealth), { status: 200, headers: {
        'cache-control': 'private, no-store', 'content-type': 'application/json; charset=UTF-8',
      } });
    });
  assert.equal(result, true);
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).pathname, '/api/health');
  assert.equal(requests[0].init.redirect, 'manual');
  assert.equal(requests[0].init.headers['CF-Access-Client-Id'], env.CF_ACCESS_CLIENT_ID);
  assert.equal(validateSnapshotMatch(validHealth, snapshot), true);
  assert.equal(validateSnapshotMatch(validHealth, expectedSnapshot), false);
  assert.equal(JSON.stringify(result).includes(snapshot), false);
});

test('snapshot continuity retries unsuccessful HTTP statuses before failing', async () => {
  let calls = 0;
  const delays = [];
  const result = await snapshotContinuitySmoke({ ...env, EXPECTED_PRIVATE_SNAPSHOT_ID: snapshot },
    async () => {
      calls++;
      return calls === 1
        ? new Response('', { status: 429 })
        : new Response(JSON.stringify(validHealth), { status: 200, headers: {
          'cache-control': 'private, no-store', 'content-type': 'application/json',
        } });
    }, async (ms) => delays.push(ms));
  assert.equal(result, true);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [10000]);
});

test('snapshot continuity rejects mismatches, malformed payloads and unsafe responses', async () => {
  const expected = { ...env, EXPECTED_PRIVATE_SNAPSHOT_ID: expectedSnapshot };
  const response = (body, init = {}) => new Response(body, { status: 200, headers: {
    'cache-control': 'private, no-store', 'content-type': 'application/json', ...init.headers,
  } });
  const cases = [
    response(JSON.stringify(validHealth)),
    response('{malformed'),
    response(JSON.stringify(validHealth), { headers: { 'cache-control': 'public' } }),
    response(JSON.stringify(validHealth), { headers: { 'content-type': 'text/html' } }),
    new Response(JSON.stringify(validHealth), { status: 302, headers: {
      'cache-control': 'private, no-store', 'content-type': 'application/json',
    } }),
  ];
  for (const mockedResponse of cases) {
    assert.equal(await snapshotContinuitySmoke(expected, async () => mockedResponse, async () => {}), false);
  }
  assert.equal(await snapshotContinuitySmoke({ ...env, EXPECTED_PRIVATE_SNAPSHOT_ID: 'bad' },
    () => { throw new Error('invalid expectation must not issue a request'); }), false);
  await assert.rejects(snapshotContinuitySmoke({}, () => { throw new Error('must not request'); }), /Missing dev/);
});

test('health response requires JSON content type and never emits raw metadata', async () => {
  const results = await smoke(env, async (url) => {
    const health = new URL(url).pathname === '/api/health';
    return new Response(health ? JSON.stringify(validHealth) :
      'Ask about Manchester United Pregunta sobre el Manchester United Data and sources Datos y fuentes League season comparison Comparación de temporadas de liga 62–37 goals 62–37 goles >1.84</td> >1,84</td> 49–35 goals 49–35 goles >1.74</td> >1,74</td> font-family Assists — 2023-24 PL class="dot" aria-current="page">Dots</a> aria-current="page">Gráfico de puntos</a> <table>',
    { headers: { 'cache-control': 'private, no-store' } });
  });
  const health = results.find((result) => result.path === '/api/health');
  assert.deepEqual(health, { path: '/api/health', status: 200, pass: false, health_state: 'invalid' });
  assert.ok(!JSON.stringify(results).includes(snapshot));
});

test('malformed JSON and misleading JSON content type fail without leaking details', async () => {
  for (const [body, contentType] of [['{private-body', 'application/json'],
    [JSON.stringify(validHealth), 'application/json-evil']]) {
    const results = await smoke(env, async (url) => {
      const health = new URL(url).pathname === '/api/health';
      return new Response(health ? body :
        'Ask about Manchester United Pregunta sobre el Manchester United Data and sources Datos y fuentes League season comparison Comparación de temporadas de liga 62–37 goals 62–37 goles >1.84</td> >1,84</td> 49–35 goals 49–35 goles >1.74</td> >1,74</td> font-family Assists — 2023-24 PL',
      { headers: { 'cache-control': 'private, no-store',
        ...(health ? { 'content-type': contentType } : {}) } });
    });
    assert.deepEqual(results.find((result) => result.path === '/api/health'),
      { path: '/api/health', status: 200, pass: false, health_state: 'invalid' });
    assert.ok(!JSON.stringify(results).includes('private-body'));
  }
});

const accessRedirect = () => new Response('', { status: 302, headers: {
  location: 'https://odd-fog-375d.cloudflareaccess.com/cdn-cgi/access/login/iammufc-dev?private=value',
} });

test('anonymous and forged probes are fixed-origin, credential-free and do not follow redirects', async () => {
  const calls = [];
  const results = await denialSmoke(async (url, init) => {
    calls.push({ url, init });
    assert.equal(new URL(url).origin, 'https://iammufc-dev.aaron-cf2.workers.dev');
    assert.equal(init.redirect, 'manual');
    const headers = new Headers(init.headers);
    const crossSite = headers.get('Sec-Fetch-Site') === 'cross-site';
    const expectedServiceAuth = crossSite || (new URL(url).pathname === '/api/query' &&
      typeof init.body === 'string' && init.body.includes('"entity_id":"all"'));
    assert.equal(headers.has('CF-Access-Client-Id'), expectedServiceAuth);
    assert.equal(headers.has('CF-Access-Client-Secret'), expectedServiceAuth);
    assert.equal(headers.has('Cookie'), false);
    assert.equal(headers.has('Authorization'), false);
    if (new URL(url).pathname === '/api/query' && typeof init.body === 'string' &&
        init.body.includes('"entity_id":"all"')) return new Response(JSON.stringify(validQuery()), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    if (new URL(url).pathname.includes('/players/compare')) {
    return new Response('', { status: 403 });
    }
    return accessRedirect();
  }, env);
  assert.equal(calls.length, 62);
  assert.equal(calls.filter(({ init }) => init.method === 'HEAD').length, 26);
  const postCalls = calls.filter(({ init }) => init.method === 'POST');
  assert.deepEqual(postCalls.map(({ url }) => new URL(url).pathname), [
    '/en/ask', '/es/ask', '/api/chat', '/api/query', '/api/query',
  ]);
  assert.ok(postCalls.every(({ init }) => typeof init.body === 'string'));
  for (const locale of ['en', 'es']) {
    const call = calls.find(({ url, init }) => new URL(url).pathname === `/${locale}/players/compare` &&
      new Headers(init.headers).get('Sec-Fetch-Site') === 'cross-site');
    assert.ok(call);
    assert.equal(new Headers(call.init.headers).get('Origin'), 'https://foreign.invalid');
    assert.equal(new Headers(call.init.headers).get('CF-Access-Client-Id'), env.CF_ACCESS_CLIENT_ID);
    assert.equal(new Headers(call.init.headers).get('CF-Access-Client-Secret'), env.CF_ACCESS_CLIENT_SECRET);
  }
  assert.equal(calls.filter(({ init }) => new Headers(init.headers).has('CF-Access-Jwt-Assertion')).length, 3);
  assert.ok(calls.filter(({ init }) => new Headers(init.headers).get('Sec-Fetch-Site') === 'cross-site')
    .every(({ init }) => new Headers(init.headers).has('CF-Access-Client-Secret')));
  assert.ok(results.every((result) => result.pass), JSON.stringify(results.filter((result) => !result.pass)));
  assert.ok(!JSON.stringify(results).includes('private=value'));
  assert.ok(!JSON.stringify(results).includes('synthetic-invalid-assertion'));
  assert.ok(!JSON.stringify(results).includes('Top+assists'));
  assert.ok(!JSON.stringify(results).includes('Top goals 2024-25'));
});

test('only the exact trusted Access challenge passes negative probes', async () => {
  for (const response of [
    new Response('', { status: 200 }),
    new Response('', { status: 404 }),
    new Response('', { status: 429 }),
    new Response('', { status: 503 }),
    new Response('', { status: 302, headers: { location: 'https://example.invalid/login' } }),
    new Response('', { status: 302, headers: {
      location: 'https://wrong-team.cloudflareaccess.com/cdn-cgi/access/login/app',
    } }),
    new Response('', { status: 302, headers: {
      location: 'https://cloudflareaccess.com.example.invalid/cdn-cgi/access/login/app',
    } }),
    new Response('', { status: 302, headers: {
      location: 'http://odd-fog-375d.cloudflareaccess.com/cdn-cgi/access/login/app',
    } }),
    new Response('', { status: 302, headers: {
      location: 'https://odd-fog-375d.cloudflareaccess.com/not-access',
    } }),
  ]) {
    const results = await denialSmoke(async () => response.clone(), env);
    assert.ok(results.every((result) => !result.pass));
  }
});

test('cross-site probes fail visibly when query discovers fewer than two valid IDs', async () => {
  for (const row of [
    { ...validQuery().rows[0], route_key: 'not-a-valid-id' },
    { ...validQuery().rows[0], route_key: 'fpl:code:1' },
  ]) {
    const results = await denialSmoke(async (url) => {
      if (new URL(url).pathname === '/api/query') return new Response(JSON.stringify({
        ...validQuery(), rows: [row],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
      return accessRedirect();
    }, env);
    const crossSiteResults = results.filter((result) => result.mode === 'cross-site');
    assert.deepEqual(crossSiteResults.map(({ path, pass }) => ({ path, pass })), [
      { path: '/en/players/compare', pass: false },
      { path: '/es/players/compare', pass: false },
    ]);
    assert.ok(results.some((result) => result.path === '/api/query' && result.pass === undefined) === false);
  }
});

test('combined smoke requires authenticated success and denial success', async () => {
  let queryCalls = 0;
  const results = await runSmoke(env, async (url, init) => {
    const headers = new Headers(init.headers);
    if (new URL(url).pathname.includes('/players/compare') && headers.get('Sec-Fetch-Site') === 'cross-site') {
      return new Response('', { status: 403 });
    }
    if (!headers.has('CF-Access-Client-Id')) return accessRedirect();
    const path = new URL(url).pathname;
    const health = path === '/api/health';
    const chat = path === '/api/chat';
    const query = path === '/api/query';
    const rejected = chat && init.body.includes('per 90');
    if (path === contextPath) return new Response(JSON.stringify(validContext), { headers: {
      'cache-control': 'private, no-store', 'content-type': 'application/json',
    } });
    if (path.includes('/players/trends')) {
      const params = new URL(url).searchParams;
      assert.equal(params.get('person_ids'), 'fpl:code:1');
      return new Response(params.get('normalization') === 'per90'
        ? (path.startsWith('/es/') ? 'Clasificación por 90 minutos' : 'Per-90 leaderboard')
        : (path.startsWith('/es/') ? 'Evolución de jugadores' : 'Player trends'),
        { status: 200, headers: { 'cache-control': 'private, no-store' } });
    }
    if (path.includes('/players/compare')) {
      const locale = path.startsWith('/es/') ? 'es' : 'en';
      const params = new URL(url).searchParams;
      const canonicalParams = new URLSearchParams({ schema_version: '1', competition: 'PL' });
      for (const id of params.getAll('person_ids')) canonicalParams.append('person_ids', id);
      canonicalParams.append('seasons', '2024-25');
      canonicalParams.set('metric', 'goals');
      canonicalParams.set('normalization', 'total');
      canonicalParams.set('min_minutes', '0');
      canonicalParams.set('viz', 'table');
      const marker = locale === 'es' ? 'Comparar jugadores' : 'Compare players';
      return new Response(`${marker}<link rel="canonical" href="/${locale}/players/compare?${canonicalParams.toString().replaceAll('&', '&amp;')}">`,
        { status: 200, headers: { 'cache-control': 'private, no-store' } });
    }
    return new Response(health ? JSON.stringify(validHealth) :
      chat ? JSON.stringify(rejected ? unsupported : validChat) :
      query ? JSON.stringify(validQuery(queryCalls++ === 0 ? 'computable_now_queued' : 'available')) :
      (path === '/en/seasons/explore' || path === '/es/seasons/explore')
        ? `<html lang="${path.startsWith('/es/') ? 'es' : 'en'}"><link rel="canonical" href="${path}?schema_version=1&amp;competition=PL&amp;seasons=2014-15&amp;group_by=venue">${path.startsWith('/es/') ? 'La capacidad de desgloses por temporada no está publicada.' : 'Season splits capability is not published.'}</html>` :
      ['/en/opponents/history', '/es/opponents/history'].includes(path) ? opponentPage(path.startsWith('/es/') ? 'es' : 'en', path + new URL(url).search, true) :
      'Ask about Manchester United Try asking Pregunta sobre el Manchester United Prueba preguntando Champions League history Historial de la Liga de Campeones Data and sources Datos y fuentes League season comparison Comparación de temporadas de liga 62–37 goals 62–37 goles >1.84</td> >1,84</td> 49–35 goals 49–35 goles >1.74</td> >1,74</td> font-family Assists — 2023-24 PL class="dot" aria-current="page">Dots</a> aria-current="page">Gráfico de puntos</a> <table>',
    { status: rejected ? 422 : 200, headers: { 'cache-control': 'private, no-store',
      ...((health || chat || query) ? { 'content-type': 'application/json' } : {}) } });
  });
  assert.equal(results.length, 93);
  assert.ok(results.every((result) => result.pass), JSON.stringify(results.filter((result) => !result.pass)));
});

test('triage context validates the outer v1 envelope and nested v2 contract', () => {
  assert.equal(validateTriageContextPayload(validContext), 'ready');
  for (const people of [[], Array.from({ length: 200 }, (_, i) => ({ id: `p:${i}`, label: 'Fixture' }))]) {
    for (const has_more of [false, true]) assert.equal(validateTriageContextPayload({
      ...validContext, payload: { ...validContext.payload, people, has_more },
    }), 'ready');
  }
  for (const value of [null, [], {}, { ...validContext, version: 2 }, { ...validContext, version: '1' },
    { ...validContext, version: true }, { ...validContext, kind: 'context' }, { ...validContext, extra: true },
    { ...validContext, payload: null }, { ...validContext, payload: [] }]) {
    assert.equal(validateTriageContextPayload(value), null);
  }
  for (const payload of [null, [], {}, { ...validContext.payload, extra: true },
    { ...validContext.payload, triage_protocol: 1 }, { ...validContext.payload, triage_protocol: '2' },
    { ...validContext.payload, triage_protocol: true }, { ...validContext.payload, has_more: 1 },
    { ...validContext.payload, glossary_protocol: 2 }, { ...validContext.payload, glossary_protocol: '1' },
    { ...validContext.payload, glossary_protocol: true },
    { triage_protocol: 2, catalog_digest: validContext.payload.catalog_digest, people: [], has_more: false },
    { ...validContext.payload, people: {} }, { ...validContext.payload, people: Array(201).fill(validContext.payload.people[0]) }]) {
    assert.equal(validateTriageContextPayload({ ...validContext, payload }), null);
  }
  for (const key of ['version', 'kind', 'payload']) {
    const value = structuredClone(validContext); delete value[key];
    assert.equal(validateTriageContextPayload(value), null);
  }
  for (const key of Object.keys(validContext.payload)) {
    const value = structuredClone(validContext); delete value.payload[key];
    assert.equal(validateTriageContextPayload(value), null);
  }
});

test('triage catalog validates exact UTF-8 bytes, JSON and matching digest', () => {
  const withCatalog = catalog_json => ({ ...validContext, payload: {
    ...validContext.payload, catalog_json,
    catalog_digest: typeof catalog_json === 'string' ? catalogDigest(catalog_json) : validContext.payload.catalog_digest,
  } });
  for (const catalog of ['{}', 'null', ' "Mañana" ', '"' + 'é'.repeat(32767) + '"']) {
    assert.equal(validateTriageContextPayload(withCatalog(catalog)), 'ready');
  }
  for (const catalog of [null, 7, {}, '', '{', '"' + 'a'.repeat(65535) + '"', '"' + 'é'.repeat(32768) + '"']) {
    assert.equal(validateTriageContextPayload(withCatalog(catalog)), null);
  }
  for (const catalog_digest of ['d'.repeat(64), catalogDigest(JSON.stringify(JSON.parse(' "Mañana" ')))]) {
    const value = withCatalog(' "Mañana" ');
    value.payload.catalog_digest = catalog_digest;
    assert.equal(validateTriageContextPayload(value), null);
  }
});

test('triage snapshot requires 1 to 128 ASCII identifier characters', () => {
  for (const snapshot_id of ['a', 'A0:_-', 'a'.repeat(128)]) {
    assert.equal(validateTriageContextPayload({ ...validContext, payload: { ...validContext.payload, snapshot_id } }), 'ready');
  }
  for (const snapshot_id of ['', 'a'.repeat(129), 'a/b', 'a b', 'é', 'a\n', null, 1]) {
    assert.equal(validateTriageContextPayload({ ...validContext, payload: { ...validContext.payload, snapshot_id } }), null);
  }
});

test('triage metadata uses exact route bounds and strict lowercase hex', () => {
  for (const digest of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'a'.repeat(63) + '\n', 'a'.repeat(64) + '\n', null, 7]) {
    assert.equal(validateTriageContextPayload({ ...validContext, payload: { ...validContext.payload, catalog_digest: digest } }), null);
  }
  const withPerson = person => ({ ...validContext, payload: { ...validContext.payload, people: [person] } });
  for (const id of ['a', 'a'.repeat(64), '0:route_id-valid']) {
    assert.equal(validateTriageContextPayload(withPerson({ id, label: 'Fixture' })), 'ready');
  }
  for (const id of ['', 'a'.repeat(65), ':a', 'A', 'a/b', 'a b', 'a\n', 'a\0', null, 1]) {
    assert.equal(validateTriageContextPayload(withPerson({ id, label: 'Fixture' })), null);
  }
  for (const label of ['ñ'.repeat(120), '😀'.repeat(60), '<b>Fixture</b>', ' '.repeat(120)]) {
    assert.equal(validateTriageContextPayload(withPerson({ id: 'a', label })), 'ready');
  }
  for (const label of ['', 'a'.repeat(121), '😀'.repeat(61), 'a\n', 'a\0', 'a\u200b', 'a\u202e', null, 1]) {
    assert.equal(validateTriageContextPayload(withPerson({ id: 'a', label })), null);
  }
  for (const person of [null, [], { id: 'a' }, { label: 'Fixture' }, { id: 'a', label: 'Fixture', extra: true }]) {
    assert.equal(validateTriageContextPayload(withPerson(person)), null);
  }
});

async function contextRow(response, fail = null) {
  let calls = 0;
  const rows = await smoke(env, async url => {
    if (new URL(url).pathname === contextPath) {
      calls++;
      if (fail) throw fail;
      return response;
    }
    return new Response('irrelevant', { headers: { 'cache-control': 'private, no-store' } });
  });
  assert.equal(calls, 1);
  const matching = rows.filter(row => row.path === contextPath);
  assert.equal(matching.length, 1);
  return matching[0];
}

function contextStream(chunks, options = {}) {
  const state = { reads: 0, cancellations: 0, releases: 0 };
  const reader = {
    async read() {
      state.reads++;
      if (options.readError) throw new Error('PRIVATE_READ_ERROR');
      return state.reads <= chunks.length ? { done: false, value: chunks[state.reads - 1] } : { done: true };
    },
    async cancel() { state.cancellations++; if (options.cancelError) throw new Error('PRIVATE_CANCEL_ERROR'); },
    releaseLock() { state.releases++; },
  };
  return { state, response: {
    status: options.status ?? 200,
    headers: new Headers({ 'content-type': 'application/json', 'cache-control': 'private, no-store', ...options.headers }),
    body: { getReader: () => reader, cancel: () => reader.cancel() },
    text: () => { throw new Error('unbounded text reader used'); },
    json: () => { throw new Error('unbounded JSON reader used'); },
  } };
}

test('triage response counts streaming bytes before buffering and cancels overflow', async () => {
  const limit = 128 * 1024, encoded = new Uint8Array(limit).fill(32);
  encoded.set(new TextEncoder().encode(JSON.stringify(validContext)));
  const exact = contextStream([encoded]);
  assert.equal((await contextRow(exact.response)).triage_state, 'ready');
  assert.deepEqual(exact.state, { reads: 2, cancellations: 0, releases: 1 });
  for (const cancelError of [false, true]) {
    for (const chunks of [[new Uint8Array(limit + 1)], [encoded, Uint8Array.of(32), Uint8Array.of(32)]]) {
      const oversized = contextStream(chunks, { cancelError, headers: { 'content-length': '1' } });
      assert.deepEqual(await contextRow(oversized.response), { path: contextPath, status: 200, pass: false, triage_state: 'invalid' });
      assert.equal(oversized.state.reads, chunks.length === 1 ? 1 : 2);
      assert.equal(oversized.state.cancellations, 1); assert.equal(oversized.state.releases, 1);
    }
  }
});

test('triage decoding is fatal UTF8 and accepts split multibyte labels', async () => {
  const value = structuredClone(validContext); value.payload.people[0].label = 'ø';
  const bytes = new TextEncoder().encode(JSON.stringify(value)), offset = bytes.indexOf(0xc3);
  const valid = contextStream([bytes.slice(0, offset + 1), bytes.slice(offset + 1)]);
  assert.equal((await contextRow(valid.response)).triage_state, 'ready');
  const malformed = bytes.slice(); malformed[offset + 1] = 0x28;
  for (const chunks of [[malformed], [new TextEncoder().encode('{private invalid JSON')], [Uint8Array.of(0xc3)]]) {
    assert.equal((await contextRow(contextStream(chunks).response)).triage_state, 'invalid');
  }
  const failed = contextStream([], { readError: true, cancelError: true });
  const result = await contextRow(failed.response);
  assert.equal(result.triage_state, 'invalid'); assert.equal(failed.state.cancellations, 1);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});

test('triage HTTP readiness requires 200 JSON and an exact no-store directive', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(validContext));
  for (const options of [{ status: 302 }, { status: 403 }, { status: 503 },
    { headers: { 'content-type': 'text/html' } }, { headers: { 'content-type': 'application/json-evil' } },
    { headers: { 'cache-control': 'private' } }, { headers: { 'cache-control': 'private, x-no-store' } },
    { headers: { 'cache-control': 'private, no-store=1' } }]) {
    const streamed = contextStream([bytes], options);
    const result = await contextRow(streamed.response);
    assert.equal(result.pass, false); assert.equal(result.triage_state, 'invalid');
    assert.equal(streamed.state.reads, 0); assert.equal(streamed.state.cancellations, 1);
  }
  assert.equal((await contextRow(contextStream([bytes], { headers: {
    'cache-control': 'private, NO-STORE', 'content-type': 'application/json; charset=utf-8',
  } }).response)).triage_state, 'ready');
  assert.equal((await contextRow(new Response(null, { headers: {
    'cache-control': 'no-store', 'content-type': 'application/json',
  } }))).triage_state, 'invalid');
});

test('triage output contains only finite readiness, never context or error details', async () => {
  const value = structuredClone(validContext);
  value.payload.people = [{ id: 'private-context-id', label: 'PRIVATE_CONTEXT_LABEL' }];
  const row = await contextRow(contextStream([new TextEncoder().encode(JSON.stringify(value))]).response);
  assert.deepEqual(row, { path: contextPath, status: 200, pass: true, triage_state: 'ready' });
  assert.ok(!JSON.stringify(row).includes(value.payload.catalog_digest));
  assert.ok(!JSON.stringify(row).includes(value.payload.catalog_json));
  assert.ok(!JSON.stringify(row).includes('PRIVATE_CATALOG_Mañana'));
  assert.ok(!JSON.stringify(row).includes(value.payload.snapshot_id));
  assert.ok(!JSON.stringify(row).includes('private-context-id'));
  assert.ok(!JSON.stringify(row).includes('PRIVATE_CONTEXT_LABEL'));
  const failure = await contextRow(null, new Error('PRIVATE_THROWN_ERROR'));
  assert.deepEqual(failure, { path: contextPath, pass: false, error_class: 'Error', triage_state: 'invalid' });
  for (const missing of [{ CF_ACCESS_CLIENT_ID: env.CF_ACCESS_CLIENT_ID }, { CF_ACCESS_CLIENT_SECRET: env.CF_ACCESS_CLIENT_SECRET }]) {
    await assert.rejects(smoke(missing, () => { throw new Error('must not request'); }), /Missing dev/);
  }
});
