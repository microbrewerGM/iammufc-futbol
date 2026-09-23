import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smoke } from './dev-access-smoke.mjs';

const env = { CF_ACCESS_CLIENT_ID: 'synthetic-id', CF_ACCESS_CLIENT_SECRET: 'synthetic-secret' };
test('fixed dev origin, manual redirects, private response and all checks', async () => {
  const calls = [];
  const results = await smoke(env, async (url, init) => {
    calls.push({ url, init });
    assert.equal(new URL(url).origin, 'https://iammufc-dev.aaron-cf2.workers.dev');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Origin, new URL(url).origin);
    assert.equal(init.headers['CF-Access-Client-Secret'], env.CF_ACCESS_CLIENT_SECRET);
    return new Response('Ask about Manchester United Pregunta sobre el Manchester United font-family Assists — 2023-24 PL',
      { headers: { 'cache-control': 'private, no-store' } });
  });
  assert.equal(calls.length, 4);
  assert.equal(calls[3].init.method, 'POST');
  assert.ok(results.every((result) => result.pass));
  assert.ok(!JSON.stringify(results).includes('synthetic'));
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
