import {currentSnapshot,type Env} from "./db";
import {requestCatalogDigest} from "./question-request-intent";
import {TRIAGE_CAPABILITY,type TriageCaller} from "./question-triage-bridge";

const MAX_PAGE_BYTES=256*1024;
const encoder=new TextEncoder();
const object=(v:unknown):v is Record<string,unknown>=>v!==null && typeof v==="object" && !Array.isArray(v);
const closed=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length && keys.every(key=>Object.hasOwn(v,key));
const personId=(v:unknown):v is string=>typeof v==="string" && v.length>=1 && v.length<=64 && /^[a-z0-9]/.test(v) && !/[^a-z0-9:_-]/.test(v) && v!=="all";
const snapshotId=(v:unknown):v is string=>typeof v==="string" && v.length>=1 && v.length<=128 && !/[^A-Za-z0-9:_-]/.test(v);
const hash=(v:unknown):v is string=>typeof v==="string" && v.length===64 && !/[^0-9a-f]/.test(v);
const hex=(bytes:Uint8Array)=>[...bytes].map(b=>b.toString(16).padStart(2,"0")).join("");
function unhex(value:string):Uint8Array{if(value.length%2)throw new Error("invalid cursor");return new Uint8Array(value.match(/../g)!.map(pair=>Number.parseInt(pair,16)));}
function label(raw:unknown):string|null{
  if(raw===null || raw===undefined || raw==="")return null;
  if(typeof raw!=="string")throw new Error("invalid identity metadata");
  const value=raw.normalize("NFC").trim();
  if(!value)return null;
  if([...value].length>120 || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value))throw new Error("invalid identity metadata");
  return value;
}
export type GlossaryResult={ok:true;body:string}|{ok:false;status:400|403|409|413|503;error:string};
const bad=(status:400|403|409|413|503,error:string):GlossaryResult=>({ok:false,status,error});
async function signingKey(key:Uint8Array):Promise<CryptoKey>{return crypto.subtle.importKey("raw",key,{name:"HMAC",hash:"SHA-256"},false,["sign","verify"]);}
const message=(caller:TriageCaller,snapshot:string,digest:string,after:string)=>encoder.encode("glossary:v1\n"+caller.service+"\n"+snapshot+"\n"+digest+"\n"+after);
async function cursor(key:CryptoKey,caller:TriageCaller,snapshot:string,digest:string,after:string):Promise<string>{
  const data=hex(encoder.encode(JSON.stringify({snapshot_id:snapshot,after})));
  const tag=hex(new Uint8Array(await crypto.subtle.sign("HMAC",key,message(caller,snapshot,digest,after))));
  return "g1:"+data+":"+tag;
}

