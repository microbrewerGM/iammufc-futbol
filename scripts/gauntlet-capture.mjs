import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const DEV_HOST = 'iammufc-dev.aaron-cf2.workers.dev';
const BAR_HOSTS = new Set(['fbref.com', 'www.transfermarkt.com']);
const ID_RE = /^Q-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const SHA_RE = /^[0-9a-f]{40}$/;

export function validateInputs(env) {
  const question = env.QUESTION_ID ?? '';
  const route = env.DEV_ROUTE ?? '';
  const revision = env.REVISION ?? '';
  const override = env.OVERRIDE ?? '';
  if (!ID_RE.test(question) || question === 'Q-ASK-EXAMPLES') throw new Error('invalid question id');
  if (!/^\/[A-Za-z0-9/_-]*$/.test(route) || route.includes('..') || /^\/(en|es)(\/|$)/.test(route)) throw new Error('invalid route');
  if (!SHA_RE.test(revision)) throw new Error('invalid revision');
  if (override && !/^(?:season=[0-9]{4}-[0-9]{4}|player=[A-Za-z0-9-]{1,80})$/.test(override)) throw new Error('invalid override');
  if (!env.CF_ACCESS_CLIENT_ID || !env.CF_ACCESS_CLIENT_SECRET) throw new Error('missing Access credentials');
  return { question, route, revision, override };
}
export function isDevRequest(url) {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && parsed.hostname === DEV_HOST; } catch { return false; }
}
export function accessHeadersFor(url, headers, credentials) {
  if (!isDevRequest(url)) return headers;
  const kept = Object.fromEntries(Object.entries(headers).filter(([name]) => !['origin', 'sec-fetch-site'].includes(name.toLowerCase())));
  return { ...kept, origin: `https://${DEV_HOST}`, 'sec-fetch-site': 'same-origin', 'cf-access-client-id': credentials.id, 'cf-access-client-secret': credentials.secret };
}
export function isBarUrl(url) {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && BAR_HOSTS.has(parsed.hostname); } catch { return false; }
}
export function validateBarList(bars) {
  if (!bars || typeof bars !== 'object' || Array.isArray(bars)) throw new Error('invalid bar list');
  for (const [question, urls] of Object.entries(bars)) {
    if (!ID_RE.test(question) || !Array.isArray(urls) || urls.length > 2 || urls.some((url) => !isBarUrl(url))) throw new Error('invalid bar list');
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
  if (!urls.length) throw new Error('question has no bar URLs');
  return { urls: urls.slice(0, 1) };
}
export function shuffleImages(images, random = randomBytes) {
  const shuffled = [...images];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const range = i + 1;
    const limit = Math.floor(256 / range) * range;
    let value;
    do {
      value = random(1)[0];
    } while (value >= limit);
    const j = value % range;
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}
export async function encryptFiles(files, recipientPath, outputDir, ageBinary = 'age') {
  const recipient = (await readFile(recipientPath, 'utf8')).trim();
  if (!/^age1[0-9a-z]{58}$/.test(recipient)) throw new Error('invalid age recipient');
  for (const file of files) await new Promise((resolve, reject) => {
    const child = spawn(ageBinary, ['-r', recipient, '-o', join(outputDir, `${file.name}.age`), file.path], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', () => {});
    child.on('error', () => reject(new Error('age encryption failed')));
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`age encryption failed (${code})`)));
  });
}
function logStep(step) { console.log(`step=${step}`); }
function emitStatus(status) { console.log(`status=${status}`); }

