export function validateInputs(env: Record<string, string | undefined>): { question: string; route: string; revision: string; override: string };
export function isDevRequest(url: string): boolean;
export function accessHeadersFor(url: string, headers: Record<string, string>, credentials: { id: string; secret: string }): Record<string, string>;
export function cropBox(width: number, height: number): { x: number; y: number; width: number; height: number };
export function captureViewports(): Array<{ name: string; locale: string | null; width: number; height: number }>;
export function encryptFiles(files: Array<{ name: string; path: string }>, recipientPath: string, outputDir: string, ageBinary?: string): Promise<void>;
export function run(deps?: { chromium?: unknown; paths?: { recipientPath?: string; outputDir?: string; tempDir?: string }; ageBinary?: string; env?: Record<string, string | undefined> }): Promise<void>;
export function installFatalHandlers(): void;
