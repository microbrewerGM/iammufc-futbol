// @ts-nocheck -- Node integration fixtures run under Vitest's Node environment.
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { accessHeadersFor, captureViewports, cropBox, installFatalHandlers, isDevRequest, run, validateInputs } from '../scripts/gauntlet-capture.mjs';

const valid = { QUESTION_ID: 'Q-HOME-AWAY', DEV_ROUTE: '/compare', REVISION: 'a'.repeat(40), OVERRIDE: '', CF_ACCESS_CLIENT_ID: 'client-id-sentinel', CF_ACCESS_CLIENT_SECRET: 'client-secret-sentinel' };
const devUrl = 'https://iammufc-dev.aaron-cf2.workers.dev/compare';
const root = new URL('../', import.meta.url);

function ageFake(dir) {
  return join(dir, 'age');
}
async function setup(dir) {
  const recipientPath = join(dir, 'recipient.txt');
  const outputDir = join(dir, 'out');
  const tmp = join(dir, 'tmp');
  await mkdir(tmp, { recursive: true });
  await writeFile(recipientPath, await readFile(new URL('../gauntlet/age-recipient.txt', import.meta.url), 'utf8'));
  const fakeAge = ageFake(dir);
  await writeFile(fakeAge, '#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\nshift\nout="$1"\nshift\ncp "$1" "$out.input"\nprintf encrypted > "$out"\n');
  await chmod(fakeAge, 0o755);
  return { paths: { recipientPath, outputDir, tempDir: tmp }, ageBinary: fakeAge };
}
function mockChromium({ routeRequests = [], failGoto = false, gotoStatus = 200, throwIfAborted = false } = {}) {
  const observations = { fetches: [], continues: [], fulfills: [], aborted: [], routeHandler: undefined, pageText: '', launches: 0, contexts: 0, navigations: [], shots: [] };
  const context = () => {
    observations.contexts += 1;
    return {
      route: async (_pattern, handler) => {
        observations.routeHandler = handler;
        for (const item of routeRequests) await handler(fakeRoute(item.url, observations, item));
      },
      unrouteAll: async (options) => { observations.unrouteOptions = options; },
      newPage: async () => ({
        goto: async (url) => { observations.navigations.push(url); observations.currentUrl = url; observations.pageText = '<main>PLANTED_SENTINEL_PAGE_TEXT</main>'; if (failGoto || (throwIfAborted && observations.aborted.length > 0)) throw new Error('navigation failed'); return { status: () => gotoStatus }; },
        content: async () => observations.pageText,
        setViewportSize: async ({ width }) => { observations.width = width; },
        screenshot: async ({ path }) => { observations.shots.push({ url: observations.currentUrl, width: observations.width }); await writeFile(path, 'fixture-image'); },
      }),
      close: async () => {},
    };
  };
  const chromium = { launch: async () => { observations.launches += 1; return { newContext: async () => context(), close: async () => {} }; } };
  return { chromium, observations };
}
function fakeRoute(url, observations, { fetchError, fetchStatus = 200, headers = { accept: 'text/html' }, navigation = true, frameUrl = url, frameError = false } = {}) {
  return {
    request: () => ({ url: () => url, headers: () => headers, isNavigationRequest: () => navigation, frame: () => { if (frameError) throw new Error('frame unavailable'); return { url: () => frameUrl }; } }),
    fetch: async (options) => {
      observations.fetches.push({ url, options });
      if (fetchError) throw fetchError;
      return { status: () => fetchStatus };
    },
    fulfill: async ({ response }) => observations.fulfills.push({ url, status: response.status() }),
    continue: async ({ headers: sentHeaders }) => observations.continues.push({ url, headers: sentHeaders }),
    abort: async (reason) => { observations.aborted.push(url); observations.abortReasons = [...(observations.abortReasons ?? []), reason]; },
  };
}