export async function run(deps = {}) {
  const env = deps.env ?? process.env;
  const paths = deps.paths ?? {};
  const input = validateInputs(env);
  const barsPath = paths.barsPath ?? new URL('../gauntlet/bars.json', import.meta.url).pathname;
  const recipientPath = paths.recipientPath ?? new URL('../gauntlet/age-recipient.txt', import.meta.url).pathname;
  const output = paths.outputDir ?? env.RUNNER_TEMP;
  const tempRoot = paths.tempDir ?? tmpdir();
  const bars = validateBarList(JSON.parse(await readFile(barsPath, 'utf8')));
  const plan = planCapture(input.question, bars[input.question] ?? []);
  const chromium = deps.chromium ?? (await import('playwright')).chromium;
  const ageBinary = deps.ageBinary ?? 'age';
  const random = deps.randomBytes ?? randomBytes;
  await mkdir(output, { recursive: true });
  const work = await mkdtemp(join(tempRoot, 'gauntlet-'));
  const devBrowser = await chromium.launch({ headless: true });
  const barBrowser = await chromium.launch({ headless: true });
  const devContext = await devBrowser.newContext();
  const barContext = await barBrowser.newContext();
  const counts = { barPages: 0 };
  const images = [];
  const coin = random(1)[0];
  const pairing = pairSides(coin);
  try {
    logStep('dev-navigation');
    await devContext.route('**/*', async (route) => {
      try {
        const requestUrl = route.request().url();
        const headers = accessHeadersFor(requestUrl, route.request().headers(), { id: env.CF_ACCESS_CLIENT_ID, secret: env.CF_ACCESS_CLIENT_SECRET });
        if (isDevRequest(requestUrl)) return await route.fulfill({ response: await route.fetch({ headers, maxRedirects: 0 }) });
        return await route.continue({ headers });
      } catch {
        await Promise.resolve(route.abort()).catch(() => {});
        logStep('route-error');
      }
    });
    const devPage = await devContext.newPage();
    const devBase = `https://${DEV_HOST}`;
    const overrideQuery = input.override ? `?${input.override.split('=').map(encodeURIComponent).join('=')}` : '';
    const devUrl = `${devBase}${input.route}${overrideQuery}`;
    const devResponse = await devPage.goto(devUrl, { waitUntil: 'networkidle' });
    emitStatus(devResponse?.status() ?? 0);
    for (const view of captureViewports()) {
      const localeUrl = `${devBase}/${view.locale}${input.route}${overrideQuery}`;
      await devPage.goto(localeUrl, { waitUntil: 'networkidle' }).then((response) => emitStatus(response?.status() ?? 0));
      await devPage.setViewportSize({ width: view.width, height: view.height });
      const path = join(work, `image-${images.length}.png`);
      await devPage.screenshot({ path, clip: cropBox(view.width, view.height) });
      images.push({ path, side: pairing.ours });
    }
    const page = await barContext.newPage();
    logStep('bar-navigation');
    const response = await page.goto(plan.urls[0], { waitUntil: 'domcontentloaded' });
    emitStatus(response?.status() ?? 0);
    counts.barPages += 1;
    for (const view of captureViewports()) {
      await page.setViewportSize({ width: view.width, height: view.height });
      const path = join(work, `image-${images.length}.png`);
      await page.screenshot({ path, clip: cropBox(view.width, view.height) });
      images.push({ path, side: pairing.bar });
    }
    const shuffled = shuffleImages(images, random);
    const nonce = random(32).toString('hex');
    const pairingData = { ...pairing, coin, indexToSide: shuffled.map((image) => image.side), nonce };
    const pairingPath = join(work, 'pairing.json');
    await writeFile(pairingPath, JSON.stringify(pairingData));
    const encrypted = [...shuffled.map((image, index) => ({ name: `capture-${index}`, path: image.path })), { name: 'pairing', path: pairingPath }];
    logStep('age-encryption');
    await encryptFiles(encrypted, recipientPath, output, ageBinary);
    const hash = createHash('sha256').update(JSON.stringify(pairingData)).digest('hex');
    await writeFile(join(output, 'summary.txt'), hash);
  } finally {
    await devContext.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    await devContext.close().catch(() => {});
    await barContext.close().catch(() => {});
    await devBrowser.close().catch(() => {});
    await barBrowser.close().catch(() => {});
    await rm(work, { recursive: true, force: true });
  }
  console.log(`capture complete: bar_pages=${counts.barPages}`);
}

export function installFatalHandlers() {
  const fail = () => { console.error('capture failed'); process.exit(1); };
  process.on('unhandledRejection', fail);
  process.on('uncaughtException', fail);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  installFatalHandlers();
  run().catch(() => { console.error('capture failed'); process.exit(1); });
}
