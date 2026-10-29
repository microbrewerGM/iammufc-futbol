// @ts-nocheck -- Node integration fixtures run under Vitest's Node environment.
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { accessHeadersFor, captureViewports, cropBox, installFatalHandlers, isBarUrl, isDevRequest, pairSides, planCapture, run, shuffleImages, validateBarList, validateInputs } from '../scripts/gauntlet-capture.mjs';

const valid = { QUESTION_ID: 'Q-HOME-AWAY', DEV_ROUTE: '/compare', REVISION: 'a'.repeat(40), OVERRIDE: '', CF_ACCESS_CLIENT_ID: 'client-id-sentinel', CF_ACCESS_CLIENT_SECRET: 'client-secret-sentinel' };
const devUrl = 'https://iammufc-dev.aaron-cf2.workers.dev/compare';
const root = new URL('../', import.meta.url);

function ageFake(dir) {
  return join(dir, 'age');
}
async function setup(dir, bars = { 'Q-HOME-AWAY': ['https://fbref.com/one'] }) {
  const barsPath = join(dir, 'bars.json');
  const recipientPath = join(dir, 'recipient.txt');
  const outputDir = join(dir, 'out');
  const tmp = join(dir, 'tmp');
  await mkdir(tmp, { recursive: true });
  await writeFile(barsPath, JSON.stringify(bars));
  await writeFile(recipientPath, await readFile(new URL('../gauntlet/age-recipient.txt', import.meta.url), 'utf8'));
  const fakeAge = ageFake(dir);
  await writeFile(fakeAge, '#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\nshift\nout="$1"\nshift\ncp "$1" "$out.input"\nprintf encrypted > "$out"\n');
  await chmod(fakeAge, 0o755);
  return { paths: { barsPath, recipientPath, outputDir, tempDir: tmp }, ageBinary: fakeAge };
}
function mockChromium({ routeRequests = [], failGoto = false } = {}) {
  const observations = { fetches: [], continues: [], fulfills: [], aborted: [], routeHandler: undefined, pageText: '' };
  let isDevContext = true;
  const context = () => {
    const dev = isDevContext;
    isDevContext = false;
    return {
      route: async (_pattern, handler) => {
        observations.routeHandler = handler;
        for (const item of routeRequests) await handler(fakeRoute(item.url, observations, item));
      },
      unrouteAll: async (options) => { observations.unrouteOptions = options; },
      newPage: async () => ({
        goto: async () => { observations.pageText = '<main>PLANTED_SENTINEL_PAGE_TEXT</main>'; if (failGoto) throw new Error('navigation failed'); return { status: () => 200 }; },
        content: async () => observations.pageText,
        setViewportSize: async () => {},
        screenshot: async ({ path }) => writeFile(path, 'fixture-image'),
      }),
      close: async () => {},
    };
  };
  const chromium = { launch: async () => ({ newContext: async () => context(), close: async () => {} }) };
  return { chromium, observations };
}
function fakeRoute(url, observations, { fetchError, fetchStatus = 200 } = {}) {
  const headers = { accept: 'text/html' };
  return {
    request: () => ({ url: () => url, headers: () => headers }),
    fetch: async (options) => {
      observations.fetches.push({ url, options });
      if (fetchError) throw fetchError;
      return { status: () => fetchStatus };
    },
    fulfill: async ({ response }) => observations.fulfills.push({ url, status: response.status() }),
    continue: async ({ headers: sentHeaders }) => observations.continues.push({ url, headers: sentHeaders }),
    abort: async () => observations.aborted.push(url),
  };
}
function seededRandom(seed) {
  let state = seed >>> 0;
  return (size) => {
    const out = Buffer.alloc(size);
    for (let i = 0; i < size; i += 1) { state = (state * 1664525 + 1013904223) >>> 0; out[i] = state >>> 24; }
    return out;
  };
}

