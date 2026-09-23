import { pathToFileURL } from 'node:url';

// Fixed dev target: never forward service credentials to redirects or prod.
const origin = 'https://iammufc-dev.aaron-cf2.workers.dev';

export async function smoke(env, request = fetch) {
  const id = env.CF_ACCESS_CLIENT_ID;
  const secret = env.CF_ACCESS_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Missing dev Access service credentials.');
  const headers = { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret, Origin: origin };
  const cases = [
    { path: '/en', marker: 'Ask about Manchester United' },
    { path: '/es', marker: 'Pregunta sobre el Manchester United' },
    { path: '/style.css', marker: 'font-family' },
    { path: '/en/ask', marker: 'Assists — 2023-24 PL', method: 'POST', body: 'q=Top+assists+2023-24' },
  ];
  const results = [];
  for (const check of cases) {
    const response = await request(origin + check.path, {
      method: check.method ?? 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { ...headers, ...(check.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      ...(check.body ? { body: check.body } : {}),
    });
    const privateResponse = response.headers.get('cache-control')?.includes('no-store');
    // Never print response bodies, response headers, credentials or exceptions.
    const body = await response.text();
    results.push({ path: check.path, status: response.status,
      pass: response.status === 200 && Boolean(privateResponse) && body.includes(check.marker) });
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const results = await smoke(process.env);
    console.log(JSON.stringify(results));
    if (results.some((result) => !result.pass)) process.exitCode = 1;
  } catch {
    console.error('Dev Access smoke failed; check credential provisioning and connectivity. Details suppressed.');
    process.exitCode = 1;
  }
}
