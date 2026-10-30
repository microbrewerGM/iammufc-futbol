import { afterEach, describe, expect, it, vi } from 'vitest';

const DEV_HOST = 'iammufc-dev.aaron-cf2.workers.dev';
const nodeModuleName: string = 'node:module';
const fsPromisesName: string = 'node:fs/promises';
const nodeRequire: any = (globalThis as any).process.mainModule?.require ?? (await import(nodeModuleName) as any).createRequire(`${process.cwd()}/package.json`);
const os: any = nodeRequire('node:os');
const path: any = nodeRequire('node:path');
const vm: any = (globalThis as any).process.mainModule?.require('node:vm') ?? (await import(nodeModuleName) as any).createRequire(`${process.cwd()}/package.json`)('node:vm');
const validEnv = {
  HOSTED_ROUTE: '/opponents/history',
  HOSTED_REVISION: 'a'.repeat(40),
  REQUIRE_FORM: 'true',
  CF_ACCESS_CLIENT_ID: 'client-id-sentinel',
  CF_ACCESS_CLIENT_SECRET: 'client-secret-sentinel',
};

function mockBrowser(options: { status?: number; identity?: boolean; abortNavigation?: boolean; noOutlineFor?: string[] } = {}) {
  const elements = [{ kind: 'nav' }, { kind: 'control' }, { kind: 'radio' }, { kind: 'submit' }];
  let active: any = null;
  let keyboardModality = false;
  const styleFor = (item: any) => active === item && !options.noOutlineFor?.includes(item.kind)
    ? { outline: '2px solid blue', boxShadow: 'none' }
    : { outline: 'none', boxShadow: 'none' };
  const locator = (selector: string) => {
    if (selector === 'nav a, nav button') return makeLocator([elements[0]]);
    if (selector === 'form :is(input,select,textarea,button):not([type="hidden"]):not([disabled])') return makeLocator([elements[1], elements[2], elements[3]]);
    if (selector.includes('input[type="radio"]')) return makeLocator([elements[2]]);
    if (selector === 'form button[type="submit"], form input[type="submit"]') return makeLocator([elements[3]]);
    return makeLocator([]);
  };
  function makeLocator(items: any[]) {
    return {
      first() { return makeLocator(items.slice(0, 1)); },
      last() { return makeLocator(items.slice(-1)); },
      nth(index: number) { return makeLocator(items.slice(index, index + 1)); },
      async count() { return items.length; },
      async evaluate(fn: (el: any, arg?: any) => unknown, arg?: any) {
        const item = items[0];
        if (!item) throw new Error('missing element');
        if (fn.toString().includes('element.getAttribute')) return item.kind === 'radio' ? { type: 'radio', name: 'group', checked: true } : { type: item.kind === 'submit' ? 'submit' : 'text', name: item.kind, checked: false };
        return vm.runInNewContext(`element.matches = (selector) => selector === ':focus-visible' && element === document.activeElement && keyboardModality; (${fn.toString()})(element, argument)`, { element: item, argument: arg, document: { get activeElement() { return active; } }, get keyboardModality() { return keyboardModality; }, getComputedStyle: styleFor });
      },
    };
  }
  const page = {
    locator,
    keyboard: { async press() { keyboardModality = true; active = active === null ? elements[0] : elements[Math.min(elements.indexOf(active) + 1, elements.length - 1)]; } },
    async goto() { if (options.abortNavigation) throw new Error('navigation aborted'); return { status: () => options.status ?? 200 }; },
    async evaluate(fn: (arg?: any) => unknown, arg?: any) {
      const location = { hostname: DEV_HOST, pathname: '/en/opponents/history' };
      const document = { documentElement: { lang: 'en', scrollWidth: 320, clientWidth: 320 } };
      const window = { innerWidth: 320 };
      const code = String(arg?.localeCode ?? 'en');
      location.pathname = `/${options.identity === false ? 'wrong' : code}/opponents/history`;
      document.documentElement.lang = options.identity === false ? 'wrong' : code;
      return vm.runInNewContext(`(${fn.toString()})(argument)`, { argument: arg, location, document, window });
    },
  };
  const context = {
    async route(_pattern: string, handler: (route: any) => Promise<void>) {
      await handler({ request: () => ({ url: () => `https://${DEV_HOST}/en/opponents/history`, headers: () => ({ origin: 'null' }) }), async fulfill() {}, async fetch() { return {}; }, async abort() {} });
    },
    async newPage() { return page; },
    async close() {},
  };
  const browser = { async newContext() { active = null; keyboardModality = false; return context; }, async close() {} };
  return { chromium: { async launch() { return browser; } } };
}

