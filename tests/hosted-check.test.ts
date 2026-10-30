import { afterEach, describe, expect, it, vi } from 'vitest';

const DEV_HOST = 'iammufc-dev.aaron-cf2.workers.dev';
const validEnv = {
  HOSTED_ROUTE: '/opponents/history',
  HOSTED_REVISION: 'a'.repeat(40),
  REQUIRE_FORM: 'true',
  CF_ACCESS_CLIENT_ID: 'client-id-sentinel',
  CF_ACCESS_CLIENT_SECRET: 'client-secret-sentinel',
};

function mockBrowser(options: { status?: number; identity?: boolean; overflow?: boolean } = {}) {
  const results: Array<{ route: string; locale: string; viewport: string; check: string; pass: boolean }> = [];
  let focused = false;
  let active: unknown = null;
  const element = (kind: string) => ({ kind });
  const nav = element('nav');
  const controls = [element('control'), element('radio'), element('submit')];
  const locator = (selector: string) => {
    if (selector === 'nav a, nav button') return makeLocator([nav]);
    if (selector === 'form :is(input,select,textarea,button):not([type="hidden"]):not([disabled])') return makeLocator(controls);
    if (selector.includes('input[type="radio"]')) return makeLocator([controls[1]]);
    if (selector === 'form button[type="submit"], form input[type="submit"]') return makeLocator([controls[2]]);
    return makeLocator([]);
  };
  function makeLocator(items: unknown[]) {
    return {
      first() { return makeLocator(items.slice(0, 1)); },
      last() { return makeLocator(items.slice(-1)); },
      nth(index: number) { return makeLocator(items.slice(index, index + 1)); },
      async count() { return items.length; },
      async evaluate(fn: (el: any, arg?: any) => unknown) {
        const item: any = items[0];
        if (!item) throw new Error('missing element');
        if (String(fn).includes('element === document.activeElement')) return item === active;
        if (String(fn).includes('element.getAttribute')) return item.kind === 'radio' ? { type: 'radio', name: 'group', checked: true } : { type: item.kind === 'submit' ? 'submit' : 'text', name: item.kind, checked: false };
        if (String(fn).includes('style.outline')) return focused && item === active ? true : false;
        if (String(fn).includes('getComputedStyle')) return { outline: focused && item === active ? '2px solid blue' : 'none', boxShadow: 'none' };
        if (String(fn).includes('matches')) return focused && item === active;
        return false;
      },
      async focus() { active = items[0]; focused = true; },
    };
  }
  const page = {
    locator,
    keyboard: { async press() { active = active === null ? nav : (active === nav ? controls[0] : (active === controls[0] ? controls[1] : controls[2])); } },
    async goto() { return { status: () => options.status ?? 200 }; },
    async evaluate() { return options.identity === false ? false : true; },
  };
  const context = {
    async route(_pattern: string, handler: (route: any) => Promise<void>) {
      await handler({
        request: () => ({ url: () => `https://${DEV_HOST}/en/opponents/history`, headers: () => ({ origin: 'null', 'sec-fetch-site': 'cross-site' }) }),
        async fulfill() {}, async fetch() { return {}; }, async abort() {},
      });
    },
    async newPage() { return page; },
    async close() {},
  };
  const browser = {
    async newContext() { focused = false; active = null; return context; },
    async close() {},
  };
  const chromium = { async launch() { return browser; } };
  return { chromium, results, page };
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

  it('logs every locale and viewport check as JSON and passes the hosted journey', async () => {
    const mod = await import('../tools/hosted-check.mjs');
    const { chromium } = mockBrowser();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const results = await mod.run({ chromium, env: validEnv });
    expect(results).toHaveLength(42);
    expect(log).toHaveBeenCalledTimes(42);
    for (const [locale, width] of [['en', '1280'], ['en', '320'], ['en', '375'], ['es', '1280'], ['es', '320'], ['es', '375']]) {
      expect(results.some((item) => item.locale === locale && item.viewport.startsWith(`${width}x`) && item.check === 'focus_visible' && item.pass)).toBe(true);
    }
    expect(results.every((item) => item.pass)).toBe(true);
    log.mockRestore();
  });

  it('fails closed on non-200 status and an Access login page identity', async () => {
    const mod = await import('../tools/hosted-check.mjs');
    const status = mockBrowser({ status: 302 });
    await expect(mod.run({ chromium: status.chromium, env: validEnv })).rejects.toThrow('hosted check failed');
    const identity = mockBrowser({ identity: false });
    await expect(mod.run({ chromium: identity.chromium, env: validEnv })).rejects.toThrow('hosted check failed');
  });
});
