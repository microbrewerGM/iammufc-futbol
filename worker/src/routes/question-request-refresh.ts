import { Hono } from "hono";
import type { RouteEnv } from "./question-requests";
import { accessIdentity } from "../security/auth";
import { validAccountSub } from "../core/question-requests";
import { refreshQuestionResult } from "../core/question-request-refresh";

const TEXT = {
  en: { invalid:"Invalid request.", conflict:"Request changed. Reload the status page.", unavailable:"Refresh is temporarily unavailable.", expired:"This request has expired.", exhausted:"The refresh limit has been reached." },
  es: { invalid:"Solicitud no válida.", conflict:"La solicitud ha cambiado. Recarga la página de estado.", unavailable:"La actualización no está disponible temporalmente.", expired:"Esta solicitud ha caducado.", exhausted:"Se ha alcanzado el límite de actualizaciones." },
} as const;

export function createQuestionRequestRefreshRouter() {
  const router=new Hono<RouteEnv>();
  router.post("/:locale{en|es}/requests/:id/refresh",async c=>{
    const identity=accessIdentity(c);
    if (!identity || "serviceClientId" in identity || !validAccountSub(identity.sub)) return c.text("Forbidden.",403);
    const url=new URL(c.req.url),site=c.req.header("sec-fetch-site");
    if (url.protocol!=="https:" || c.req.header("origin")!==url.origin || site!==undefined && site!=="same-origin") return c.text("Forbidden.",403);
    const id=c.req.param("id"),locale=c.req.param("locale") as "en"|"es",t=TEXT[locale];
    if (id.length!==64 || !/^[0-9a-f]{64}$/.test(id)) return c.text(t.invalid,404);
    const form=await revisionForm(c.req.raw);
    if (!form.ok) return c.text(t.invalid,form.status);
    const outcome=await refreshQuestionResult(c.env.DB,identity.sub,id,form.revision);
    if (outcome==="accepted") return c.redirect(`/${locale}/requests?id=${id}`,303);
    return c.text(t[outcome],outcome==="unavailable"?503:409);
  });
  router.all("/:locale{en|es}/requests/:id/refresh",c=>c.text("Method not allowed.",405,{Allow:"POST"}));
  return router;
}

async function revisionForm(request:Request):Promise<{ok:true;revision:number}|{ok:false;status:400|413}> {
  const length=request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length)>128)) return {ok:false,status:413};
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(request.headers.get("content-type")??"")) return {ok:false,status:400};
  try {
    const reader=request.body?.getReader();
    if (!reader) return {ok:false,status:400};
    const bytes=new Uint8Array(128);let size=0;
    while (true) {
      const {done,value}=await reader.read();if (done) break;
      if (size+value.byteLength>128) {await reader.cancel();return {ok:false,status:413};}
      bytes.set(value,size);size+=value.byteLength;
    }
    const raw=new TextDecoder("utf-8",{fatal:true,ignoreBOM:false}).decode(bytes.subarray(0,size));
    // URLSearchParams tolerates malformed escapes; reject them before decoding.
    if (/%(?![a-f0-9]{2})/i.test(raw)) return {ok:false,status:400};
    const fields=[...new URLSearchParams(raw)];
    if (fields.length!==1 || fields[0]![0]!=="expected_revision" || !/^[1-9][0-9]{0,14}$/.test(fields[0]![1]) || fields[0]![1].trim()!==fields[0]![1]) return {ok:false,status:400};
    return {ok:true,revision:Number(fields[0]![1])};
  } catch {return {ok:false,status:400};}
}
