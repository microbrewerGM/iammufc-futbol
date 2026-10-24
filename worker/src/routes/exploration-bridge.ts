import { Hono } from "hono";
import { D1BridgeStore } from "../core/exploration-bridge-d1";
import {
  MAX_REQUEST_BYTES,
  ackJob,
  hmacCursorSigner,
  readJobs,
  claimJob,
  type BridgeDeps,
  type Caller,
} from "../core/exploration-bridge";
import type { Env } from "../core/db";
import { accessIdentity, type AccessEnv } from "../security/auth";

/** Internal route bindings supplied by the host after its Access middleware. */
export type ExplorationBridgeEnv = AccessEnv & { Bindings: Env & {
  BRIDGE_CURSOR_KEY?: string;
  BRIDGE_PUBLICATION_VERIFIER?: BridgeDeps["verifier"];
  BRIDGE_NOW?: () => Date;
  BRIDGE_NEW_LEASE_ID?: () => string;
} };

export function createExplorationBridgeRouter(resolveCaller: (c: import("hono").Context<ExplorationBridgeEnv>) => Caller | null = (c) => {
  const identity = accessIdentity(c);
  if (!identity || !("serviceClientId" in identity) ||
    !c.env.ACCESS_SERVICE_CLIENT_IDS?.split(",").map((id) => id.trim()).includes(identity.serviceClientId)) return null;
  if (identity.serviceClientId.includes("_") || /[A-Z]/.test(identity.serviceClientId)) return null;
  const service = identity.serviceClientId.toLowerCase().replace(/\./g, "_");
  if (!/^[a-z0-9][a-z0-9:_-]{0,95}$/.test(service)) return null;
  return { service, capability: "arrival_manager:bridge:v1" };
}) {
  const router = new Hono<ExplorationBridgeEnv>();
  for (const kind of ["read", "claim", "ack"] as const) {
    router.post(`/${kind}`, async (c) => handle(c, resolveCaller, kind));
    router.all(`/${kind}`, (c) => c.text("Method not allowed.", 405, { Allow: "POST" }));
  }
  return router;
}


async function handle(c: import("hono").Context<ExplorationBridgeEnv>, resolveCaller: (c: import("hono").Context<ExplorationBridgeEnv>) => Caller | null,
  kind: "read" | "claim" | "ack"): Promise<Response> {
  const caller = resolveCaller(c);
  if (!caller) {
    return c.json({ error: "invalid_caller" }, 403);
  }
  const lengthHeader = c.req.header("content-length");
  if (lengthHeader !== undefined && (!/^\d+$/.test(lengthHeader) || Number(lengthHeader) > MAX_REQUEST_BYTES)) {
    return c.json({ error: "too_large" }, 413);
  }
  let raw: string;
  try { raw = await c.req.text(); } catch { return c.json({ error: "malformed" }, 400); }
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) return c.json({ error: "too_large" }, 413);
  const key = c.env.BRIDGE_CURSOR_KEY;
  const verifier = c.env.BRIDGE_PUBLICATION_VERIFIER;
  if (!key || !verifier) return c.text("Bridge unavailable.", 503);
  const deps: BridgeDeps = {
    store: new D1BridgeStore(c.env.DB), verifier,
    cursorSigner: hmacCursorSigner(new TextEncoder().encode(key)),
    now: c.env.BRIDGE_NOW ?? (() => new Date()),
    newLeaseId: c.env.BRIDGE_NEW_LEASE_ID ?? (() => crypto.randomUUID()),
  };
  let result;
  try {
    result = kind === "read" ? await readJobs(deps, caller, raw)
      : kind === "claim" ? await claimJob(deps, caller, raw)
        : await ackJob(deps, caller, raw);
  } catch {
    return c.text("Bridge unavailable.", 503);
  }
  if (!result.ok) {
    const status = result.error === "invalid_caller" ? 403 : result.error === "too_large" ? 413 : 400;
    return c.json({ error: result.error }, status);
  }
  return new Response(result.body, { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
}
