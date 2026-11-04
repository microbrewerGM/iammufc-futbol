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
const response=(kind:NotificationOperation,payload:unknown,version=1):Reply=>({status:200,body:JSON.stringify({version,kind:"notify_"+kind+"_result",payload})});
const guards=new Set(["question_request_notifications_no_replace","question_request_notifications_issue_insert","question_request_notifications_issue_update",
  "question_request_notifications_initial","question_request_notifications_transition","question_request_notifications_released_insert","question_request_notifications_released_update","question_request_notifications_no_retained_delete"]);
const localGuards=["question_request_local_notifications_insert","question_request_local_notifications_update","question_request_local_notifications_delete","question_request_local_notifications_no_issue"];
async function ready(env:Env,local=false):Promise<{available:boolean;localInstalled:boolean}>{
  await env.DB.prepare("SELECT request_id FROM question_request_notifications LIMIT 0").all();
  const expected=new Set([...guards,...(local?localGuards:[])]);
  const localTable="question_request_local_notifications",probe=[...guards,...localGuards];
  const rows=await env.DB.prepare("SELECT name FROM sqlite_master WHERE (type='trigger' AND name IN ("+probe.map(()=>"?").join(",")+")) OR (type='table' AND name=?)").bind(...probe,localTable).all<{name:string}>();
  const found=new Set(rows.results.map(row=>row.name));
  return {available:[...expected].every(name=>found.has(name)),localInstalled:found.has(localTable) || localGuards.some(name=>found.has(name))};
}

/** Existing Access machine identity only. Clients never supply notification
 * content, source revisions, account identity or GitHub credentials.
 * V2 uses the same notify_* routes/envelope and freezes payload to four fields.
 * read/prepare expected_revision is the notification projection CAS. A prepare
 * grant returns the ledger CAS as revision and the immutable payload's revision
 * as payload_revision. check/bind/ack require both, plus lease_id. bind accepts
 * receipt (see store's hash vector), returns revision+1 and is replayable at its
 * old CAS. ack carries receipt and outcome; retry uses a null receipt. A receipt
 * is a trusted durable appender assertion, never a local file sequence/issue ID.
 * V2 refuses until all 0018 guards exist; V1 reads retain their shipped contract.
 */
export async function handleNotification(env:Env,caller:TriageCaller|null,kind:NotificationOperation,raw:string,newLease:()=>string=()=>crypto.randomUUID()):Promise<Reply>{
  if(!caller || caller.capability!==TRIAGE_CAPABILITY || !token(caller.service))return error(403,"invalid_caller");
  if(new TextEncoder().encode(raw).byteLength>8192)return error(413,"too_large");
  let request:unknown;try{request=JSON.parse(raw);}catch{return error(400,"malformed");}
  if(!object(request) || !closed(request,["version","kind","payload"]) || ![1,2].includes(Number(request.version)) || typeof request.version!=="number" || request.kind!=="notify_"+kind || !object(request.payload))return error(400,"malformed");
  const local=request.version===2;
  const p=request.payload;
  if(kind==="read"){
    if(!closed(p,["limit"]) || !integer(p.limit,1,10))return error(400,"malformed");
  }else{
    const keys=["request_id","expected_revision",...(kind==="prepare"?[]:["lease_id",...(local?["payload_revision"]:[])]),...(kind==="bind"?[local?"receipt":"issue_number"]:kind==="ack"?["outcome",...(local?["receipt"]:[])]:[])];
    if(!closed(p,keys) || !id(p.request_id) || !integer(p.expected_revision)
      || kind!=="prepare" && (!token(p.lease_id) || local && !integer(p.payload_revision)) || kind==="bind" && !(local?id(p.receipt):integer(p.issue_number))
      || local && kind==="ack" && !(p.outcome==="retry" && p.receipt===null || id(p.receipt))
      || kind==="ack" && (typeof p.outcome!=="string" || !["delivered","retry"].includes(p.outcome)))return error(400,"malformed");
  }
  try{
    const schema=await ready(env,local);
    if(!schema.available)return error(503,"notification_unavailable");
    if(!local && kind!=="read" && schema.localInstalled)return error(403,"local_delivery_required");
    const store=new D1NotificationStore(env);
    if(local){
      if(kind==="read")return response(kind,{items:await store.localRead(Number(p.limit))},2);
      const requestId=p.request_id as string,expected=Number(p.expected_revision);
      if(kind==="prepare"){
        const nonce=newLease();if(!token(nonce))return error(503,"notification_unavailable");
        return response(kind,await store.localPrepare(requestId,expected,caller.service,nonce),2);
      }
      const accepted=await store.localMutate(kind,requestId,Number(p.payload_revision),expected,p.lease_id as string,caller.service,
        typeof p.receipt==="string"?p.receipt:undefined,p.outcome as "delivered"|"retry"|undefined);
      return response(kind,{outcome:accepted?"accepted":"conflict",...(kind==="bind" && accepted?{revision:expected+1}:{})},2);
    }
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