describe('gauntlet capture guards', () => {
  it('validates inputs, routes and overrides', () => {
    expect(validateInputs(valid).question).toBe('Q-HOME-AWAY');
    for (const DEV_ROUTE of ['/../../etc', '/en/compare', '/es', '/english']) expect(() => validateInputs({ ...valid, DEV_ROUTE })).toThrow();
    expect(() => validateInputs({ ...valid, REVISION: 'abc' })).toThrow();
    expect(() => validateInputs({ ...valid, QUESTION_ID: 'bad' })).toThrow();
    expect(() => validateInputs({ ...valid, QUESTION_ID: 'Q-ASK-EXAMPLES' })).toThrow();
    expect(() => validateInputs({ ...valid, OVERRIDE: 'season:2010-2011' })).toThrow();
    expect(validateInputs({ ...valid, OVERRIDE: 'season=2010-2011' }).override).toBe('season=2010-2011');
  });

  it('attaches Access credentials only on the actual dev route handler requests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gauntlet-test-'));
    const files = await setup(dir);
    const redirected = 'https://fbref.com/after-redirect';
    const failure = new Error('cf-access-client-id=client-id-sentinel cf-access-client-secret=client-secret-sentinel');
    const fake = mockChromium({ routeRequests: [
      { url: devUrl, fetchStatus: 302 },
      { url: redirected },
      { url: 'https://www.transfermarkt.com/page' },
      { url: `${devUrl}/failure`, fetchError: failure },
    ] });
    const logs = [];
    const oldLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      await run({ ...files, chromium: fake.chromium, env: valid, randomBytes: seededRandom(1) });
      expect(fake.observations.fetches).toHaveLength(2);
      expect(fake.observations.fetches[0].options).toMatchObject({ maxRedirects: 0, headers: { 'cf-access-client-id': valid.CF_ACCESS_CLIENT_ID, 'cf-access-client-secret': valid.CF_ACCESS_CLIENT_SECRET } });
      expect(fake.observations.fulfills[0]).toMatchObject({ status: 302 });
      expect(fake.observations.continues).toHaveLength(2);
      expect(fake.observations.continues.every(({ headers }) => !Object.keys(headers).some((key) => key.startsWith('cf-access-')))).toBe(true);
      expect(fake.observations.aborted).toContain(`${devUrl}/failure`);
      expect(logs).toContain('step=route-error');
      expect(fake.observations.pageText).toContain('PLANTED_SENTINEL_PAGE_TEXT');
      expect(logs.join('\n')).not.toContain('PLANTED_SENTINEL_PAGE_TEXT');
      expect(fake.observations.unrouteOptions).toEqual({ behavior: 'ignoreErrors' });
    } finally {
      console.log = oldLog;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps bars valid and fails when the question has no bar URLs', () => {
    expect(isDevRequest(devUrl)).toBe(true);
    expect(isDevRequest('https://iammufc-dev.aaron-cf2.workers.dev.evil.test/')).toBe(false);
    expect(isBarUrl('https://fbref.com/en/squads/')).toBe(true);
    expect(isBarUrl('https://www.transfermarkt.com/')).toBe(true);
    expect(isBarUrl('https://transfermarkt.com/')).toBe(false);
    expect(validateBarList({ 'Q-TEST': ['https://fbref.com/'] })).toEqual({ 'Q-TEST': ['https://fbref.com/'] });
    expect(() => validateBarList({ 'Q-TEST': ['https://evil.example/'] })).toThrow(/bar list/);
    expect(() => planCapture('Q-TEST', [])).toThrow(/no bar URLs/);
    expect(planCapture('Q-TEST', ['https://fbref.com/1', 'https://www.transfermarkt.com/2']).urls).toHaveLength(1);
  });

  it('captures equal blinded image counts and keeps the side map inside encrypted pairing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gauntlet-test-'));
    const files = await setup(dir);
    const fake = mockChromium({ routeRequests: [{ url: devUrl }] });
    const logs = [];
    const oldLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      const firstIsBar = [];
      for (const seed of [2, 5]) {
        const runFiles = await setup(join(dir, `seed-${seed}`));
        await run({ ...runFiles, chromium: fake.chromium, env: valid, randomBytes: seededRandom(seed) });
        const outputFiles = await readdir(runFiles.paths.outputDir);
        const images = outputFiles.filter((name) => /^capture-\d+\.age$/.test(name));
        expect(images).toHaveLength(6);
        const paired = JSON.parse(await readFile(join(runFiles.paths.outputDir, 'pairing.age.input'), 'utf8'));
        expect({ ours: paired.ours, bar: paired.bar }).toEqual(pairSides(paired.coin));
        expect(paired.indexToSide).toHaveLength(6);
        expect(paired.indexToSide.filter((side) => side === paired.ours)).toHaveLength(3);
        expect(paired.indexToSide.filter((side) => side === paired.bar)).toHaveLength(3);
        firstIsBar.push(paired.indexToSide[0] === paired.bar);
        const summary = await readFile(join(runFiles.paths.outputDir, 'summary.txt'), 'utf8');
        expect(summary).toBe(createHash('sha256').update(JSON.stringify(paired)).digest('hex'));
      }
      expect(firstIsBar).toEqual([true, true]);
      const seedRun = seededRandom(2);
      const sides = pairSides(seedRun(1)[0]);
      const shuffled = shuffleImages([...Array(3).fill(sides.ours), ...Array(3).fill(sides.bar)].map((side) => ({ side })), seedRun);
      expect(shuffled[0].side).toBe(sides.bar);
      expect(logs.join('\n')).not.toContain('PLANTED_SENTINEL_PAGE_TEXT');
      expect(logs.join('\n')).not.toContain(valid.CF_ACCESS_CLIENT_SECRET);
    } finally {
      console.log = oldLog;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('redacts a rejected route fetch and exits non-zero in the CLI process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gauntlet-test-'));
    const files = await setup(dir);
    const harness = join(dir, 'fatal-harness.mjs');
    const modulePath = new URL('../scripts/gauntlet-capture.mjs', import.meta.url).href;
    await writeFile(harness, `
      import { installFatalHandlers, run } from ${JSON.stringify(modulePath)};
      installFatalHandlers();
      const env = ${JSON.stringify(valid)};
      const fail = new Error('ID_SENTINEL secret=SECRET_SENTINEL');
      const route = { request: () => ({ url: () => 'https://iammufc-dev.aaron-cf2.workers.dev/x', headers: () => ({ accept: 'text/html' }) }), fetch: async () => { throw fail; }, fulfill: async () => {}, continue: async () => {}, abort: async () => {} };
      const context = () => ({ route: async (_pattern, handler) => handler(route), unrouteAll: async () => {}, newPage: async () => ({ goto: async () => { throw new Error('navigation failed'); }, setViewportSize: async () => {}, screenshot: async () => {} }), close: async () => {} });
      const chromium = { launch: async () => ({ newContext: async () => context(), close: async () => {} }) };
      run({ env, paths: ${JSON.stringify(files.paths)}, ageBinary: ${JSON.stringify(files.ageBinary)}, chromium }).catch(() => { console.error('capture failed'); process.exit(1); });
    `);
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [harness], { cwd: process.cwd(), env: { ...process.env, TMPDIR: tmpdir() }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain('ID_SENTINEL');
    expect(result.stdout + result.stderr).not.toContain('SECRET_SENTINEL');
    expect(result.stderr.trim()).toBe('capture failed');
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  it('defines explicit EN, ES and mobile views and crop geometry', () => {
    expect(captureViewports().map(({ name, locale, width }) => [name, locale, width])).toEqual([['en', 'en', 1280], ['es', 'es', 1280], ['mobile', 'en', 320]]);
    expect(cropBox(1280, 900)).toEqual({ x: 38, y: 96, width: 1203, height: 768 });
    expect(pairSides(0)).toEqual({ ours: 'A', bar: 'B' });
    expect(pairSides(1)).toEqual({ ours: 'B', bar: 'A' });
  });
});
