// @ts-nocheck -- Node integration fixtures run under Vitest's Node environment.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { accessHeadersFor, captureViewports, cropBox, isBarUrl, isDevRequest, pairSides, planCapture, validateBarList, validateInputs } from '../scripts/gauntlet-capture.mjs';

const valid = { QUESTION_ID: 'Q-HOME-AWAY', DEV_ROUTE: '/compare', REVISION: 'a'.repeat(40), OVERRIDE: '', CF_ACCESS_CLIENT_ID: 'client-id-sentinel', CF_ACCESS_CLIENT_SECRET: 'client-secret-sentinel' };
const fixtureScript = new URL('../scripts/gauntlet-capture.mjs', import.meta.url);

function listen(server: ReturnType<typeof createServer>) {
  return new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
}

function execute(env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [fixtureScript.pathname], { env, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('gauntlet capture guards', () => {
  it('validates workflow inputs', () => {
    expect(validateInputs(valid).question).toBe('Q-HOME-AWAY');
    expect(() => validateInputs({ ...valid, DEV_ROUTE: '/../../etc' })).toThrow();
    expect(() => validateInputs({ ...valid, REVISION: 'abc' })).toThrow();
    expect(() => validateInputs({ ...valid, QUESTION_ID: 'bad' })).toThrow();
  });

  it('forwards Access headers only for the hard-coded dev host', () => {
    expect(isDevRequest('https://iammufc-dev.aaron-cf2.workers.dev/en')).toBe(true);
    expect(isDevRequest('https://fbref.com/')).toBe(false);
    expect(isDevRequest('https://iammufc-dev.aaron-cf2.workers.dev.evil.test/')).toBe(false);
    expect(isDevRequest('http://iammufc-dev.aaron-cf2.workers.dev/')).toBe(false);
    const original = { accept: 'text/html' };
    expect(accessHeadersFor('https://fbref.com/', original, { id: 'id', secret: 'secret' })).toEqual(original);
    expect(accessHeadersFor('https://iammufc-dev.aaron-cf2.workers.dev/', original, { id: 'id', secret: 'secret' })).toMatchObject({ 'cf-access-client-id': 'id', 'cf-access-client-secret': 'secret' });
  });

  it('limits bars to two URLs on approved hosts', () => {
    expect(isBarUrl('https://fbref.com/en/squads/')).toBe(true);
    expect(isBarUrl('https://www.transfermarkt.com/')).toBe(true);
    expect(isBarUrl('https://transfermarkt.com/')).toBe(false);
    expect(isBarUrl('https://example.com/')).toBe(false);
    expect(() => validateBarList({ 'Q-TEST': ['https://fbref.com/1', 'https://fbref.com/2', 'https://fbref.com/3'] })).toThrow(/bar list/);
  });

  it('keeps bars compact and valid', async () => {
    const bars = JSON.parse(await readFile(new URL('../gauntlet/bars.json', import.meta.url), 'utf8')) as Record<string, string[]>;
    expect(Object.keys(bars).sort()).toEqual(['Q-ARRIVAL-MANAGER', 'Q-EUROPE-HISTORY', 'Q-HEAD-TO-HEAD', 'Q-MANAGER-ERAS', 'Q-PER90-LEADERS', 'Q-PLAYER-TREND', 'Q-SEASON-SPLITS'].sort());
    expect(Object.values(bars).every((urls) => urls.length <= 2 && urls.length > 0 && urls.every(isBarUrl))).toBe(true);
    expect(validateBarList(bars)).toEqual(bars);
    expect(() => validateBarList({ 'Q-TEST': ['https://evil.example/path'] })).toThrow(/bar list/);
  });

  it('defines explicit EN, ES and 320 px views, and limits pages', () => {
    expect(captureViewports().map(({ name, locale, width }) => [name, locale, width])).toEqual([
      ['en', 'en', 1280], ['es', 'es', 1280], ['mobile', 'en', 320],
    ]);
    expect(planCapture('Q-SEASON-SPLITS', ['https://fbref.com/', 'https://www.transfermarkt.com/']).urls).toHaveLength(2);
    expect(() => planCapture('Q-SEASON-SPLITS', ['https://fbref.com/', 'https://www.transfermarkt.com/', 'https://fbref.com/3'])).toThrow(/budget/);
  });

  it('captures through run with redacted logs, blinded equal image sides and nonce hash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gauntlet-test-'));
    const output = join(dir, 'out');
    const fakeBin = join(dir, 'bin');
    const fixtureBars = join(process.cwd(), 'gauntlet/bars.fixture.json');
    const fixtureRecipient = join(process.cwd(), 'gauntlet/age-recipient.fixture.txt');
    await writeFile(fixtureBars, JSON.stringify({ 'Q-HOME-AWAY': [] }));
    await writeFile(fixtureRecipient, await readFile(new URL('../gauntlet/age-recipient.txt', import.meta.url), 'utf8'));
    const playwrightPath = join(dir, 'fake-playwright.mjs');
    await writeFile(playwrightPath, `
      const page = () => ({ goto: async () => ({ status: () => 200 }), setViewportSize: async () => {}, screenshot: async ({ path }) => import('node:fs/promises').then(({ writeFile }) => writeFile(path, 'fixture-image')) });
      const context = () => ({ route: async (_matcher, handler) => { await handler({ request: () => ({ url: () => 'https://iammufc-dev.aaron-cf2.workers.dev/compare', headers: () => ({ accept: 'text/html' }) }), fetch: async (options) => { if (options.maxRedirects !== 0) throw new Error('redirects not capped'); return { status: () => 200 }; }, fulfill: async () => {} }); }, newPage: async () => page(), close: async () => {} });
      export const chromium = { launch: async () => ({ newContext: async () => context(), close: async () => {} }) };
    `);
    await import('node:fs/promises').then(({ mkdir }) => mkdir(fakeBin));
    const agePath = join(fakeBin, 'age');
    await writeFile(agePath, '#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\nshift\nout="$1"\nshift\ncp "$1" "$out.input"\nprintf encrypted > "$out"\n');
    await import('node:fs/promises').then(({ chmod }) => chmod(agePath, 0o755));
    const baseEnv = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      QUESTION_ID: valid.QUESTION_ID,
      DEV_ROUTE: valid.DEV_ROUTE,
      REVISION: valid.REVISION,
      OVERRIDE: '',
      CF_ACCESS_CLIENT_ID: valid.CF_ACCESS_CLIENT_ID,
      CF_ACCESS_CLIENT_SECRET: valid.CF_ACCESS_CLIENT_SECRET,
      RUNNER_TEMP: output,
      GAUNTLET_PLAYWRIGHT_MODULE: playwrightPath,
      NODE_ENV: 'test',
    };
    try {
    const success = await execute(baseEnv);
      expect(success.code).toBe(0);
      const allOutput = success.stdout + success.stderr;
      for (const secret of ['PLANTED_SENTINEL_PAGE_TEXT', 'CF_Authorization', valid.CF_ACCESS_CLIENT_ID, valid.CF_ACCESS_CLIENT_SECRET]) expect(allOutput).not.toContain(secret);
      const summary = await readFile(join(output, 'summary.txt'), 'utf8');
      expect(summary).toMatch(/^[0-9a-f]{64}$/);
      const workflow = await readFile(new URL('../.github/workflows/gauntlet-capture.yml', import.meta.url), 'utf8');
      expect(workflow).toContain('cat "$RUNNER_TEMP/summary.txt" >> "$GITHUB_STEP_SUMMARY"');
      const files = await import('node:fs/promises').then(({ readdir }) => readdir(output));
      const pairing = JSON.parse(await readFile(join(output, 'pairing.age.input'), 'utf8')) as { ours: string; bar: string; nonce: string };
      expect(pairing.nonce).toMatch(/^[0-9a-f]{64}$/);
      const images = files.filter((name) => /^capture-\d+\.age$/.test(name));
      expect(images).toHaveLength(3);
      expect(summary).toBe(createHash('sha256').update(JSON.stringify(pairing)).digest('hex'));
      expect(images.some((name) => name.startsWith(`ours-`) || name.startsWith('bar-'))).toBe(false);
      const failure = await execute({ ...baseEnv, QUESTION_ID: 'invalid-sentinel-client-id' });
      const failureOutput = failure.stdout + failure.stderr;
      expect(failure.code).not.toBe(0);
      for (const secret of ['PLANTED_SENTINEL_PAGE_TEXT', 'CF_Authorization', valid.CF_ACCESS_CLIENT_ID, valid.CF_ACCESS_CLIENT_SECRET]) expect(failureOutput).not.toContain(secret);
    } finally {
      await rm(fixtureBars, { force: true });
      await rm(fixtureRecipient, { force: true });
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('uses route.fetch with redirects disabled so redirected requests are checked independently', async () => {
    let bHeaders: Record<string, string> | undefined;
    const b = createServer((request, response) => { bHeaders = request.headers; response.end('<main>PLANTED_SENTINEL_PAGE_TEXT</main>'); });
    const bPort = await listen(b);
    const a = createServer((_request, response) => { response.writeHead(302, { location: `http://127.0.0.1:${bPort}/target` }); response.end(); });
    const aPort = await listen(a);
    try {
      let aHeaders: Record<string, string> | undefined;
      const aWithHeaders = createServer((request, response) => { aHeaders = request.headers; response.writeHead(302, { location: `http://127.0.0.1:${bPort}/target` }); response.end(); });
      const aWithHeadersPort = await listen(aWithHeaders);
      await fetch(`http://127.0.0.1:${aWithHeadersPort}/start`, { redirect: 'manual', headers: { 'cf-access-client-id': 'fixture-id', 'cf-access-client-secret': 'fixture-secret' } });
      expect(aHeaders?.['cf-access-client-id']).toBe('fixture-id');
      expect(bHeaders).toBeUndefined();
      await fetch(`http://127.0.0.1:${bPort}/target`);
      expect(Object.keys(bHeaders ?? {}).some((key) => key.startsWith('cf-access-'))).toBe(false);
      await new Promise<void>((resolve) => aWithHeaders.close(() => resolve()));
      expect(bHeaders && Object.keys(bHeaders).some((key) => key.startsWith('cf-access-'))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => a.close(() => resolve()));
      await new Promise<void>((resolve) => b.close(() => resolve()));
    }
  });

  it('pairs sides with an independent coin byte', () => {
    expect(pairSides(0)).toEqual({ ours: 'A', bar: 'B' });
    expect(pairSides(1)).toEqual({ ours: 'B', bar: 'A' });
    expect(cropBox(1280, 900)).toEqual({ x: 38, y: 96, width: 1203, height: 768 });
    expect(createHash('sha256').update('pairing plus nonce').digest('hex')).toMatch(/^[0-9a-f]{64}$/);
  });
});
