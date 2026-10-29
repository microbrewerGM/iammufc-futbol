import { createHash, randomBytes, randomInt } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const DEV_HOST = 'iammufc-dev.aaron-cf2.workers.dev';
const BAR_HOSTS = new Set(['fbref.com', 'www.transfermarkt.com']);
const ID_RE = /^Q-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_BAR_PAGES = 2;
const MAX_EXAMPLE_ASKS = 6;

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
    if (!ID_RE.test(question) || !Array.isArray(urls) || urls.length < 1 || urls.some((url) => !isBarUrl(url))) throw new Error('invalid bar list');
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
    { name: 'mobile', locale: null, width: 320, height: 800 },
  ];
}
export function planCapture(question, urls, exampleAsks = []) {
  if (urls.length > MAX_BAR_PAGES) throw new Error('bar page budget exceeded');
  const asks = question === 'Q-ASK-EXAMPLES' ? exampleAsks.slice(0, MAX_EXAMPLE_ASKS) : [];
  return { urls: urls.slice(0, MAX_BAR_PAGES), asks };
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
  const bars = validateBarList(JSON.parse(await readFile('gauntlet/bars.json', 'utf8')));
  const urls = bars[input.question];
  if (!urls) throw new Error('question has no bars');
  const examples = input.question === 'Q-ASK-EXAMPLES' ? JSON.parse(process.env.EXAMPLE_ASKS_JSON ?? '[]') : [];
  if (!Array.isArray(examples) || examples.some((ask) => typeof ask !== 'string')) throw new Error('invalid example asks');
  const plan = planCapture(input.question, urls, examples);
  const { chromium } = await import('playwright');
  const output = process.env.RUNNER_TEMP;
  const work = await mkdtemp(join(tmpdir(), 'gauntlet-'));
  const devBrowser = await chromium.launch({ headless: true });
  const barBrowser = await chromium.launch({ headless: true });
  const devContext = await devBrowser.newContext();
  const barContext = await barBrowser.newContext();
  const counts = { barPages: 0, asks: plan.asks.length };
  const imagePaths = [];
  const coin = randomBytes(1)[0];
  const pairing = pairSides(coin);
  try {
    logStep('dev-navigation');
    await devContext.route('**/*', async (route) => {
      const requestUrl = route.request().url();
      return route.continue({ headers: accessHeadersFor(requestUrl, route.request().headers(), { id: process.env.CF_ACCESS_CLIENT_ID, secret: process.env.CF_ACCESS_CLIENT_SECRET }) });
    });
    const devPage = await devContext.newPage();
    const devUrl = `https://${DEV_HOST}${input.route}${input.override ? `?${encodeURIComponent(input.override)}` : ''}`;
    const devResponse = await devPage.goto(devUrl, { waitUntil: 'networkidle' });
    emitStatus(devResponse?.status() ?? 0);
    for (const view of captureViewports()) {
      if (view.locale && view.name !== 'en') await devPage.goto(`https://${DEV_HOST}/${view.locale}${input.route}${input.override ? `?${encodeURIComponent(input.override)}` : ''}`, { waitUntil: 'networkidle' }).then((response) => emitStatus(response?.status() ?? 0));
      else if (view.name === 'en') await devPage.goto(devUrl, { waitUntil: 'networkidle' }).then((response) => emitStatus(response?.status() ?? 0));
      await devPage.setViewportSize({ width: view.width, height: view.height });
      const path = join(work, `ours-${view.name}-${randomInt(1e9)}.png`);
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
        const path = join(work, `bar-${counts.barPages}-${view.name}-${randomInt(1e9)}.png`);
        await page.screenshot({ path, clip: cropBox(view.width, view.height) });
        imagePaths.push(path);
      }
    }
    for (let i = 0; i < plan.asks.length; i += 1) {
      logStep('example-ask');
      // Cached answers are read first; live submissions are capped at six and happen only on cache misses.
      const ask = plan.asks[i];
      const cached = process.env[`CACHED_ANSWER_${i + 1}`];
      if (!cached) {
        const response = await devContext.request.post(`https://${DEV_HOST}/en/ask`, { form: { q: ask } });
        emitStatus(response.status());
      }
    }
    await writeFile(join(work, 'pairing.json'), JSON.stringify(pairing));
    const encrypted = [...imagePaths.map((path, index) => ({ name: `capture-${index}`, path })), { name: 'pairing', path: join(work, 'pairing.json') }];
    logStep('age-encryption');
    await encryptFiles(encrypted, 'gauntlet/age-recipient.txt', output);
    const hash = createHash('sha256').update(JSON.stringify(pairing)).digest('hex');
    await writeFile(join(output, 'summary.txt'), `bar_pages=${counts.barPages} example_asks=${counts.asks} pairing_sha256=${hash}`);
  } finally {
    await devContext.close().catch(() => {});
    await barContext.close().catch(() => {});
    await devBrowser.close().catch(() => {});
    await barBrowser.close().catch(() => {});
    await rm(work, { recursive: true, force: true });
  }
  console.log(`capture complete: bar_pages=${counts.barPages} example_asks=${counts.asks}`);
}
if (import.meta.url === `file://${process.argv[1]}`) run().catch(() => { console.error('capture failed'); process.exitCode = 1; });
