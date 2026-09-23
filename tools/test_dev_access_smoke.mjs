import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smoke, validateHealthPayload } from './dev-access-smoke.mjs';

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
test('fixed dev origin, manual redirects, private response and all checks', async () => {
  const calls = [];
  const results = await smoke(env, async (url, init) => {
    calls.push({ url, init });
    assert.equal(new URL(url).origin, 'https://iammufc-dev.aaron-cf2.workers.dev');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Origin, new URL(url).origin);
    assert.equal(init.headers['CF-Access-Client-Secret'], env.CF_ACCESS_CLIENT_SECRET);
    const health = new URL(url).pathname === '/api/health';
    return new Response(health
      ? JSON.stringify(validHealth)
      : 'Ask about Manchester United Pregunta sobre el Manchester United font-family Assists — 2023-24 PL',
    { headers: { 'cache-control': 'private, no-store',
      ...(health ? { 'content-type': 'application/json; charset=UTF-8' } : {}) } });
  });
  assert.equal(calls.length, 5);
  assert.equal(calls.find((call) => new URL(call.url).pathname === '/en/ask').init.method, 'POST');
  assert.equal(calls.find((call) => new URL(call.url).pathname === '/api/health').init.method, 'GET');
  assert.ok(results.every((result) => result.pass));
  assert.deepEqual(results.at(-1), { path: '/api/health', status: 200, pass: true, health_state: 'current' });
  assert.ok(!JSON.stringify(results).includes('synthetic'));
  assert.ok(!JSON.stringify(results).includes(snapshot));
  assert.ok(!JSON.stringify(results).includes(retrieved));
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
    assert.deepEqual(results.at(-1), { path: '/api/health', status: 200, pass: false, health_state: 'invalid' });
    assert.ok(!JSON.stringify(results).includes('private-body'));
  }
});
