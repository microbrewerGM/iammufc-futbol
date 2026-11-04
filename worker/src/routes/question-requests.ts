import { Hono } from "hono";
import { INTAKE_MAX_BYTES, readQuestionStatus, storeQuestion, validAccountSub, validQuestionText } from "../core/question-requests";
import type { Env } from "../core/db";
import { accessIdentity, type AccessEnv } from "../security/auth";
import { questionRequestPage } from "../views/question-requests";
import { questionResultDeps, readQuestionResultStatus } from "../core/question-request-status";
import { confirmQuestionResult } from "../core/question-request-results";
import {clarifyQuestionResult} from "../core/question-request-clarification";
import { createQuestionRequestRefreshRouter } from "./question-request-refresh";

export type RouteEnv = AccessEnv & { Bindings: Env };
export function createQuestionRequestsRouter() {
  const router = new Hono<RouteEnv>();
  router.route("/",createQuestionRequestRefreshRouter());
  router.get("/:locale{en|es}/requests", async (c) => {
    const identity = accessIdentity(c);
    if (!identity || "serviceClientId" in identity || !validAccountSub(identity.sub)) return c.text("Forbidden.", 403);
    const locale = c.req.param("locale") as "en" | "es";
    const id = c.req.query("id") ?? "";
    const status = /^[0-9a-f]{64}$/.test(id) ? await readQuestionStatus(c.env, identity.sub, id) : null;
    try {
      const result = id.length===64 && /^[0-9a-f]{64}$/.test(id) ? await readQuestionResultStatus(c.env,identity.sub,id,locale) : undefined;
      return c.html(questionRequestPage(locale,status ?? undefined,undefined,result));
    } catch {
      // Migration or storage failure must not advertise a legacy "Available"
      // status as a successfully verified result.
      return c.html(questionRequestPage(locale,undefined,"unavailable"),503);
    }
  });
  router.post("/:locale{en|es}/requests", async (c) => {
    const identity = accessIdentity(c);
    if (!identity || "serviceClientId" in identity || !validAccountSub(identity.sub)) return c.text("Forbidden.", 403);
    const locale = c.req.param("locale") as "en" | "es";
    const length = c.req.header("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > INTAKE_MAX_BYTES)) return c.html(questionRequestPage(locale, undefined, "invalid"), 413);
    if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) return c.text("Invalid request.", 400);
    let raw: string;
    try {
      const reader = c.req.raw.body?.getReader();
      if (!reader) return c.html(questionRequestPage(locale, undefined, "invalid"), 400);
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > INTAKE_MAX_BYTES) {
          await reader.cancel();
          return c.html(questionRequestPage(locale, undefined, "invalid"), 413);
        }
        chunks.push(value);
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
    } catch { return c.html(questionRequestPage(locale, undefined, "invalid"), 400); }
    let form: URLSearchParams;
    try { form = new URLSearchParams(raw); } catch { return c.html(questionRequestPage(locale, undefined, "invalid"), 400); }
    const submittedText = form.get("text");
    if (submittedText !== null && new TextEncoder().encode(submittedText).byteLength > 2000) return c.html(questionRequestPage(locale, undefined, "invalid"), 413);
    const text = validQuestionText(submittedText);
    if (!text) return c.html(questionRequestPage(locale, undefined, "invalid"), 400);
    const result = await storeQuestion(c.env, identity.sub, text, locale);
    if (result.kind !== "stored" && result.kind !== "duplicate") {
      const status = result.kind === "daily_limit" || result.kind === "pending_limit" ? 429 : 503;
      return c.html(questionRequestPage(locale, undefined, "unavailable"), status);
    }
    return c.redirect(`/${locale}/requests?id=${encodeURIComponent(result.requestId)}`, 303);
  });
  router.post("/:locale{en|es}/requests/:id/confirm", async (c) => {
    const identity=accessIdentity(c);
    if (!identity || "serviceClientId" in identity || !validAccountSub(identity.sub)) return c.text("Forbidden.",403);
    if (c.req.header("origin")!==new URL(c.req.url).origin) return c.text("Forbidden.",403);
    const id=c.req.param("id"), locale=c.req.param("locale") as "en" | "es";
    if (id.length!==64 || !/^[0-9a-f]{64}$/.test(id)) return c.text("Not found.",404);
    if (!(c.req.header("content-type") ?? "").toLowerCase().match(/^application\/x-www-form-urlencoded(?:\s*;|$)/)) return c.text("Invalid request.",400);
    const length=c.req.header("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length)>128)) return c.text("Invalid request.",413);
    try {
      const reader=c.req.raw.body?.getReader();
      if (!reader) return c.text("Invalid request.",400);
      const chunks: Uint8Array[]=[]; let size=0;
      while (true) { const {done,value}=await reader.read(); if (done) break; size+=value.byteLength; if (size>128) {await reader.cancel();return c.text("Invalid request.",413);} chunks.push(value); }
      const bytes=new Uint8Array(size); let offset=0; for (const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.byteLength;}
      const form=new URLSearchParams(new TextDecoder("utf-8",{fatal:true,ignoreBOM:false}).decode(bytes));
      const fields=[...form];
      if (fields.length!==1 || fields[0]![0]!=="expected_revision" || !/^[1-9][0-9]{0,14}$/.test(fields[0]![1]) || fields[0]![1].trim()!==fields[0]![1]) return c.text("Invalid request.",400);
      const revision=Number(fields[0]![1]);
      // Revalidate the current catalog and code versions before confirmation;
      // the storage adapter additionally fences snapshot/generation at write.
      const view=await readQuestionResultStatus(c.env,identity.sub,id,locale);
      if (!view) return c.text("Not found.",404);
      if (view.refreshStatus==="unavailable" && view.confirmationAvailable===false) return c.text("Requests are temporarily unavailable.",503);
      if (view.state!=="confirmation_required" || view.revision!==revision || !view.currentBinding) return c.text("Request changed. Reload the status page.",409);
      if (view.confirmationAvailable===false) return c.text("Requests are temporarily unavailable.",503);
      const result=await confirmQuestionResult(questionResultDeps(c.env,identity.sub),id,revision,identity.sub);
      if (result==="not_found") return c.text("Not found.",404);
      if (result!=="accepted") return c.text("Request changed. Reload the status page.",409);
      return c.redirect(`/${locale}/requests?id=${id}`,303);
    } catch { return c.text("Requests are temporarily unavailable.",503); }
  });
  router.all("/:locale{en|es}/requests/:id/confirm",(c)=>c.text("Method not allowed.",405,{Allow:"POST"}));
  router.post("/:locale{en|es}/requests/:id/clarify",async c=>{
    const identity=accessIdentity(c);
    if(!identity || "serviceClientId" in identity || !validAccountSub(identity.sub))return c.text("Forbidden.",403);
    if(c.req.header("origin")!==new URL(c.req.url).origin)return c.text("Forbidden.",403);
    const id=c.req.param("id"),locale=c.req.param("locale") as "en"|"es";
    if(id.length!==64 || !/^[0-9a-f]{64}$/.test(id))return c.text("Not found.",404);
    const form=await clarificationForm(c.req.raw);
    if(!form.ok)return c.html(questionRequestPage(locale,undefined,"invalid"),form.status);
    const outcome=await clarifyQuestionResult(c.env,identity.sub,id,form.revision,form.text);
    if(outcome==="accepted")return c.redirect(`/${locale}/requests?id=${id}`,303);
    if(outcome==="not_found")return c.text(locale==="es"?"Solicitud no encontrada.":"Not found.",404);
    if(outcome==="conflict")return c.text(locale==="es"?"La solicitud ha cambiado. Recarga la página de estado.":"Request changed. Reload the status page.",409);
    return c.html(questionRequestPage(locale,undefined,"unavailable"),503);
  });
  router.all("/:locale{en|es}/requests/:id/clarify",c=>c.text("Method not allowed.",405,{Allow:"POST"}));
  router.all("/:locale{en|es}/requests", (c) => c.text("Method not allowed.", 405, { Allow: "GET, POST" }));
  return router;
}
async function clarificationForm(request:Request):Promise<{ok:true;text:string;revision:number}|{ok:false;status:400|413}>{
  const length=request.headers.get("content-length");
  if(length && (!/^\d+$/.test(length) || Number(length)>INTAKE_MAX_BYTES))return {ok:false,status:413};
  if(!(request.headers.get("content-type") ?? "").toLowerCase().match(/^application\/x-www-form-urlencoded(?:\s*;|$)/))return {ok:false,status:400};
  try{
    const reader=request.body?.getReader();if(!reader)return {ok:false,status:400};
    const chunks:Uint8Array[]=[];let size=0;
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>INTAKE_MAX_BYTES){await reader.cancel();return {ok:false,status:413};}chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    const form=new URLSearchParams(new TextDecoder("utf-8",{fatal:true,ignoreBOM:false}).decode(bytes));
    const fields=[...form],revision=form.get("expected_revision"),text=validQuestionText(form.get("text"));
    if(fields.length!==2 || form.getAll("text").length!==1 || form.getAll("expected_revision").length!==1 || revision===null || revision.trim()!==revision || !/^[1-9][0-9]{0,14}$/.test(revision) || text===null)return {ok:false,status:400};
    return {ok:true,text,revision:Number(revision)};
  }catch{return {ok:false,status:400};}
}