afterEach(() => vi.resetModules());

describe('hosted-check', () => {
  it('validates route and revision before browsing', async () => {
    const mod = await import('../tools/hosted-check.mjs');
    expect(() => mod.validateHostedInputs(validEnv)).not.toThrow();
    expect(() => mod.validateHostedInputs({ ...validEnv, HOSTED_ROUTE: '/../../etc' })).toThrow();
    expect(() => mod.validateHostedInputs({ ...validEnv, HOSTED_REVISION: 'main' })).toThrow();
  });

  it('copies the capture Access header policy for the development host only', async () => {
    const mod = await import('../tools/hosted-check.mjs');
    expect(mod.accessHeadersFor(`https://${DEV_HOST}/x`, { origin: 'null', 'sec-fetch-site': 'cross-site', accept: 'text/html' }, { id: 'id', secret: 'secret' })).toEqual({
      accept: 'text/html', origin: `https://${DEV_HOST}`, 'sec-fetch-site': 'same-origin', 'cf-access-client-id': 'id', 'cf-access-client-secret': 'secret',
    });
    expect(mod.accessHeadersFor('https://example.com', { accept: 'text/html' }, { id: 'id', secret: 'secret' })).toEqual({ accept: 'text/html' });
  });

  it('logs revision-tagged JSON and checks focus-visible on every Tab target', async () => {
    const mod = await import('../tools/hosted-check.mjs');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let results: any[];
    try { results = await mod.run({ chromium: mockBrowser().chromium, env: validEnv }); }
    catch (error) { throw new Error(`${String(error)} | ${log.mock.calls.map(([line]) => line).filter((line: any) => line && !JSON.parse(line).pass).join(' ')}`); }
    expect(results).toHaveLength(42);
    expect(results.every((item) => item.pass && item.revision === validEnv.HOSTED_REVISION)).toBe(true);
    expect(log).toHaveBeenCalledTimes(42);
    log.mockRestore();
  });

  it('fails focus_visible for the specific radio or nav context without a focus indicator', async () => {
    const mod = await import('../tools/hosted-check.mjs');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      for (const noOutlineFor of [['radio'], ['nav']]) {
        log.mockClear();
        await expect(mod.run({ chromium: mockBrowser({ noOutlineFor }).chromium, env: validEnv })).rejects.toThrow('hosted check failed');
        const failures = log.mock.calls.map(([line]) => JSON.parse(String(line))).filter((result) => !result.pass);
        expect(failures).toHaveLength(6);
        expect(failures.every((result) => result.check === 'focus_visible')).toBe(true);
        expect(new Set(failures.map((result) => result.locale))).toEqual(new Set(['en', 'es']));
      }
    } finally { log.mockRestore(); }
  });

  it("passes focus_visible when REQUIRE_FORM is 'false'", async () => {
    const mod = await import('../tools/hosted-check.mjs');
    const results = await mod.run({ chromium: mockBrowser().chromium, env: { ...validEnv, REQUIRE_FORM: 'false' } });
    expect(results).toHaveLength(42);
    expect(results.every((result) => result.pass)).toBe(true);
  });

  it('fails closed on status, identity, and aborted navigation without exposing credentials', async () => {
    const mod = await import('../tools/hosted-check.mjs');
    await expect(mod.run({ chromium: mockBrowser({ status: 302 }).chromium, env: validEnv })).rejects.toThrow('hosted check failed');
    await expect(mod.run({ chromium: mockBrowser({ identity: false }).chromium, env: validEnv })).rejects.toThrow('hosted check failed');
    const summary = path.join(os.tmpdir(), 'hosted-check-summary-test.md');
    const fs: any = await import(fsPromisesName);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(mod.run({ chromium: mockBrowser({ abortNavigation: true }).chromium, env: { ...validEnv, GITHUB_STEP_SUMMARY: summary } })).rejects.toThrow('hosted check failed');
      const output = [...log.mock.calls, ...error.mock.calls].flat().join('\n');
      const summaryText = await fs.readFile(summary, 'utf8');
      expect(output).not.toContain(validEnv.CF_ACCESS_CLIENT_ID);
      expect(output).not.toContain(validEnv.CF_ACCESS_CLIENT_SECRET);
      expect(summaryText).not.toContain(validEnv.CF_ACCESS_CLIENT_ID);
      expect(summaryText).not.toContain(validEnv.CF_ACCESS_CLIENT_SECRET);
    } finally {
      log.mockRestore();
      error.mockRestore();
      await fs.rm(summary, { force: true });
    }
  });
});