/** Complete metadata pages, never raw request text or model-selected lookups. */
export async function readQuestionGlossary(env:Env,caller:TriageCaller,keyBytes:Uint8Array,raw:string):Promise<GlossaryResult>{
  if(caller.capability!==TRIAGE_CAPABILITY || !/^[a-z0-9][a-z0-9:_-]{0,95}$/.test(caller.service) || caller.service.trim()!==caller.service)return bad(403,"invalid_caller");
  if(encoder.encode(raw).byteLength>4096)return bad(413,"too_large");
  let envelope:unknown;try{envelope=JSON.parse(raw);}catch{return bad(400,"malformed");}
  if(!object(envelope) || !closed(envelope,["version","kind","payload"]) || envelope.version!==1 || envelope.kind!=="glossary" || !object(envelope.payload))return bad(400,"malformed");
  const p=envelope.payload;
  if(!closed(p,["snapshot_id","catalog_digest","cursor","limit"]) || !snapshotId(p.snapshot_id) || !hash(p.catalog_digest)
    || p.cursor!==null && (typeof p.cursor!=="string" || p.cursor.length>1024) || !Number.isInteger(p.limit) || Number(p.limit)<1 || Number(p.limit)>50)return bad(400,"malformed");
  try{
    if(!keyBytes.byteLength)return bad(503,"metadata_unavailable");
    const digest=await requestCatalogDigest(),snapshot=p.snapshot_id;
    if(p.catalog_digest!==digest || await currentSnapshot(env)!==snapshot)return bad(409,"context_changed");
    const key=await signingKey(keyBytes);let after:string|null=null;
    if(p.cursor!==null){
      try{
        const m=/^g1:([0-9a-f]{2,768}):([0-9a-f]{64})$/.exec(p.cursor as string);if(!m)return bad(400,"invalid_cursor");
        const encoded=new TextDecoder("utf-8",{fatal:true,ignoreBOM:false}).decode(unhex(m[1]!));
        const decoded:unknown=JSON.parse(encoded);
        if(!object(decoded) || !closed(decoded,["snapshot_id","after"]) || decoded.snapshot_id!==snapshot || !personId(decoded.after)
          || encoded!==JSON.stringify({snapshot_id:snapshot,after:decoded.after}) || !await crypto.subtle.verify("HMAC",key,unhex(m[2]!),message(caller,snapshot,digest,decoded.after)))return bad(400,"invalid_cursor");
        after=decoded.after;
      }catch{return bad(400,"invalid_cursor");}
    }
    const idsResult=await env.DB.prepare("SELECT DISTINCT person_id FROM player_identities WHERE (? IS NULL OR person_id>?) ORDER BY person_id LIMIT ?").bind(after,after,Number(p.limit)+1).all<{person_id:string}>();
    const ids=idsResult.results.slice(0,Number(p.limit)).map(row=>row.person_id);
    if(ids.some(id=>!personId(id)))return bad(503,"metadata_unavailable");
    let rows:{id:string;web_name:string;first_name:string;second_name:string}[]=[];
    if(ids.length){
      const marks=ids.map(()=>"?").join(",");
      rows=(await env.DB.prepare(`SELECT i.person_id AS id,p.web_name,p.first_name,p.second_name FROM player_identities i LEFT JOIN players p ON p.player_id=i.player_id
        WHERE i.person_id IN (${marks}) ORDER BY i.person_id,p.season DESC,p.player_id DESC LIMIT 5001`).bind(...ids).all<typeof rows[number]>()).results;
      if(rows.length>5000)return bad(503,"metadata_unavailable");
    }
    if(await currentSnapshot(env)!==snapshot)return bad(409,"context_changed");
    const grouped=new Map<string,{id:string;label:string;aliases:Set<string>}>();
    for(const row of rows){
      if(!ids.includes(row.id))return bad(503,"metadata_unavailable");
      const web=label(row.web_name),first=label(row.first_name),second=label(row.second_name);
      if(!web)return bad(503,"metadata_unavailable");
      const person=grouped.get(row.id) ?? {id:row.id,label:web,aliases:new Set<string>()};
      for(const alias of [web,first,second,label([first,second].filter(Boolean).join(" "))])if(alias)person.aliases.add(alias);
      if(person.aliases.size>32)return bad(503,"metadata_unavailable");
      grouped.set(row.id,person);
    }
    const people:{id:string;label:string;aliases:string[]}[]=[];let size=0;
    for(const id of ids){
      const entry=grouped.get(id);if(!entry)return bad(503,"metadata_unavailable");
      const person={id,label:entry.label,aliases:[...entry.aliases].sort()},bytes=encoder.encode(JSON.stringify(person)).byteLength+1;
      if(size+bytes>MAX_PAGE_BYTES-4096)break; // continuation names every deferred ID
      people.push(person);size+=bytes;
    }
    if(ids.length && !people.length)return bad(503,"metadata_unavailable");
    const more=idsResult.results.length>ids.length || people.length<ids.length;
    const next=more && people.length?await cursor(key,caller,snapshot,digest,people[people.length-1]!.id):null;
    const body=JSON.stringify({version:1,kind:"glossary_result",payload:{snapshot_id:snapshot,catalog_digest:digest,people,next_cursor:next}});
    if(encoder.encode(body).byteLength>MAX_PAGE_BYTES)return bad(503,"metadata_unavailable");
    if(await currentSnapshot(env)!==snapshot)return bad(409,"context_changed");
    return {ok:true,body};
  }catch{return bad(503,"metadata_unavailable");}
}
