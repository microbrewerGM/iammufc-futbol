import { Hono } from "hono";
import type { Env } from "../core/db";
import { ackQuestion, claimQuestion, readQuestions, TRIAGE_CAPABILITY, TRIAGE_MAX_REQUEST_BYTES, type TriageCaller, type TriageDeps } from "../core/question-triage-bridge";
import { accessIdentity, type AccessEnv } from "../security/auth";
import { D1QuestionTriageStore, sweepQuestionBeforeRequest } from "./question-triage-sweep";

export type QuestionTriageEnv = AccessEnv & { Bindings: Env & { BRIDGE_CURSOR_KEY?: string; BRIDGE_NOW?: () => Date; BRIDGE_NEW_LEASE_ID?: () => string } };
export function createQuestionTriageBridgeRouter(resolveCaller: (c: import("hono").Context<QuestionTriageEnv>) => TriageCaller | null = c => {
  const identity = accessIdentity(c);
  if (!identity || !("serviceClientId" in identity) || !c.env.ACCESS_SERVICE_CLIENT_IDS?.split(",").map(x => x.trim()).includes(identity.serviceClientId)) return null;
  if (identity.serviceClientId.includes("_") || /[A-Z]/.test(identity.serviceClientId)) return null;
  const service = identity.serviceClientId.toLowerCase().replace(/\./g, "_");
  return /^[a-z0-9][a-z0-9:_-]{0,95}$/.test(service) ? { service, capability: TRIAGE_CAPABILITY } : null;
}) {
  const router = new Hono<QuestionTriageEnv>();
  for (const kind of ["read", "claim", "ack"] as const) {
    router.post(`/${kind}`, c => handle(c, resolveCaller, kind));
    router.all(`/${kind}`, c => c.text("Method not allowed.", 405, { Allow: "POST" }));
  }
  return router;
}
async function handle(c: import("hono").Context<QuestionTriageEnv>, resolve: (c: import("hono").Context<QuestionTriageEnv>) => TriageCaller | null, kind: "read" | "claim" | "ack"): Promise<Response> {
  const caller = resolve(c); if (!caller) return c.json({ error: "invalid_caller" }, 403);
  const length = c.req.header("content-length"); if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > TRIAGE_MAX_REQUEST_BYTES)) return c.json({ error: "too_large" }, 413);
  let raw: string; try { raw = await c.req.text(); } catch { return c.json({ error: "malformed" }, 400); }
  if (new TextEncoder().encode(raw).length > TRIAGE_MAX_REQUEST_BYTES) return c.json({ error: "too_large" }, 413);
  if (!c.env.BRIDGE_CURSOR_KEY) return c.text("Bridge unavailable.", 503);
  const store = new D1QuestionTriageStore(c.env.DB);
  const deps: TriageDeps = { store, cursorKey: new TextEncoder().encode(c.env.BRIDGE_CURSOR_KEY), now: c.env.BRIDGE_NOW ?? (() => new Date()), newLeaseId: c.env.BRIDGE_NEW_LEASE_ID ?? (() => crypto.randomUUID()) };
  try {
    if (kind !== "ack" && !(await sweepQuestionBeforeRequest(deps))) return c.text("Bridge unavailable.", 503);
    const result = kind === "read" ? await readQuestions(deps, caller, raw) : kind === "claim" ? await claimQuestion(deps, caller, raw) : await ackQuestion(deps, caller, raw);
    if (!result.ok) return c.json({ error: result.error }, result.error === "too_large" ? 413 : result.error === "invalid_caller" ? 403 : 400);
    return new Response(result.body, { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
  } catch { return c.text("Bridge unavailable.", 503); }
}
