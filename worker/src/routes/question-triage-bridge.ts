import { Hono } from "hono";
import compiledCatalog from "../generated/catalog.json";
import { readQuestionGlossary } from "../core/question-request-glossary";
import {handleNotification} from "../core/question-request-notifications";
import { currentSnapshot, resolvePlayerIdentity, type Env } from "../core/db";
import { mapQuestionVerdict, requestCatalogDigest } from "../core/question-request-intent";
import { ackQuestion, claimQuestion, readQuestions, TRIAGE_CAPABILITY, TRIAGE_MAX_REQUEST_BYTES, validTriageSnapshotId, type TriageCaller, type TriageDeps } from "../core/question-triage-bridge";
import { accessIdentity, type AccessEnv } from "../security/auth";
import { D1QuestionTriageStore, sweepQuestionBeforeRequest } from "./question-triage-sweep";
import { executeQuestionResult,readQuestionResults,requestExecutionDeps } from "../core/question-request-execution";

export type QuestionTriageEnv = AccessEnv & { Bindings: Env & { BRIDGE_CURSOR_KEY?: string; BRIDGE_NOW?: () => Date; BRIDGE_NEW_LEASE_ID?: () => string } };
export function createQuestionTriageBridgeRouter(resolveCaller: (c: import("hono").Context<QuestionTriageEnv>) => TriageCaller | null = c => {
  const identity = accessIdentity(c);
  if (!identity || !("serviceClientId" in identity) || !c.env.ACCESS_SERVICE_CLIENT_IDS?.split(",").map(x => x.trim()).includes(identity.serviceClientId)) return null;
  if (identity.serviceClientId.includes("_") || /[A-Z]/.test(identity.serviceClientId)) return null;
  const service = identity.serviceClientId.toLowerCase().replace(/\./g, "_");
  return /^[a-z0-9][a-z0-9:_-]{0,95}$/.test(service) ? { service, capability: TRIAGE_CAPABILITY } : null;
}) {
  const router = new Hono<QuestionTriageEnv>();
  for(const kind of ["read","prepare","check","bind","ack"] as const){
    router.post(`/answer-now/notifications/${kind}`,async c=>{
      const caller=resolveCaller(c);if(!caller || caller.capability!==TRIAGE_CAPABILITY)return c.json({error:"invalid_caller"},403);
      const raw=await readBody(c.req.raw,8192);if(!raw.ok)return c.json({error:raw.status===413?"too_large":"malformed"},raw.status);
      const result=await handleNotification(c.env,caller,kind,raw.raw,c.env.BRIDGE_NEW_LEASE_ID);
      return new Response(result.body,{status:result.status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
    });
    router.all(`/answer-now/notifications/${kind}`,c=>c.text("Method not allowed.",405,{Allow:"POST"}));
  }
  for (const kind of ["read", "claim", "ack"] as const) {
    router.post(`/${kind}`, c => handle(c, resolveCaller, kind));
    router.all(`/${kind}`, c => c.text("Method not allowed.", 405, { Allow: "POST" }));
  }
  for (const kind of ["read","claim"] as const) {
    router.post(`/answer-now/${kind}`,c=>handle(c,resolveCaller,kind,true,2));
    router.all(`/answer-now/${kind}`,c=>c.text("Method not allowed.",405,{Allow:"POST"}));
  }
  router.post("/answer-now/ack", c => handle(c, resolveCaller, "ack", true,"auto"));
  router.all("/answer-now/ack", c => c.text("Method not allowed.", 405, { Allow: "POST" }));
  router.post("/answer-now/context", async c => {
    const caller = resolveCaller(c);
    if (!caller || caller.capability !== TRIAGE_CAPABILITY) return c.json({ error: "invalid_caller" }, 403);
    const body = await readBody(c.req.raw);
    if (!body.ok) return c.json({ error: body.status === 413 ? "too_large" : "malformed" }, body.status);
    let request: unknown;
    try { request = JSON.parse(body.raw); } catch { return c.json({ error: "malformed" }, 400); }
    if (!request || typeof request !== "object" || Array.isArray(request)) return c.json({ error: "malformed" }, 400);
    const envelope = request as Record<string, unknown>;
    if (Object.keys(envelope).length !== 3 || !["version","kind","payload"].every(k=>Object.hasOwn(envelope,k)) || envelope.version !== 1 || envelope.kind !== "context" || !envelope.payload || typeof envelope.payload !== "object" || Array.isArray(envelope.payload) || Object.keys(envelope.payload).length !== 0) return c.json({ error: "malformed" }, 400);
    if (!c.env.BRIDGE_CURSOR_KEY) return c.text("Bridge unavailable.", 503);
    try {
      // Schema probe must succeed before a scheduled client claims any question.
      if (!await answerNowSchemaReady(c.env)) return c.text("Bridge unavailable.",503);
      const result = await c.env.DB.prepare("SELECT i.person_id AS id,max(p.web_name) AS label FROM player_identities i JOIN players p ON p.player_id=i.player_id GROUP BY i.person_id ORDER BY i.person_id LIMIT 201").all<{ id: string; label: string }>();
      const people = result.results.slice(0,200).filter(p => p.id.length >= 1 && p.id.length <= 64 && /^[a-z0-9]/.test(p.id) && !/[^a-z0-9:_-]/.test(p.id) && p.label.length >= 1 && p.label.length <= 120 && !/[\p{Cc}\p{Cf}]/u.test(p.label));
      const catalogJson=JSON.stringify(compiledCatalog),snapshot=await currentSnapshot(c.env);
      if(new TextEncoder().encode(catalogJson).byteLength>65536 || !validTriageSnapshotId(snapshot))return c.text("Bridge unavailable.",503);
      const response=JSON.stringify({ version: 1, kind: "answer_now_context", payload: { triage_protocol:2,glossary_protocol:1,catalog_json:catalogJson,snapshot_id:snapshot,catalog_digest: await requestCatalogDigest(), people, has_more: result.results.length > 200 } });
      if(new TextEncoder().encode(response).byteLength>128*1024)return c.text("Bridge unavailable.",503);
      return new Response(response,{headers:{"Content-Type":"application/json; charset=utf-8"}});
    } catch { return c.text("Bridge unavailable.", 503); }
  });
  router.all("/answer-now/context", c => c.text("Method not allowed.", 405, { Allow: "POST" }));
  router.post("/answer-now/glossary",async c=>{
    const caller=resolveCaller(c);
    if(!caller || caller.capability!==TRIAGE_CAPABILITY)return c.json({error:"invalid_caller"},403);
    const body=await readBody(c.req.raw,4096);
    if(!body.ok)return c.json({error:body.status===413?"too_large":"malformed"},body.status);
    if(!c.env.BRIDGE_CURSOR_KEY)return c.text("Bridge unavailable.",503);
    try{
      if(!await answerNowSchemaReady(c.env))return c.text("Bridge unavailable.",503);
      const result=await readQuestionGlossary(c.env,caller,new TextEncoder().encode(c.env.BRIDGE_CURSOR_KEY),body.raw);
      return result.ok?new Response(result.body,{headers:{"Content-Type":"application/json; charset=utf-8"}}):c.json({error:result.error},result.status);
    }catch{return c.text("Bridge unavailable.",503);}
  });
  router.all("/answer-now/glossary",c=>c.text("Method not allowed.",405,{Allow:"POST"}));
  for (const kind of ["execute","results"] as const) {
    router.post(`/answer-now/${kind}`,async c=>{
      const caller=resolveCaller(c);
      if (!caller || caller.capability!==TRIAGE_CAPABILITY) return c.json({error:"invalid_caller"},403);
      const body=await readBody(c.req.raw,1024);
      if (!body.ok) return c.json({error:body.status===413?"too_large":"malformed"},body.status);
      let request:unknown;
      try {request=JSON.parse(body.raw);} catch {return c.json({error:"malformed"},400);}
      if (!request || typeof request!=="object" || Array.isArray(request)) return c.json({error:"malformed"},400);
      const envelope=request as Record<string,unknown>;
      if (Object.keys(envelope).length!==3 || !["version","kind","payload"].every(k=>Object.hasOwn(envelope,k)) || envelope.version!==1 || envelope.kind!==kind || !envelope.payload || typeof envelope.payload!=="object" || Array.isArray(envelope.payload)) return c.json({error:"malformed"},400);
      const payload=envelope.payload as Record<string,unknown>;
      try {
        if (kind==="results") {
          if (Object.keys(payload).length!==1 || !Number.isInteger(payload.limit) || Number(payload.limit)<1 || Number(payload.limit)>10) return c.json({error:"malformed"},400);
          return c.json({version:1,kind:"results_result",payload:{results:await readQuestionResults(c.env,Number(payload.limit))}});
        }
        if (Object.keys(payload).length!==2 || typeof payload.request_id!=="string" || payload.request_id.length!==64 || !/^[0-9a-f]{64}$/.test(payload.request_id) || !Number.isSafeInteger(payload.revision) || Number(payload.revision)<1) return c.json({error:"malformed"},400);
        const outcome=await executeQuestionResult(requestExecutionDeps(c.env),payload.request_id,Number(payload.revision),caller.service);
        return c.json({version:1,kind:"execute_result",payload:{request_id:payload.request_id,outcome}});
      } catch {return c.text("Bridge unavailable.",503);}
    });
    router.all(`/answer-now/${kind}`,c=>c.text("Method not allowed.",405,{Allow:"POST"}));
  }
  return router;
}
async function readBody(request: Request,maxBytes=TRIAGE_MAX_REQUEST_BYTES): Promise<{ ok: true; raw: string } | { ok: false; status: 400 | 413 }> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) return { ok: false, status: 413 };
  try {
    const reader = request.body?.getReader();
    if (!reader) return { ok: true, raw: "" };
    let size = 0; const chunks: Uint8Array[] = [];
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > maxBytes) { await reader.cancel(); return { ok: false, status: 413 }; } chunks.push(value); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { ok: true, raw: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes) };
  } catch { return { ok: false, status: 400 }; }
}
async function answerNowSchemaReady(env:Env):Promise<boolean>{
  await env.DB.prepare("SELECT request_id FROM question_request_results LIMIT 1").all();
  await env.DB.prepare("SELECT request_id FROM question_request_clarifications LIMIT 1").all();
  const guards=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('question_requests_clarification_state_machine','question_requests_clarification_clock_update','question_request_results_generation_transition','question_request_results_spec_update','question_requests_state_machine','question_requests_clock_update','question_request_results_transition')").all<{name:string}>();
  const expected=new Set(['question_requests_clarification_state_machine','question_requests_clarification_clock_update','question_request_results_generation_transition','question_request_results_spec_update']);
  return guards.results.length===expected.size && guards.results.every(row=>expected.has(row.name));
}
async function handle(c: import("hono").Context<QuestionTriageEnv>, resolve: (c: import("hono").Context<QuestionTriageEnv>) => TriageCaller | null, kind: "read" | "claim" | "ack", answerNow = false,requestedProtocol:1|2|"auto"=1): Promise<Response> {
  const caller = resolve(c); if (!caller) return c.json({ error: "invalid_caller" }, 403);
  const body = await readBody(c.req.raw);
  if (!body.ok) return c.json({ error: body.status === 413 ? "too_large" : "malformed" }, body.status);
  const raw = body.raw;
  if (!c.env.BRIDGE_CURSOR_KEY) return c.text("Bridge unavailable.", 503);
  let protocol:1|2=requestedProtocol==="auto"?1:requestedProtocol;
  if(requestedProtocol==="auto"){try{if(JSON.parse(raw)?.version===2)protocol=2;}catch{/* closed core decoder returns malformed */}}
  const store = new D1QuestionTriageStore(c.env.DB,protocol);
  const deps: TriageDeps = { protocol,store, cursorKey: new TextEncoder().encode(c.env.BRIDGE_CURSOR_KEY), now: c.env.BRIDGE_NOW ?? (() => new Date()), newLeaseId: c.env.BRIDGE_NEW_LEASE_ID ?? (() => crypto.randomUUID()) };
  if(protocol===2)deps.currentContext=async()=>({catalog_digest:await requestCatalogDigest(),data_snapshot_id:await currentSnapshot(c.env)});
  if (answerNow) deps.answerNow = async (row, verdict) => {
    const mapped = await mapQuestionVerdict(verdict, { requestId: row.request_id, revision: row.revision+2, locale: row.locale, snapshotId: await currentSnapshot(c.env), resolvePerson: async (id, competition) => (await resolvePlayerIdentity(c.env,id,competition))?.person_id ?? null });
    if (mapped.kind === "ready") return { state: "confirmation_required", specJson: JSON.stringify(mapped.spec), snapshotId: mapped.spec.data_snapshot_id };
    if (mapped.kind === "clarification_required") return { state: "clarification_required", specJson: null, snapshotId: null };
    if (mapped.kind === "unsupported" || mapped.kind === "unavailable") return { state: mapped.kind, specJson: null, snapshotId: null };
    throw new Error("invalid_answer_now_mapping");
  };
  try {
    if(protocol===2 && !await answerNowSchemaReady(c.env))return c.text("Bridge unavailable.",503);
    if (kind !== "ack" && !(await sweepQuestionBeforeRequest(deps))) return c.text("Bridge unavailable.", 503);
    const result = kind === "read" ? await readQuestions(deps, caller, raw) : kind === "claim" ? await claimQuestion(deps, caller, raw) : await ackQuestion(deps, caller, raw);
    if (!result.ok) return c.json({ error: result.error }, result.error === "too_large" ? 413 : result.error === "invalid_caller" ? 403 : 400);
    return new Response(result.body, { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
  } catch { return c.text("Bridge unavailable.", 503); }
}
