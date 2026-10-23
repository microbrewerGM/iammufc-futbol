import { claimJob, readJobs, sweepExpiredLeases, sweepRetryDue } from "../core/exploration-bridge";
import type { BridgeDeps, BridgeResult, Caller } from "../core/exploration-bridge";

export interface SweepResponse {
  status: 200 | 503;
  result: BridgeResult | null;
}

export const MIN_SWEEP_INTERVAL_MS = 60_000;
let lastSweepAt: number | null = null;
let nextSweep: "expired" | "due" = "expired";

function validationError(caller: Caller, raw: unknown, kind: "read" | "claim"): BridgeResult | null {
  if (!caller || typeof caller !== "object" || typeof caller.service !== "string"
    || !/^[a-z0-9][a-z0-9:_-]{0,95}$/.test(caller.service)
    || typeof caller.capability !== "string" || !/^[a-z0-9][a-z0-9:_-]{0,95}$/.test(caller.capability)) {
    return { ok: false, error: "invalid_caller" };
  }
  const bad = (error: "malformed" | "too_large"): BridgeResult => ({ ok: false, error });
  if (typeof raw !== "string") return bad("malformed");
  if (new TextEncoder().encode(raw).length > 64 * 1024) return bad("too_large");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return bad("malformed"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad("malformed");
  const envelope = value as Record<string, unknown>;
  if (Object.keys(envelope).length !== 3 || envelope.version !== 1 || envelope.kind !== kind
    || !envelope.payload || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) return bad("malformed");
  const p = envelope.payload as Record<string, unknown>;
  const closed = (keys: string[]) => Object.keys(p).length === keys.length && keys.every(key => key in p);
  const id = (v: unknown) => typeof v === "string" && /^[a-z0-9][a-z0-9:_-]{0,95}$/.test(v);
  const hash = (v: unknown) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
  if (kind === "read") {
    if (!closed(["cursor", "limit"]) || !Number.isInteger(p.limit) || (p.limit as number) < 1
      || (p.limit as number) > 20 || (p.cursor !== null && typeof p.cursor !== "string")) return bad("malformed");
    if (p.cursor !== null && !/^c3:[0-9a-f]{32}:(0|[1-9a-z][0-9a-z]{0,10}):(0|[1-9a-z][0-9a-z]{0,49})$/.test(p.cursor as string)) {
      return { ok: false, error: "invalid_cursor" };
    }
  } else if (!closed(["job_id", "expected_attempt", "operation_id"]) || !hash(p.job_id)
    || !Number.isInteger(p.expected_attempt) || (p.expected_attempt as number) < 0 || (p.expected_attempt as number) > 2
    || !id(p.operation_id)) return bad("malformed");
  return null;
}

/** At most one bounded maintenance sweep per request, with a process-wide interval gate. */
export async function sweepBeforeRequest(deps: BridgeDeps): Promise<boolean> {
  const now = deps.now().getTime();
  if (lastSweepAt !== null && now - lastSweepAt < MIN_SWEEP_INTERVAL_MS) return true;
  const kind = nextSweep;
  lastSweepAt = now;
  nextSweep = kind === "expired" ? "due" : "expired";
  try {
    if (kind === "expired") await sweepExpiredLeases(deps);
    else await sweepRetryDue(deps);
    return true;
  } catch {
    return false;
  }
}

export function resetSweepThrottleForTest(): void {
  lastSweepAt = null;
  nextSweep = "expired";
}

async function readValidationError(deps: BridgeDeps, caller: Caller, raw: unknown): Promise<BridgeResult | null> {
  const error = validationError(caller, raw, "read");
  if (error) return error;
  const envelope = JSON.parse(raw as string) as { payload: { cursor: string | null } };
  if (envelope.payload.cursor === null) return null;
  const match = /^c3:([0-9a-f]{32}):(0|[1-9a-z][0-9a-z]{0,10}):(0|[1-9a-z][0-9a-z]{0,49})$/.exec(envelope.payload.cursor);
  if (!match) return { ok: false, error: "invalid_cursor" };
  try {
    let n = 0n;
    for (const c of match[3]!) n = n * 36n + BigInt(parseInt(c, 36));
    const ms = parseInt(match[2]!, 36);
    const jobId = n.toString(16).padStart(64, "0");
    if (n >= (1n << 256n) || !Number.isSafeInteger(ms) || ms < 0 || ms.toString(36) !== match[2]
      || n.toString(36) !== match[3] || !/^[0-9a-f]{64}$/.test(jobId)) return { ok: false, error: "invalid_cursor" };
    const positionTime = new Date(ms).toISOString();
    const message = `${caller.service}\n${caller.capability}\n${positionTime}\n${jobId}`;
    if (!(await deps.cursorSigner.verify(message, match[1]!))) return { ok: false, error: "invalid_cursor" };
    return null;
  } catch { return { ok: false, error: "invalid_cursor" }; }
}

export async function readJobsAfterSweep(deps: BridgeDeps, caller: Caller, raw: unknown): Promise<SweepResponse> {
  const error = await readValidationError(deps, caller, raw);
  if (error) return { status: 200, result: error };
  if (!(await sweepBeforeRequest(deps))) return { status: 503, result: null };
  try { return { status: 200, result: await readJobs(deps, caller, raw) }; }
  catch { return { status: 503, result: null }; }
}

export async function claimJobAfterSweep(deps: BridgeDeps, caller: Caller, raw: unknown): Promise<SweepResponse> {
  const error = validationError(caller, raw, "claim");
  if (error) return { status: 200, result: error };
  if (!(await sweepBeforeRequest(deps))) return { status: 503, result: null };
  try { return { status: 200, result: await claimJob(deps, caller, raw) }; }
  catch { return { status: 503, result: null }; }
}