describe('gauntlet capture guards', () => {
  it('validates inputs, routes and overrides', () => {
    expect(validateInputs(valid).question).toBe('Q-HOME-AWAY');
    expect(validateInputs({ ...valid, DEV_ROUTE: '/encounters' }).route).toBe('/encounters');
    expect(() => validateInputs({ ...valid, DEV_ROUTE: '/en/x' })).toThrow();
    for (const DEV_ROUTE of ['/../../etc', '/en/compare', '/es', '/es/compare']) expect(() => validateInputs({ ...valid, DEV_ROUTE })).toThrow();
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
      await run({ ...files, chromium: fake.chromium, env: valid });
      expect(fake.observations.fetches).toHaveLength(2);
      expect(fake.observations.fetches[0].options).toMatchObject({ maxRedirects: 0, headers: { 'cf-access-client-id': valid.CF_ACCESS_CLIENT_ID, 'cf-access-client-secret': valid.CF_ACCESS_CLIENT_SECRET } });
      expect(fake.observations.fulfills[0]).toMatchObject({ status: 302 });
      expect(fake.observations.continues).toHaveLength(0);
      expect(fake.observations.aborted).toEqual(expect.arrayContaining([redirected, 'https://www.transfermarkt.com/page', `${devUrl}/failure`]));
      expect(fake.observations.abortReasons).toContain('blockedbyclient');
      expect(logs).toContain('step=blocked-non-dev');
      expect(logs).toContain('step=route-error');
      expect(fake.observations.pageText).toContain('PLANTED_SENTINEL_PAGE_TEXT');
      expect(logs.join('\n')).not.toContain('PLANTED_SENTINEL_PAGE_TEXT');
      expect(fake.observations.unrouteOptions).toEqual({ behavior: 'ignoreErrors' });
    } finally {
      console.log = oldLog;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('aborts the follow-up when a dev 302 points off-host, so the dev host is the only egress', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gauntlet-test-'));
    const files = await setup(dir);
    const offHost = 'https://fbref.com/x';
    const fake = mockChromium({ routeRequests: [{ url: devUrl, fetchStatus: 302 }, { url: offHost }] });
    const oldLog = console.log;
    console.log = () => {};
    try {
      await run({ ...files, chromium: fake.chromium, env: valid });
      expect(fake.observations.aborted).toEqual([offHost]);
      expect(fake.observations.abortReasons).toEqual(['blockedbyclient']);
      expect(fake.observations.continues).toHaveLength(0);
      expect(fake.observations.fetches.every(({ url }) => isDevRequest(url))).toBe(true);
      expect(fake.observations.fulfills.every(({ url }) => isDevRequest(url))).toBe(true);
    } finally {
      console.log = oldLog;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on a 403 main-frame response: no .age or summary written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gauntlet-test-'));
    const files = await setup(dir);
    const fake = mockChromium({ gotoStatus: 403 });
    const oldLog = console.log;
    console.log = () => {};
    try {
      await expect(run({ ...files, chromium: fake.chromium, env: valid })).rejects.toThrow();
      const names = await readdir(files.paths.outputDir);
      expect(names.filter((name) => name.startsWith('ours-'))).toEqual([]);
      expect(names).not.toContain('summary.txt');
    } finally {
      console.log = oldLog;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when an off-host redirect aborts the main-frame navigation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gauntlet-test-'));
    const files = await setup(dir);
    const fake = mockChromium({ routeRequests: [{ url: devUrl, fetchStatus: 302 }, { url: 'https://fbref.com/x' }], throwIfAborted: true });
    const oldLog = console.log;
    console.log = () => {};
    try {
      await expect(run({ ...files, chromium: fake.chromium, env: valid })).rejects.toThrow();
      expect(fake.observations.aborted).toEqual(['https://fbref.com/x']);
      const names = await readdir(files.paths.outputDir);
      expect(names.filter((name) => name.startsWith('ours-'))).toEqual([]);
      expect(names).not.toContain('summary.txt');
    } finally {
      console.log = oldLog;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('adds Origin and same-origin Sec-Fetch-Site on dev requests only', () => {
    const credentials = { id: 'id', secret: 'secret' };
    const dev = accessHeadersFor(devUrl, { accept: 'text/html', Origin: 'null', 'sec-fetch-site': 'none' }, credentials);
    expect(dev).toEqual({ accept: 'text/html', origin: 'https://iammufc-dev.aaron-cf2.workers.dev', 'sec-fetch-site': 'same-origin', 'cf-access-client-id': 'id', 'cf-access-client-secret': 'secret' });
    const bar = { accept: 'text/html' };
    expect(accessHeadersFor('https://fbref.com/one', bar, credentials)).toBe(bar);
    for (const url of [
      'https://iammufc-dev.aaron-cf2.workers.dev.evil.com/',
      'http://iammufc-dev.aaron-cf2.workers.dev/',
      'https://iammufc-dev.aaron-cf2.workers.dev@evil.test/',
      'https://user@iammufc-dev.aaron-cf2.workers.dev/',
    ]) {
      expect(accessHeadersFor(url, bar, credentials)).toBe(bar);
    }
  });

  it('passes Origin headers to route.fetch for dev requests including locale paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gauntlet-test-'));
    const files = await setup(dir);
    const fake = mockChromium({ routeRequests: [{ url: `${devUrl}` }, { url: 'https://iammufc-dev.aaron-cf2.workers.dev/es/compare' }] });
    const oldLog = console.log;
    console.log = () => {};
    try {
      await run({ ...files, chromium: fake.chromium, env: valid });
      expect(fake.observations.fetches).toHaveLength(2);
      for (const { options } of fake.observations.fetches) {
        expect(options.headers).toMatchObject({ origin: 'https://iammufc-dev.aaron-cf2.workers.dev', 'sec-fetch-site': 'same-origin' });
      }
    } finally {
      console.log = oldLog;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('adds origin overrides on dev navigations and dev-frame subresources only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gauntlet-test-'));
    const files = await setup(dir);
    const fake = mockChromium({ routeRequests: [
      { url: devUrl, navigation: true },
      { url: `${devUrl}/asset.js`, navigation: false, frameUrl: devUrl },
      { url: `${devUrl}/from-blank.js`, navigation: false, frameUrl: 'about:blank' },
    ] });
    const oldLog = console.log;
    console.log = () => {};
    try {
      await run({ ...files, chromium: fake.chromium, env: valid });
      expect(fake.observations.fetches).toHaveLength(3);
      expect(fake.observations.fetches.map(({ options }) => options.headers.origin)).toEqual([
        'https://iammufc-dev.aaron-cf2.workers.dev',
        'https://iammufc-dev.aaron-cf2.workers.dev',
        undefined,
      ]);
      expect(fake.observations.fetches[2].options.headers['sec-fetch-site']).toBeUndefined();
      expect(fake.observations.continues).toHaveLength(0);
    } finally {
      console.log = oldLog;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('recognises the exact dev host without a port and rejects userinfo', () => {
    expect(isDevRequest(devUrl)).toBe(true);
    expect(isDevRequest('https://iammufc-dev.aaron-cf2.workers.dev:8443/')).toBe(false);
    expect(isDevRequest('https://iammufc-dev.aaron-cf2.workers.dev:443/')).toBe(true);
    expect(isDevRequest('https://iammufc-dev.aaron-cf2.workers.dev.evil.test/')).toBe(false);
    expect(isDevRequest('https://iammufc-dev.aaron-cf2.workers.dev@evil.test/')).toBe(false);
    expect(isDevRequest('https://user@iammufc-dev.aaron-cf2.workers.dev/')).toBe(false);
    expect(isDevRequest('https://fbref.com/')).toBe(false);
  });

  it('blocks dev-host URLs with userinfo without passing mutated headers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gauntlet-test-'));
    const files = await setup(dir);
    const userinfoUrl = 'https://user@iammufc-dev.aaron-cf2.workers.dev/one';
    const fake = mockChromium({ routeRequests: [{ url: userinfoUrl }] });
    const oldLog = console.log;
    console.log = () => {};
    try {
      await run({ ...files, chromium: fake.chromium, env: valid });
      expect(fake.observations.aborted).toEqual([userinfoUrl]);
      expect(fake.observations.fetches).toEqual([]);
      expect(fake.observations.continues).toEqual([]);
    } finally {
      console.log = oldLog;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('shoots only dev pages: one browser, one context, no non-dev navigation, ours-0..2.age only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gauntlet-test-'));
    const files = await setup(dir);
    const fake = mockChromium({ routeRequests: [{ url: devUrl }] });
    const logs = [];
    const oldLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      await run({ ...files, chromium: fake.chromium, env: valid });
      expect(fake.observations.launches).toBe(1);
      expect(fake.observations.contexts).toBe(1);
      expect(fake.observations.navigations.length).toBeGreaterThan(0);
      expect(fake.observations.navigations.every((url) => /^https:\/\/iammufc-dev\.aaron-cf2\.workers\.dev\/(en|es)\//.test(url))).toBe(true);
      const encrypted = (await readdir(files.paths.outputDir)).filter((name) => name.endsWith('.age')).sort();
      expect(encrypted).toEqual(['ours-0.age', 'ours-1.age', 'ours-2.age']);
      const base = 'https://iammufc-dev.aaron-cf2.workers.dev';
      expect(captureViewports().map(({ locale }) => locale)).toEqual(['en', 'es', 'en']);
      expect(fake.observations.shots).toEqual([{ url: `${base}/en/compare`, width: 1280 }, { url: `${base}/es/compare`, width: 1280 }, { url: `${base}/en/compare`, width: 320 }]);
      expect(logs).toContain('capture complete: dev_pages=3');
      expect(logs.join('\n')).not.toContain('PLANTED_SENTINEL_PAGE_TEXT');
      expect(logs.join('\n')).not.toContain(valid.CF_ACCESS_CLIENT_SECRET);
    } finally {
      console.log = oldLog;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on a 404 locale page without writing any capture artifacts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gauntlet-test-'));
    const files = await setup(dir);
    const fake = mockChromium({ gotoStatus: 404 });
    const oldLog = console.log;
    console.log = () => {};
    try {
      await expect(run({ ...files, chromium: fake.chromium, env: valid })).rejects.toThrow();
      const names = await readdir(files.paths.outputDir);
      expect(fake.observations.navigations.every((url) => /^https:\/\/iammufc-dev\.aaron-cf2\.workers\.dev\/(en|es)\//.test(url))).toBe(true);
      expect(names.filter((name) => name.endsWith('.age'))).toEqual([]);
      expect(names).not.toContain('summary.txt');
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

  it('handles a floating rejected promise without exposing its error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gauntlet-test-'));
    const harness = join(dir, 'fatal-handler-harness.mjs');
    const modulePath = new URL('../scripts/gauntlet-capture.mjs', import.meta.url).href;
    await writeFile(harness, `
      import { installFatalHandlers } from ${JSON.stringify(modulePath)};
      installFatalHandlers();
      Promise.reject(new Error('credential=SENTINEL_FLOATING_CREDENTIAL'));
    `);
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [harness], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.on('close', (code) => resolve({ code, stderr }));
    });
    expect(result).toEqual({ code: 1, stderr: 'capture failed\n' });
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  it('defines explicit EN, ES and mobile views and crop geometry', () => {
    expect(captureViewports().map(({ name, locale, width }) => [name, locale, width])).toEqual([['en', 'en', 1280], ['es', 'es', 1280], ['mobile', 'en', 320]]);
    expect(cropBox(1280, 900)).toEqual({ x: 38, y: 96, width: 1203, height: 768 });
  });
});
