import type {Env} from "./db";
import {TRIAGE_CAPABILITY,type TriageCaller} from "./question-triage-bridge";
import {D1NotificationStore,issuedPayload} from "./question-request-notification-store";
export type NotificationOperation="read"|"prepare"|"check"|"bind"|"ack";
type Reply={status:200|400|403|413|503;body:string};
const object=(v:unknown):v is Record<string,unknown>=>v!==null && typeof v==="object" && !Array.isArray(v);
const closed=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));
const integer=(v:unknown,min=1,max=Number.MAX_SAFE_INTEGER):v is number=>Number.isSafeInteger(v) && Number(v)>=min && Number(v)<=max;
const id=(v:unknown):v is string=>typeof v==="string" && v.length===64 && /^[0-9a-f]{64}$/.test(v);
const token=(v:unknown):v is string=>typeof v==="string" && v.length>=1 && v.length<=96 && /^[a-z0-9]/.test(v) && !/[^a-z0-9:_-]/.test(v);
const error=(status:400|403|413|503,code:string):Reply=>({status,body:JSON.stringify({error:code})});
const response=(kind:NotificationOperation,payload:unknown):Reply=>({status:200,body:JSON.stringify({version:1,kind:"notify_"+kind+"_result",payload})});
const guards=new Set(["question_request_notifications_no_replace","question_request_notifications_issue_insert","question_request_notifications_issue_update",
  "question_request_notifications_initial","question_request_notifications_transition","question_request_notifications_released_insert","question_request_notifications_released_update","question_request_notifications_no_retained_delete"]);
async function ready(env:Env):Promise<boolean>{
  await env.DB.prepare("SELECT request_id FROM question_request_notifications LIMIT 0").all();
  const rows=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ("+[...guards].map(()=>"?").join(",")+")").bind(...guards).all<{name:string}>();
  return rows.results.length===guards.size && rows.results.every(row=>guards.has(row.name));
}

/** Existing Access machine identity only. Clients never supply notification
 * content, source revisions, account identity or GitHub credentials. */
export async function handleNotification(env:Env,caller:TriageCaller|null,kind:NotificationOperation,raw:string,newLease:()=>string=()=>crypto.randomUUID()):Promise<Reply>{
  if(!caller || caller.capability!==TRIAGE_CAPABILITY || !token(caller.service))return error(403,"invalid_caller");
  if(new TextEncoder().encode(raw).byteLength>8192)return error(413,"too_large");
  let request:unknown;try{request=JSON.parse(raw);}catch{return error(400,"malformed");}
  if(!object(request) || !closed(request,["version","kind","payload"]) || request.version!==1 || request.kind!=="notify_"+kind || !object(request.payload))return error(400,"malformed");
  const p=request.payload;
  if(kind==="read"){
    if(!closed(p,["limit"]) || !integer(p.limit,1,10))return error(400,"malformed");
  }else{
    const keys=["request_id","expected_revision",...(kind==="prepare"?[]:["lease_id"]),...(kind==="bind"?["issue_number"]:kind==="ack"?["outcome"]:[])];
    if(!closed(p,keys) || !id(p.request_id) || !integer(p.expected_revision)
      || kind!=="prepare" && !token(p.lease_id) || kind==="bind" && !integer(p.issue_number)
      || kind==="ack" && (typeof p.outcome!=="string" || !["delivered","retry"].includes(p.outcome)))return error(400,"malformed");
  }
  try{
    if(!await ready(env))return error(503,"notification_unavailable");
    const store=new D1NotificationStore(env);
    if(kind==="read")return response(kind,{items:await store.read(Number(p.limit))});
    const requestId=p.request_id as string,expected=Number(p.expected_revision),lease=p.lease_id as string;
    if(kind==="prepare"){
      const nonce=newLease();if(!token(nonce))return error(503,"notification_unavailable");
      const grant=await store.prepare(requestId,expected,caller.service,nonce);
      if(!grant)return response(kind,{action:"conflict"});
      const row=grant.row;
      return response(kind,{action:grant.action,request_id:row.request_id,revision:row.revision,lease_id:row.lease_id,lease_expires_at:row.lease_expires_at,
        payload:issuedPayload(row),issue_number:row.issue_number});
    }
    const accepted=kind==="check"?await store.check(requestId,expected,lease,caller.service)
      :kind==="bind"?await store.bind(requestId,expected,lease,caller.service,Number(p.issue_number))
      :await store.ack(requestId,expected,lease,caller.service,p.outcome as "delivered"|"retry");
    return response(kind,{outcome:accepted?"accepted":"conflict"});
  }catch{return error(503,"notification_unavailable");}
}
