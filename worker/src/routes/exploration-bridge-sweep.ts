import { claimJob, readJobs, sweepExpiredLeases, sweepRetryDue } from "../core/exploration-bridge";
import type { BridgeDeps, BridgeResult, Caller } from "../core/exploration-bridge";

export interface SweepResponse {
  status: 200 | 503;
  result: BridgeResult | null;
}

/** Run both bounded maintenance sweeps before servicing a bridge read or claim. */
export async function sweepBeforeRequest(deps: BridgeDeps): Promise<boolean> {
  try {
    await sweepExpiredLeases(deps);
    await sweepRetryDue(deps);
    return true;
  } catch {
    // Storage exceptions can contain query details; keep them server-side.
    return false;
  }
}

/** Route-layer entry point for reads: maintenance always precedes the core read. */
export async function readJobsAfterSweep(deps: BridgeDeps, caller: Caller, raw: unknown): Promise<SweepResponse> {
  if (!(await sweepBeforeRequest(deps))) return { status: 503, result: null };
  try {
    return { status: 200, result: await readJobs(deps, caller, raw) };
  } catch {
    return { status: 503, result: null };
  }
}

/** Route-layer entry point for claims: maintenance always precedes the core claim. */
export async function claimJobAfterSweep(deps: BridgeDeps, caller: Caller, raw: unknown): Promise<SweepResponse> {
  if (!(await sweepBeforeRequest(deps))) return { status: 503, result: null };
  try {
    return { status: 200, result: await claimJob(deps, caller, raw) };
  } catch {
    return { status: 503, result: null };
  }
}
