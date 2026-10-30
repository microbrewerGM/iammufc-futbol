export function validateHostedInputs(env: Record<string, string | undefined>): {
  route: string;
  revision: string;
  requireForm: boolean;
};
export function isDevRequest(url: string): boolean;
export function accessHeadersFor(
  url: string,
  headers: Record<string, string>,
  credentials: { id: string; secret: string },
): Record<string, string>;
export function run(deps?: { chromium?: unknown; env?: Record<string, string | undefined> }): Promise<Array<{
  revision: string;
  route: string;
  locale: string;
  viewport: string;
  check: string;
  pass: boolean;
}>>;
