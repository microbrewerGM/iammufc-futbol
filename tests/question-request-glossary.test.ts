import {describe,it,expect} from "vitest";
// @ts-expect-error Node test runtime module.
import {DatabaseSync} from "node:sqlite";
import {readQuestionGlossary} from "../worker/src/core/question-request-glossary";
import {requestCatalogDigest} from "../worker/src/core/question-request-intent";
import {TRIAGE_CAPABILITY} from "../worker/src/core/question-triage-bridge";
import type {Env} from "../worker/src/core/db";
const digest=await requestCatalogDigest(),snapshot="snapshot-1",key=new TextEncoder().encode("test-only-cursor-key");
const caller={service:"triage_service",capability:TRIAGE_CAPABILITY};
const raw=(changes:Record<string,unknown>={})=>JSON.stringify({version:1,kind:"glossary",payload:{snapshot_id:snapshot,catalog_digest:digest,cursor:null,limit:50,...changes}});
function fixture(count=1){
  const db=new DatabaseSync(":memory:");
  db.exec("CREATE TABLE snapshots(snapshot_id TEXT,created_at TEXT); INSERT INTO snapshots VALUES('snapshot-1','2026-01-01'); CREATE TABLE player_identities(person_id TEXT,player_id INTEGER); CREATE TABLE players(player_id INTEGER,season TEXT,web_name TEXT,first_name TEXT,second_name TEXT)");
  for(let n=1;n<=count;n++){db.prepare("INSERT INTO player_identities VALUES(?,?)").run("fpl:code:"+String(n).padStart(4,"0"),n);db.prepare("INSERT INTO players VALUES(?,'2024-25',?,'Given',?)").run(n,"Player"+n,"Surname"+n);}
  let hook:(()=>void)|null=null;
  const env={DB:{prepare(sql:string){let values:unknown[]=[];return {bind(...args:unknown[]){values=args;return this;},async first(){return db.prepare(sql).get(...values)??null;},async all(){const results=db.prepare(sql).all(...values);if(sql.includes("JOIN players")){hook?.();hook=null;}return {results};}};}}} as unknown as Env;
  return {db,env,afterRead:(next:()=>void)=>{hook=next;},read:(changes:Record<string,unknown>={})=>readQuestionGlossary(env,caller,key,raw(changes))};
}
async function payload(result:Awaited<ReturnType<typeof readQuestionGlossary>>){expect(result.ok).toBe(true);if(!result.ok)throw new Error(result.error);expect(new TextEncoder().encode(result.body).length).toBeLessThanOrEqual(256*1024);return JSON.parse(result.body).payload;}
describe("complete bounded request glossary",()=>{
  it("reaches identities after the old first200 prefix without dropping an ID",async()=>{
    const x=fixture(251),ids:string[]=[];let cursor=null;
    do{const p=await payload(await x.read({cursor}));ids.push(...p.people.map((person:{id:string})=>person.id));cursor=p.next_cursor;}while(cursor);
    expect(ids).toHaveLength(251);expect(new Set(ids).size).toBe(251);expect(ids.at(-1)).toBe("fpl:code:0251");
  });
  it("includes historical web names, full names and shared source aliases",async()=>{
    const x=fixture(2);x.db.prepare("INSERT INTO player_identities VALUES('fpl:code:0001',999)").run();x.db.prepare("INSERT INTO players VALUES(999,'2019-20','OldWeb','Historic','Shared')").run();
    x.db.exec("UPDATE players SET second_name='Shared' WHERE player_id=2");
    const p=await payload(await x.read());expect(p.people[0].label).toBe("Player1");
    expect(p.people[0].aliases).toEqual(expect.arrayContaining(["OldWeb","Historic","Shared","Historic Shared","Given Surname1"]));expect(p.people[1].aliases).toContain("Shared");
  });
  it("binds continuation to service, signing key, snapshot and catalog",async()=>{
    const x=fixture(2),p=await payload(await x.read({limit:1})),cursor=p.next_cursor;
    expect(typeof cursor).toBe("string");
    for(const [service,signing] of [["other_service",key],[caller.service,new TextEncoder().encode("other-test-key")]] as const){
      expect(await readQuestionGlossary(x.env,{...caller,service},signing,raw({cursor,limit:1}))).toMatchObject({ok:false,status:400,error:"invalid_cursor"});
    }
    expect(await x.read({cursor:cursor.slice(0,-1)+(cursor.endsWith("0")?"1":"0")})).toMatchObject({ok:false,status:400});
    expect(await x.read({cursor,catalog_digest:"a".repeat(64)})).toMatchObject({ok:false,status:409});
    expect(await x.read({cursor,snapshot_id:"other"})).toMatchObject({ok:false,status:409});
  });
  it("rejects a valid continuation cursor with a trailing newline",async()=>{
    const x=fixture(2),first=await payload(await x.read({limit:1}));
    expect(typeof first.next_cursor).toBe("string");
    expect((await payload(await x.read({cursor:first.next_cursor,limit:1}))).people).toHaveLength(1);
    expect(await x.read({cursor:first.next_cursor+"\n",limit:1})).toMatchObject({ok:false,status:400,error:"invalid_cursor"});
  });
  it("rejects a publication during a metadata read",async()=>{
    const x=fixture();x.afterRead(()=>x.db.exec("INSERT INTO snapshots VALUES('snapshot-2','2026-02-01')"));
    expect(await x.read()).toEqual({ok:false,status:409,error:"context_changed"});
  });
  it("rejects malformed envelopes, cursor SQL, bounds and caller before reading",async()=>{
    const x=fixture();
    for(const changes of [{limit:0},{limit:51},{cursor:"' OR 1=1"},{snapshot_id:"bad space"},{extra:true}])expect(await x.read(changes)).toMatchObject({ok:false,status:400});
    expect(await readQuestionGlossary(x.env,{...caller,capability:"other"},key,raw())).toMatchObject({ok:false,status:403});
    expect(await readQuestionGlossary(x.env,{...caller,service:caller.service+"\n"},key,raw())).toMatchObject({ok:false,status:403});
    expect(await readQuestionGlossary(x.env,caller,key,"x".repeat(4097))).toMatchObject({ok:false,status:413});
  });
  it("rejects orphaned identities, invalid names and alias overflow instead of partial metadata",async()=>{
    const orphan=fixture();orphan.db.exec("DELETE FROM players");expect(await orphan.read()).toMatchObject({ok:false,status:503});
    const historical=fixture();historical.db.exec("INSERT INTO player_identities VALUES('fpl:code:0001',999)");expect(await historical.read()).toMatchObject({ok:false,status:503});
    const bad=fixture();bad.db.exec("UPDATE players SET web_name=char(10)||'invalid'");
    // Leading whitespace is normalized, embedded controls are never accepted.
    bad.db.exec("UPDATE players SET web_name='invalid'||char(10)||'name'");expect(await bad.read()).toMatchObject({ok:false,status:503});
    const over=fixture();for(let n=2;n<40;n++){over.db.prepare("INSERT INTO player_identities VALUES('fpl:code:0001',?)").run(n);over.db.prepare("INSERT INTO players VALUES(?,'2020-21',?,'Given','Surname')").run(n,"Alias"+n);}
    expect(await over.read()).toMatchObject({ok:false,status:503});
  });
  it("resumes deferred IDs when complete alias sets fill a response",async()=>{
    const x=fixture(50);
    x.db.exec("DELETE FROM players; DELETE FROM player_identities");
    for(let n=1;n<=50;n++)for(let a=0;a<29;a++){
      const row=n*100+a,name=String(a).padStart(3,"0")+"🟣".repeat(117);
      x.db.prepare("INSERT INTO player_identities VALUES(?,?)").run("fpl:code:"+String(n).padStart(4,"0"),row);
      x.db.prepare("INSERT INTO players VALUES(?,'2024-25',?,'','')").run(row,name);
    }
    const first=await payload(await x.read());expect(first.people.length).toBeLessThan(50);expect(first.next_cursor).not.toBeNull();
    const ids=first.people.map((p:{id:string})=>p.id);let cursor=first.next_cursor;
    while(cursor){const next=await payload(await x.read({cursor}));ids.push(...next.people.map((p:{id:string})=>p.id));cursor=next.next_cursor;}
    expect(ids).toHaveLength(50);expect(new Set(ids).size).toBe(50);
  });
});
