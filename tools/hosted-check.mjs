import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEV_HOST = 'iammufc-dev.aaron-cf2.workers.dev';
const REVISION_RE = /^[0-9a-f]{40}$/;
const CHECKS = ['http_status', 'page_identity', 'no_horizontal_overflow', 'tab_nav', 'tab_form_controls', 'tab_submit', 'focus_visible'];

export function validateHostedInputs(env) {
  const route = env.HOSTED_ROUTE ?? '';
  const revision = env.HOSTED_REVISION ?? '';
  const requireForm = env.REQUIRE_FORM !== 'false';
  if (!/^\/[A-Za-z0-9/_-]*$/.test(route) || route.includes('..') || /^\/(en|es)(\/|$)/.test(route)) throw new Error('invalid hosted route');
  if (revision && !REVISION_RE.test(revision)) throw new Error('invalid hosted revision');
  if (!env.CF_ACCESS_CLIENT_ID || !env.CF_ACCESS_CLIENT_SECRET) throw new Error('missing Access credentials');
  return { route, revision, requireForm };
}

export function isDevRequest(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === DEV_HOST;
  } catch { return false; }
}

// Keep the Access handler local so routine hosted checks do not import capture machinery.
export function accessHeadersFor(url, headers, credentials) {
  if (!isDevRequest(url)) return headers;
  const kept = Object.fromEntries(Object.entries(headers).filter(([name]) => !['origin', 'sec-fetch-site'].includes(name.toLowerCase())));
  return { ...kept, origin: `https://${DEV_HOST}`, 'sec-fetch-site': 'same-origin', 'cf-access-client-id': credentials.id, 'cf-access-client-secret': credentials.secret };
}

async function emit(result, summaryPath) {
  const line = JSON.stringify(result);
  console.log(line);
  if (summaryPath) await appendFile(summaryPath, `${line}\n`);
}

async function focusSnapshot(locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outline: style.outline, boxShadow: style.boxShadow };
  });
}

async function focusCheck(locator, before) {
  return locator.evaluate((element, previous) => {
    if (!element.matches(':focus-visible')) return false;
    const style = getComputedStyle(element);
    return style.outline !== previous.outline || style.boxShadow !== previous.boxShadow;
  }, before);
}

async function tabTo(page, target) {
  if (await target.evaluate((element) => element === document.activeElement).catch(() => false)) return true;
  for (let i = 0; i < 80; i += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((element) => element === document.activeElement)) return true;
  }
  return false;
}

export async function run(deps = {}) {
  const env = deps.env ?? process.env;
  const input = validateHostedInputs(env);
  const chromium = deps.chromium ?? (await import('playwright')).chromium;
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const summaryPath = env.GITHUB_STEP_SUMMARY;
  if (summaryPath) await appendFile(summaryPath, '\n### Hosted keyboard checks\n\n```json\n');
  try {
    for (const locale of ['en', 'es']) {
      for (const viewport of [{ width: 1280, height: 900 }, { width: 320, height: 800 }, { width: 375, height: 812 }]) {
        const context = await browser.newContext({ viewport, locale });
        try {
          await context.route('**/*', async (route) => {
            try {
              const url = route.request().url();
              if (!isDevRequest(url)) return await route.abort('blockedbyclient');
              return await route.fulfill({ response: await route.fetch({ headers: accessHeadersFor(url, route.request().headers(), { id: env.CF_ACCESS_CLIENT_ID, secret: env.CF_ACCESS_CLIENT_SECRET }), maxRedirects: 0 }) });
            } catch { await Promise.resolve(route.abort()).catch(() => {}); }
          });
          const page = await context.newPage();
          const url = `https://${DEV_HOST}/${locale}${input.route}`;
          let response;
          try { response = await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 }); }
          catch { response = null; }
          const status = response?.status() ?? 0;
          const identity = await page.evaluate(({ host, path, localeCode }) => location.hostname === host && location.pathname === path && document.documentElement.lang.toLowerCase().startsWith(localeCode), { host: DEV_HOST, path: `/${locale}${input.route}`, localeCode: locale }).catch(() => false);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth).catch(() => false);
          const nav = page.locator('nav a, nav button').first();
          const formControls = page.locator('form :is(input,select,textarea,button):not([type="hidden"]):not([disabled])');
          const allControlCount = await formControls.count().catch(() => 0);
          const controls = [];
          const radioGroups = new Set();
          for (let i = 0; i < allControlCount; i += 1) {
            const control = formControls.nth(i);
            const info = await control.evaluate((element) => ({ type: element.getAttribute('type'), name: element.getAttribute('name'), checked: element.checked })).catch(() => null);
            if (!info) continue;
            if (info.type === 'radio' && info.name) {
              if (radioGroups.has(info.name)) continue;
              radioGroups.add(info.name);
              const checked = page.locator(`form input[type="radio"][name=${JSON.stringify(info.name)}]:checked`).first();
              controls.push(await checked.count() ? checked : control);
            } else if (info.type !== 'radio') controls.push(control);
          }
          const controlsCount = controls.length;
          const submit = page.locator('form button[type="submit"], form input[type="submit"]').last();
          let tabNav = false;
          let tabControls = false;
          let tabSubmit = false;
          let focusVisible = false;
          if (identity && await nav.count()) {
            const navBefore = await focusSnapshot(nav).catch(() => null);
            await page.keyboard.press('Tab').catch(() => {});
            tabNav = await nav.evaluate((element) => element === document.activeElement).catch(() => false);
            const focusResults = [];
            if (tabNav && navBefore) focusResults.push(await focusCheck(nav, navBefore).catch(() => false));
            else focusResults.push(false);
            if (tabNav && controlsCount > 0) {
              tabControls = true;
              const submitBefore = await focusSnapshot(submit).catch(() => null);
              for (let i = 0; i < controlsCount; i += 1) {
                const control = controls[i];
                const before = await focusSnapshot(control).catch(() => null);
                const reached = await tabTo(page, control);
                if (!reached) { tabControls = false; focusResults.push(false); break; }
                focusResults.push(before ? await focusCheck(control, before).catch(() => false) : false);
              }
              tabSubmit = await tabTo(page, submit).catch(() => false);
              focusResults.push(tabSubmit && submitBefore ? await focusCheck(submit, submitBefore).catch(() => false) : false);
            }
            focusVisible = focusResults.length > 0 && focusResults.every(Boolean);
          }
          const values = {
            http_status: status === 200,
            page_identity: identity,
            no_horizontal_overflow: overflow,
            tab_nav: tabNav,
            tab_form_controls: input.requireForm ? controlsCount > 0 && tabControls : true,
            tab_submit: input.requireForm ? Boolean(await submit.count()) && tabSubmit : true,
            focus_visible: focusVisible,
          };
          for (const check of CHECKS) {
            const result = { revision: input.revision, route: input.route, locale, viewport: `${viewport.width}x${viewport.height}`, check, pass: values[check] };
            results.push(result);
            await emit(result, summaryPath);
          }
        } finally { await context.close(); }
      }
    }
  } finally {
    await browser.close();
    if (summaryPath) await appendFile(summaryPath, '```\n');
  }
  if (results.some((result) => !result.pass)) throw new Error('hosted check failed');
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().catch(() => { console.error('hosted check failed'); process.exit(1); });
}
