import { Hono } from "hono";
import { currentSnapshot, resolvePlayerIdentity, type Env } from "../core/db";
import { mapQuestionVerdict, requestCatalogDigest } from "../core/question-request-intent";
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
  router.post("/answer-now/ack", c => handle(c, resolveCaller, "ack", true));
  router.all("/answer-now/ack", c => c.text("Method not allowed.", 405, { Allow: "POST" }));
  router.post("/answer-now/context", async c => {
    const caller = resolveCaller(c);
    if (!caller || caller.capability !== TRIAGE_CAPABILITY) return c.json({ error: "invalid_caller" }, 403);
    const body = await readBody(c.req.raw);
    if (!body.ok) return c.json({ error: body.status === 413 ? "too_large" : "malformed" }, body.status);
    let request: unknown;
    try { request = JSON.parse(body.raw); } catch { return c.json({ error: "malformed" }, 400); }
    if (!request || typeof request !== "object" || Array.isArray(request) || JSON.stringify(request) !== '{"version":1,"kind":"context","payload":{}}') return c.json({ error: "malformed" }, 400);
    if (!c.env.BRIDGE_CURSOR_KEY) return c.text("Bridge unavailable.", 503);
    try {
      // Schema probe must succeed before a scheduled client claims any question.
      await c.env.DB.prepare("SELECT request_id FROM question_request_results LIMIT 1").all();
      const result = await c.env.DB.prepare("SELECT i.person_id AS id,max(p.web_name) AS label FROM player_identities i JOIN players p ON p.player_id=i.player_id GROUP BY i.person_id ORDER BY i.person_id LIMIT 200").all<{ id: string; label: string }>();
      const people = result.results.filter(p => p.id.length >= 1 && p.id.length <= 64 && /^[a-z0-9]/.test(p.id) && !/[^a-z0-9:_-]/.test(p.id) && p.label.length >= 1 && p.label.length <= 120 && !/[\p{Cc}\p{Cf}]/u.test(p.label));
      return c.json({ version: 1, kind: "answer_now_context", payload: { catalog_digest: await requestCatalogDigest(), people } });
    } catch { return c.text("Bridge unavailable.", 503); }
  });
  router.all("/answer-now/context", c => c.text("Method not allowed.", 405, { Allow: "POST" }));
  return router;
}
async function readBody(request: Request): Promise<{ ok: true; raw: string } | { ok: false; status: 400 | 413 }> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > TRIAGE_MAX_REQUEST_BYTES)) return { ok: false, status: 413 };
  try {
    const reader = request.body?.getReader();
    if (!reader) return { ok: true, raw: "" };
    let size = 0; const chunks: Uint8Array[] = [];
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > TRIAGE_MAX_REQUEST_BYTES) { await reader.cancel(); return { ok: false, status: 413 }; } chunks.push(value); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { ok: true, raw: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes) };
  } catch { return { ok: false, status: 400 }; }
}
async function handle(c: import("hono").Context<QuestionTriageEnv>, resolve: (c: import("hono").Context<QuestionTriageEnv>) => TriageCaller | null, kind: "read" | "claim" | "ack", answerNow = false): Promise<Response> {
  const caller = resolve(c); if (!caller) return c.json({ error: "invalid_caller" }, 403);
  const body = await readBody(c.req.raw);
  if (!body.ok) return c.json({ error: body.status === 413 ? "too_large" : "malformed" }, body.status);
  const raw = body.raw;
  if (!c.env.BRIDGE_CURSOR_KEY) return c.text("Bridge unavailable.", 503);
  const store = new D1QuestionTriageStore(c.env.DB);
  const deps: TriageDeps = { store, cursorKey: new TextEncoder().encode(c.env.BRIDGE_CURSOR_KEY), now: c.env.BRIDGE_NOW ?? (() => new Date()), newLeaseId: c.env.BRIDGE_NEW_LEASE_ID ?? (() => crypto.randomUUID()) };
  if (answerNow) deps.answerNow = async (row, verdict) => {
    const mapped = await mapQuestionVerdict(verdict, { requestId: row.request_id, revision: row.revision+2, locale: row.locale, snapshotId: await currentSnapshot(c.env), resolvePerson: async (id, competition) => (await resolvePlayerIdentity(c.env,id,competition))?.person_id ?? null });
    if (mapped.kind === "ready") return { state: "confirmation_required", specJson: JSON.stringify(mapped.spec), snapshotId: mapped.spec.data_snapshot_id };
    if (mapped.kind === "clarification_required") return { state: "clarification_required", specJson: null, snapshotId: null };
    if (mapped.kind === "unsupported" || mapped.kind === "unavailable") return { state: mapped.kind, specJson: null, snapshotId: null };
    throw new Error("invalid_answer_now_mapping");
  };
  try {
    if (kind !== "ack" && !(await sweepQuestionBeforeRequest(deps))) return c.text("Bridge unavailable.", 503);
    const result = kind === "read" ? await readQuestions(deps, caller, raw) : kind === "claim" ? await claimQuestion(deps, caller, raw) : await ackQuestion(deps, caller, raw);
    if (!result.ok) return c.json({ error: result.error }, result.error === "too_large" ? 413 : result.error === "invalid_caller" ? 403 : 400);
    return new Response(result.body, { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
  } catch { return c.text("Bridge unavailable.", 503); }
}
