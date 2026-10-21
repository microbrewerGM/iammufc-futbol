import { test } from 'node:test';
import assert from 'node:assert/strict';
import { denialSmoke, runSmoke, smoke, validateChatPayload,
  snapshotContinuitySmoke, validateHealthPayload, validateQueryPayload,
  validateSnapshotMatch } from './dev-access-smoke.mjs';

const env = { CF_ACCESS_CLIENT_ID: 'synthetic-id', CF_ACCESS_CLIENT_SECRET: 'synthetic-secret' };
const snapshot = 'a'.repeat(64);
const expectedSnapshot = 'b'.repeat(64);
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
test('fixed dev origin, manual redirects, private response and all checks', async () => {
  const calls = [];
  let queryCalls = 0;
  const results = await smoke(env, async (url, init) => {
    calls.push({ url, init });
    assert.equal(new URL(url).origin, 'https://iammufc-dev.aaron-cf2.workers.dev');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Origin, new URL(url).origin);
    assert.equal(init.headers['CF-Access-Client-Secret'], env.CF_ACCESS_CLIENT_SECRET);
    const path = new URL(url).pathname;
    const health = path === '/api/health';
    const chat = path === '/api/chat';
    const query = path === '/api/query';
    const rejected = chat && init.body.includes('per 90');
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
    return new Response(health
      ? JSON.stringify(validHealth)
      : chat ? JSON.stringify(rejected ? unsupported : validChat)
      : query ? JSON.stringify(validQuery(queryCalls++ === 0 ? 'computable_now_queued' : 'available'))
      : 'Ask about Manchester United Pregunta sobre el Manchester United Data and sources Datos y fuentes League season comparison Comparación de temporadas de liga 62–37 goals 62–37 goles >1.84</td> >1,84</td> 49–35 goals 49–35 goles >1.74</td> >1,74</td> font-family Assists — 2023-24 PL class="dot" aria-current="page">Dots</a> aria-current="page">Gráfico de puntos</a> <table>',
    { status: rejected ? 422 : 200, headers: { 'cache-control': 'private, no-store',
      ...((health || chat || query) ? { 'content-type': 'application/json; charset=UTF-8' } : {}) } });
  });
  assert.equal(calls.length, 19);
  assert.equal(calls.find((call) => new URL(call.url).pathname === '/en/ask').init.method, 'POST');
  assert.equal(calls.find((call) => new URL(call.url).pathname === '/api/health').init.method, 'GET');
  assert.ok(results.every((result) => result.pass), JSON.stringify(results.filter((result) => !result.pass)));
  assert.deepEqual(results.at(-6), { path: '/api/chat', status: 200, pass: true,
    model_status: 'accepted' });
  assert.deepEqual(results.at(-5), { path: '/api/chat', status: 422, pass: true,
    gate_status: 'unsupported_semantics' });
  assert.deepEqual(results.at(-4), { path: '/api/query', status: 200, pass: true,
    query_state: 'computable_now_queued' });
  assert.deepEqual(results.at(-3), { path: '/api/query', status: 200, pass: true,
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
    assert.equal(await snapshotContinuitySmoke(expected, async () => mockedResponse), false);
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
      'Ask about Manchester United Pregunta sobre el Manchester United Data and sources Datos y fuentes League season comparison Comparación de temporadas de liga 62–37 goals 62–37 goles >1.84</td> >1,84</td> 49–35 goals 49–35 goles >1.74</td> >1,74</td> font-family Assists — 2023-24 PL class="dot" aria-current="page">Dots</a> aria-current="page">Gráfico de puntos</a> <table>',
    { status: rejected ? 422 : 200, headers: { 'cache-control': 'private, no-store',
      ...((health || chat || query) ? { 'content-type': 'application/json' } : {}) } });
  });
  assert.equal(results.length, 80);
  assert.ok(results.every((result) => result.pass), JSON.stringify(results.filter((result) => !result.pass)));
});
