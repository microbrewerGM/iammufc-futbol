import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const DEV_HOST = 'iammufc-dev.aaron-cf2.workers.dev';
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
  const recipientPath = paths.recipientPath ?? new URL('../gauntlet/age-recipient.txt', import.meta.url).pathname;
  const output = paths.outputDir ?? env.RUNNER_TEMP;
  const tempRoot = paths.tempDir ?? tmpdir();
  const chromium = deps.chromium ?? (await import('playwright')).chromium;
  const ageBinary = deps.ageBinary ?? 'age';
  await mkdir(output, { recursive: true });
  const work = await mkdtemp(join(tempRoot, 'gauntlet-'));
  const devBrowser = await chromium.launch({ headless: true });
  const devContext = await devBrowser.newContext();
  const images = [];
  try {
    logStep('dev-navigation');
    await devContext.route('**/*', async (route) => {
      try {
        const requestUrl = route.request().url();
        const headers = accessHeadersFor(requestUrl, route.request().headers(), { id: env.CF_ACCESS_CLIENT_ID, secret: env.CF_ACCESS_CLIENT_SECRET });
        if (isDevRequest(requestUrl)) return await route.fulfill({ response: await route.fetch({ headers, maxRedirects: 0 }) });
        await route.abort('blockedbyclient');
        logStep('blocked-non-dev');
        return;
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
      const name = `ours-${images.length}`;
      const path = join(work, `${name}.png`);
      await devPage.screenshot({ path, clip: cropBox(view.width, view.height) });
      images.push({ name, path });
    }
    logStep('age-encryption');
    await encryptFiles(images, recipientPath, output, ageBinary);
    await writeFile(join(output, 'summary.txt'), `dev_pages=${images.length}\n`);
  } finally {
    await devContext.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    await devContext.close().catch(() => {});
    await devBrowser.close().catch(() => {});
    await rm(work, { recursive: true, force: true });
  }
  console.log(`capture complete: dev_pages=${images.length}`);
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
