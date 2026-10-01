import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runP17Canary } from './p17-canary-smoke.mjs';

const env = { CF_ACCESS_CLIENT_ID: 'synthetic-id', CF_ACCESS_CLIENT_SECRET: 'synthetic-secret' };
const intent = (metric, season, entityId = 'all', viz = 'bar') => ({
  metric, entity_type: 'player', entity_id: entityId, season, competition: 'PL',
  dimensions: [], filters: {}, viz, limit: 10,
});
const chat = (proposedIntent) => ({
  proposed_intent: proposedIntent, source: 'ai', model_status: 'accepted', confidence: 'high',
  notes: [], feasibility: { state: 'available' },
  next: 'POST the proposed_intent to /api/query to execute it.',
});
const clarification = (metric, season = '2025-26') => ({
  proposed_intent: intent(metric, season), source: 'rules',
  model_status: 'not_attempted_ambiguous', confidence: 'low', notes: ['bounded'],
  feasibility: { state: 'available' },
  next: 'POST the proposed_intent to /api/query to execute it.',
});
const rejected = { rejected: true, code: 'unsupported_semantics', reason: 'bounded',
  suggestion: 'bounded', proposed_intent: null, feasibility: null };

test('runs six cases three times and emits aggregate-only results', async () => {
  const calls = [];
  const results = await runP17Canary(env, async (url, init) => {
    calls.push({ url, init });
    const question = JSON.parse(init.body).question;
    const value = question.includes('per 90') ? rejected
      : question === 'Most assists' ? clarification('assists')
      : question.startsWith('Fernandes') ? clarification('goals', '2024-25')
      : question.startsWith('Más') ? chat(intent('assists', '2023-24', 'all', 'table'))
      : question.startsWith('"Rashford"') ? chat(intent('goals', '2024-25', 'Rashford'))
      : chat(intent('goals', '2024-25'));
    return new Response(JSON.stringify(value), {
      status: value.rejected ? 422 : 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    });
  });
  assert.equal(calls.length, 18);
  assert.ok(calls.every(({ init }) => init.headers['X-IAMMUFC-P17-Canary'] === 'v1'));
  assert.equal(results.length, 6);
  assert.ok(results.every((result) => result.trials === 3 && result.passed));
  const serialized = JSON.stringify(results);
  assert.ok(!serialized.includes('Top goals'));
  assert.ok(!serialized.includes('synthetic'));
});

test('stops when a clarification mutates its deterministic intent', async () => {
  await assert.rejects(runP17Canary(env, async (_url, init) => {
    const question = JSON.parse(init.body).question;
    const value = question.includes('per 90') ? rejected
      : question === 'Most assists' ? clarification('assists')
      : question.startsWith('Fernandes') ? clarification('assists', '2024-25')
      : question.startsWith('Más') ? chat(intent('assists', '2023-24', 'all', 'table'))
      : question.startsWith('"Rashford"') ? chat(intent('goals', '2024-25', 'Rashford'))
      : chat(intent('goals', '2024-25'));
    return new Response(JSON.stringify(value), {
      status: value.rejected ? 422 : 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    });
  }), /stopped at ambiguous_identity trial 1/);
});

test('stops when a clarification mutates a nested filter', async () => {
  await assert.rejects(runP17Canary(env, async (_url, init) => {
    const question = JSON.parse(init.body).question;
    const value = question.includes('per 90') ? rejected
      : question === 'Most assists' ? clarification('assists')
      : question.startsWith('Fernandes')
        ? { ...clarification('goals', '2024-25'),
            proposed_intent: { ...intent('goals', '2024-25'), filters: { position: 'GK' } } }
        : question.startsWith('Más') ? chat(intent('assists', '2023-24', 'all', 'table'))
        : question.startsWith('"Rashford"') ? chat(intent('goals', '2024-25', 'Rashford'))
        : chat(intent('goals', '2024-25'));
    return new Response(JSON.stringify(value), {
      status: value.rejected ? 422 : 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    });
  }), /stopped at ambiguous_identity trial 1/);
});

test('stops on the first invalid result and never prints provider content', async () => {
  let calls = 0;
  await assert.rejects(runP17Canary(env, async () => {
    calls += 1;
    return new Response(JSON.stringify({ private_provider_output: 'do not print' }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    });
  }), /stopped at en_supported trial 1/);
  assert.equal(calls, 1);
});

test('missing credentials makes no request', async () => {
  await assert.rejects(runP17Canary({}, () => { throw new Error('must not request'); }), /Missing dev/);
});
