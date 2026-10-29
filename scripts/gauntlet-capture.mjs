import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const DEV_HOST = 'iammufc-dev.aaron-cf2.workers.dev';
const BAR_HOSTS = new Set(['fbref.com', 'www.transfermarkt.com']);
const ID_RE = /^Q-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_BAR_PAGES = 2;

export function validateInputs(env) {
  const question = env.QUESTION_ID ?? '';
  const route = env.DEV_ROUTE ?? '';
  const revision = env.REVISION ?? '';
  const override = env.OVERRIDE ?? '';
  if (!ID_RE.test(question)) throw new Error('invalid question id');
  if (!/^\/[A-Za-z0-9/_-]*$/.test(route) || route.includes('..')) throw new Error('invalid route');
  if (!SHA_RE.test(revision)) throw new Error('invalid revision');
  if (override && !/^(?:season:[0-9]{4}-[0-9]{4}|player:[A-Za-z0-9-]{1,80})$/.test(override)) throw new Error('invalid override');
  if (!env.CF_ACCESS_CLIENT_ID || !env.CF_ACCESS_CLIENT_SECRET) throw new Error('missing Access credentials');
  return { question, route, revision, override };
}
export function isDevRequest(url) {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && parsed.hostname === DEV_HOST; } catch { return false; }
}
export function accessHeadersFor(url, headers, credentials) {
  if (!isDevRequest(url)) return headers;
  return { ...headers, 'cf-access-client-id': credentials.id, 'cf-access-client-secret': credentials.secret };
}
export function isBarUrl(url) {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && BAR_HOSTS.has(parsed.hostname); } catch { return false; }
}
export function validateBarList(bars) {
  if (!bars || typeof bars !== 'object' || Array.isArray(bars)) throw new Error('invalid bar list');
  for (const [question, urls] of Object.entries(bars)) {
    if (!ID_RE.test(question) || !Array.isArray(urls) || urls.length > MAX_BAR_PAGES || urls.some((url) => !isBarUrl(url))) throw new Error('invalid bar list');
  }
  return bars;
}
export function pairSides(coinByte) { return coinByte % 2 === 0 ? { ours: 'A', bar: 'B' } : { ours: 'B', bar: 'A' }; }
export function cropBox(width, height) {
  const chrome = Math.min(96, Math.floor(height * 0.12));
  return { x: Math.floor(width * 0.03), y: chrome, width: Math.floor(width * 0.94), height: height - chrome - Math.floor(height * 0.04) };
}
export function captureViewports() {
  return [
    { name: 'en', locale: 'en', width: 1280, height: 900 },
    { name: 'es', locale: 'es', width: 1280, height: 900 },
    { name: 'mobile', locale: 'en', width: 320, height: 800 },
  ];
}
export function planCapture(question, urls) {
  if (urls.length > MAX_BAR_PAGES) throw new Error('bar page budget exceeded');
  return { urls: urls.slice(0, MAX_BAR_PAGES) };
}
export async function encryptFiles(files, recipientPath, outputDir) {
  const recipient = (await readFile(recipientPath, 'utf8')).trim();
  if (!/^age1[0-9a-z]{58}$/.test(recipient)) throw new Error('invalid age recipient');
  for (const file of files) await new Promise((resolve, reject) => {
    const child = spawn('age', ['-r', recipient, '-o', join(outputDir, `${file.name}.age`), file.path], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', () => {});
    child.on('error', () => reject(new Error('age encryption failed')));
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`age encryption failed (${code})`)));
  });
}
function logStep(step) { console.log(`step=${step}`); }
function emitStatus(status) { console.log(`status=${status}`); }
async function run() {
  const input = validateInputs(process.env);
  const barsPath = process.env.NODE_ENV === 'test' ? 'gauntlet/bars.fixture.json' : 'gauntlet/bars.json';
  const bars = validateBarList(JSON.parse(await readFile(barsPath, 'utf8')));
  const urls = bars[input.question] ?? [];
  const plan = planCapture(input.question, urls);
  const { chromium } = process.env.NODE_ENV === 'test' ? await import(pathToFileURL(process.env.GAUNTLET_PLAYWRIGHT_MODULE)) : await import('playwright');
  const output = process.env.RUNNER_TEMP;
  await mkdir(output, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), 'gauntlet-'));
  const devBrowser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  const barBrowser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  const devContext = await devBrowser.newContext();
  const barContext = await barBrowser.newContext();
  const counts = { barPages: 0 };
  const imagePaths = [];
  const coin = randomBytes(1)[0];
  const pairing = pairSides(coin);
  try {
    logStep('dev-navigation');
    await devContext.route('**/*', async (route) => {
      const requestUrl = route.request().url();
      const headers = accessHeadersFor(requestUrl, route.request().headers(), { id: process.env.CF_ACCESS_CLIENT_ID, secret: process.env.CF_ACCESS_CLIENT_SECRET });
      if (isDevRequest(requestUrl)) return route.fulfill({ response: await route.fetch({ headers, maxRedirects: 0 }) });
      return route.continue({ headers });
    });
    const devPage = await devContext.newPage();
    const devBase = process.env.NODE_ENV === 'test' ? 'https://iammufc-dev.aaron-cf2.workers.dev' : `https://${DEV_HOST}`;
    const devUrl = `${devBase}${input.route}${input.override ? `?${encodeURIComponent(input.override)}` : ''}`;
    const devResponse = await devPage.goto(devUrl, { waitUntil: 'networkidle' });
    emitStatus(devResponse?.status() ?? 0);
    for (const view of captureViewports()) {
      const localeUrl = `${devBase}/${view.locale}${input.route}${input.override ? `?${encodeURIComponent(input.override)}` : ''}`;
      await devPage.goto(localeUrl, { waitUntil: 'networkidle' }).then((response) => emitStatus(response?.status() ?? 0));
      await devPage.setViewportSize({ width: view.width, height: view.height });
      const side = pairing.ours;
      const path = join(work, `${side}-${view.name}.png`);
      await devPage.screenshot({ path, clip: cropBox(view.width, view.height) });
      imagePaths.push(path);
    }
    for (let i = 0; i < plan.urls.length; i += 1) {
      if (i) await delay(10_000);
      logStep('bar-navigation');
      const page = await barContext.newPage();
      const response = await page.goto(plan.urls[i], { waitUntil: 'domcontentloaded' });
      emitStatus(response?.status() ?? 0);
      counts.barPages += 1;
      for (const view of captureViewports()) {
        await page.setViewportSize({ width: view.width, height: view.height });
        const side = pairing.bar;
        const path = join(work, `${side}-${view.name}-${counts.barPages}.png`);
        await page.screenshot({ path, clip: cropBox(view.width, view.height) });
        imagePaths.push(path);
      }
    }
    const nonce = randomBytes(32).toString('hex');
    await writeFile(join(work, 'pairing.json'), JSON.stringify({ ...pairing, nonce }));
    const encrypted = [...imagePaths.map((path, index) => ({ name: `capture-${index}`, path })), { name: 'pairing', path: join(work, 'pairing.json') }];
    logStep('age-encryption');
    await encryptFiles(encrypted, process.env.NODE_ENV === 'test' ? 'gauntlet/age-recipient.fixture.txt' : 'gauntlet/age-recipient.txt', output);
    const hash = createHash('sha256').update(JSON.stringify({ ...pairing, nonce })).digest('hex');
    await writeFile(join(output, 'summary.txt'), hash);
  } finally {
    await devContext.close().catch(() => {});
    await barContext.close().catch(() => {});
    await devBrowser.close().catch(() => {});
    await barBrowser.close().catch(() => {});
    await rm(work, { recursive: true, force: true });
  }
  console.log(`capture complete: bar_pages=${counts.barPages}`);
}
if (import.meta.url === `file://${process.argv[1]}`) run().catch(() => { console.error('capture failed'); process.exitCode = 1; });
