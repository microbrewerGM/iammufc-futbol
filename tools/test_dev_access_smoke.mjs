import { test } from 'node:test';
import assert from 'node:assert/strict';
import { denialSmoke, runSmoke, smoke, validateChatPayload,
  validateHealthPayload } from './dev-access-smoke.mjs';

const env = { CF_ACCESS_CLIENT_ID: 'synthetic-id', CF_ACCESS_CLIENT_SECRET: 'synthetic-secret' };
const snapshot = 'a'.repeat(64);
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
test('fixed dev origin, manual redirects, private response and all checks', async () => {
  const calls = [];
  const results = await smoke(env, async (url, init) => {
    calls.push({ url, init });
    assert.equal(new URL(url).origin, 'https://iammufc-dev.aaron-cf2.workers.dev');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Origin, new URL(url).origin);
    assert.equal(init.headers['CF-Access-Client-Secret'], env.CF_ACCESS_CLIENT_SECRET);
    const path = new URL(url).pathname;
    const health = path === '/api/health';
    const chat = path === '/api/chat';
    const rejected = chat && init.body.includes('per 90');
    return new Response(health
      ? JSON.stringify(validHealth)
      : chat ? JSON.stringify(rejected ? unsupported : validChat)
      : 'Ask about Manchester United Pregunta sobre el Manchester United font-family Assists — 2023-24 PL',
    { status: rejected ? 422 : 200, headers: { 'cache-control': 'private, no-store',
      ...((health || chat) ? { 'content-type': 'application/json; charset=UTF-8' } : {}) } });
  });
  assert.equal(calls.length, 7);
  assert.equal(calls.find((call) => new URL(call.url).pathname === '/en/ask').init.method, 'POST');
  assert.equal(calls.find((call) => new URL(call.url).pathname === '/api/health').init.method, 'GET');
  assert.ok(results.every((result) => result.pass));
  assert.deepEqual(results.at(-2), { path: '/api/chat', status: 200, pass: true,
    model_status: 'accepted' });
  assert.deepEqual(results.at(-1), { path: '/api/chat', status: 422, pass: true,
    gate_status: 'unsupported_semantics' });
  assert.ok(!JSON.stringify(results).includes('synthetic'));
  assert.ok(!JSON.stringify(results).includes(snapshot));
  assert.ok(!JSON.stringify(results).includes(retrieved));
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

test('health response requires JSON content type and never emits raw metadata', async () => {
  const results = await smoke(env, async (url) => {
    const health = new URL(url).pathname === '/api/health';
    return new Response(health ? JSON.stringify(validHealth) :
      'Ask about Manchester United Pregunta sobre el Manchester United font-family Assists — 2023-24 PL',
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
        'Ask about Manchester United Pregunta sobre el Manchester United font-family Assists — 2023-24 PL',
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
    assert.equal(headers.has('CF-Access-Client-Id'), false);
    assert.equal(headers.has('CF-Access-Client-Secret'), false);
    assert.equal(headers.has('Cookie'), false);
    assert.equal(headers.has('Authorization'), false);
    return accessRedirect();
  });
  assert.equal(calls.length, 31);
  assert.equal(calls.filter(({ init }) => init.method === 'HEAD').length, 14);
  assert.equal(calls.filter(({ init }) => new Headers(init.headers).has('CF-Access-Jwt-Assertion')).length, 3);
  assert.ok(results.every((result) => result.pass));
  assert.ok(!JSON.stringify(results).includes('private=value'));
  assert.ok(!JSON.stringify(results).includes('synthetic-invalid-assertion'));
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
    const results = await denialSmoke(async () => response.clone());
    assert.ok(results.every((result) => !result.pass));
  }
});

test('combined smoke requires authenticated success and denial success', async () => {
  const results = await runSmoke(env, async (url, init) => {
    const headers = new Headers(init.headers);
    if (!headers.has('CF-Access-Client-Id')) return accessRedirect();
    const path = new URL(url).pathname;
    const health = path === '/api/health';
    const chat = path === '/api/chat';
    const rejected = chat && init.body.includes('per 90');
    return new Response(health ? JSON.stringify(validHealth) :
      chat ? JSON.stringify(rejected ? unsupported : validChat) :
      'Ask about Manchester United Pregunta sobre el Manchester United font-family Assists — 2023-24 PL',
    { status: rejected ? 422 : 200, headers: { 'cache-control': 'private, no-store',
      ...((health || chat) ? { 'content-type': 'application/json' } : {}) } });
  });
  assert.equal(results.length, 38);
  assert.ok(results.every((result) => result.pass));
});
