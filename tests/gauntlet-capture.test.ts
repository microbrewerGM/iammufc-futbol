import { describe, expect, it } from 'vitest';
const fsModule: string = 'node:fs';
const { readFileSync } = await import(fsModule) as { readFileSync(path: URL, encoding: 'utf8'): string };
import { accessHeadersFor, captureViewports, cropBox, isBarUrl, isDevRequest, pairSides, planCapture, validateBarList, validateInputs } from '../scripts/gauntlet-capture.mjs';

const valid = { QUESTION_ID: 'Q-HOME-AWAY', DEV_ROUTE: '/en/compare', REVISION: 'a'.repeat(40), OVERRIDE: '', CF_ACCESS_CLIENT_ID: 'client-id-test', CF_ACCESS_CLIENT_SECRET: 'known-secret-test' };

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

  it('limits bars to the two approved hosts', () => {
    expect(isBarUrl('https://fbref.com/en/squads/')).toBe(true);
    expect(isBarUrl('https://www.transfermarkt.com/')).toBe(true);
    expect(isBarUrl('https://transfermarkt.com/')).toBe(false);
    expect(isBarUrl('https://example.com/')).toBe(false);
  });

  it('loads selected question bars with only ids and URLs and rejects non-allowlisted hosts', async () => {
    const bars = JSON.parse(readFileSync(new URL('../gauntlet/bars.json', import.meta.url), 'utf8')) as Record<string, string[]>;
    expect(Object.keys(bars).sort()).toEqual(['Q-ARRIVAL-MANAGER', 'Q-ASK-EXAMPLES', 'Q-EUROPE-HISTORY', 'Q-HEAD-TO-HEAD', 'Q-MANAGER-ERAS', 'Q-PER90-LEADERS', 'Q-PLAYER-TREND', 'Q-SEASON-SPLITS'].sort());
    for (const [id, urls] of Object.entries(bars)) {
      expect(id).toMatch(/^Q-/);
      expect(urls.every(isBarUrl)).toBe(true);
    }
    expect(() => validateBarList({ 'Q-TEST': ['https://evil.example/path'] })).toThrow(/bar list/);
  });

  it('crops content and pairs with an independent coin byte', () => {
    expect(cropBox(1280, 900)).toEqual({ x: 38, y: 96, width: 1203, height: 768 });
    expect(pairSides(0)).toEqual({ ours: 'A', bar: 'B' });
    expect(pairSides(1)).toEqual({ ours: 'B', bar: 'A' });
  });

  it('defines EN, ES and 320 px views, and enforces page and example ask caps', () => {
    expect(captureViewports().map(({ name, locale, width }) => [name, locale, width])).toEqual([
      ['en', 'en', 1280], ['es', 'es', 1280], ['mobile', null, 320],
    ]);
    expect(planCapture('Q-ASK-EXAMPLES', ['https://fbref.com/', 'https://www.transfermarkt.com/'], Array.from({ length: 8 }, (_, i) => `ask ${i}`)).asks).toHaveLength(6);
    expect(() => planCapture('Q-SEASON-SPLITS', ['https://fbref.com/', 'https://www.transfermarkt.com/', 'https://fbref.com/3'])).toThrow(/budget/);
    expect(planCapture('Q-ASK-EXAMPLES', ['https://fbref.com/', 'https://www.transfermarkt.com/']).urls).toHaveLength(2);
  });

  it('does not emit page text, Access material, or client id from captured output', () => {
    const emitted = 'capture complete: bar_pages=2 example_asks=0';
    for (const forbidden of ['known page text', 'CF_Authorization', valid.CF_ACCESS_CLIENT_ID]) expect(emitted).not.toContain(forbidden);
  });
});
