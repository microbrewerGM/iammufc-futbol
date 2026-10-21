import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import { proposeArrivalManager } from "../worker/src/core/discovery-arrivals";
import { arrivalManagerHref, arrivalManagersBody, type ArrivalManagerView, type ArrivalUnknownReason } from "../worker/src/views/arrival-managers";

function fixture(): ArrivalManagerView {
  const proposed = proposeArrivalManager("show current players grouped by the manager in charge when they joined", "en", "2026-07-02");
  if (proposed.status !== "proposed") throw new Error("fixture request");
  const request = proposed.request;
  const row = {member_id:"m1",person_id:"p1",spell_id:"s1",manager_id:"a",event_id:"e1",tenure_id:"t1",lineage:["ref:1"]};
  return {
    request, players:{m1:"Player One",m2:"Player Two",m3:"Player Three"},managers:{a:"Manager A",b:"Manager B"},
    entries:{e1:{event_type:"effective_arrival",date:{earliest:"2026-06-30",latest:"2026-06-30",precision:"day"}},e2:{event_type:"first_team_promotion",date:{earliest:"2026-07-01",latest:"2026-07-01",precision:"day"}}},
    credits:{"ref:1":"Synthetic source credit",unused:"Unrelated credit"},roster:{observed_at:"2026-07-02T08:00:00Z",freshness:"dated"},job:{status:"not_queued"},
    result:{request,snapshot_id:"synthetic-snapshot",artifact_key:"a".repeat(64),transform_code_version:"test-transform",renderer_version:"test-renderer",roster_snapshot_id:"synthetic-roster",feasibility:"available",coverage:"partial",population_count:3,
      assigned:[{...row,member_id:"m2",person_id:"p2",spell_id:"s2",manager_id:"b",event_id:"e2",tenure_id:"t2"},row],
      unknown:[{member_id:"m3",person_id:null,spell_id:null,reason:"identity_unresolved",lineage:["ref:1"]}],lineage:["ref:1"]},
  };
}
const render = (model=fixture(), code: "en" | "es"="en") => arrivalManagersBody(model,LOCALES[code]);
const reasonNames: Record<ArrivalUnknownReason,[string,string]> = {
  identity_unresolved:["Player identity unresolved","Identidad del jugador sin resolver"],
  spell_missing:["First-team spell missing","Falta la etapa en el primer equipo"],
  arrival_missing:["Effective entry missing","Falta el inicio efectivo"],
  promotion_missing:["Documented first-team promotion missing","Falta la promoción documentada al primer equipo"],
  date_uncertain:["Entry date uncertain","Fecha de inicio incierta"],
  boundary_unresolved:["Responsibility boundary unresolved","Límite de responsabilidad sin resolver"],
  tenure_missing:["Manager responsibility evidence missing","Falta evidencia del periodo del entrenador"],
  tenure_overlap:["Overlapping manager responsibility","Periodos de entrenadores superpuestos"],
  source_conflict:["Conflicting source evidence","Evidencia contradictoria entre fuentes"],
};

describe("arrival managers body", () => {
  it.each(["en","es"] as const)("renders A1/B1/unknown1 and pinned interpretation in %s", code=>{
    const body=render(fixture(),code);
    expect(body).toContain("Manager A · 1");expect(body).toContain("Manager B · 1");
    expect(body).toContain(`${code==="en"?"Unknown manager":"Entrenador desconocido"} · 1`);
    expect(body).toContain(`${code==="en"?"Selected players":"Jugadores seleccionados"}: 3`);
    for(const name of ["Player One","Player Two","Player Three"])expect(body.match(new RegExp(name,"g"))).toHaveLength(1);
    expect(body).toContain("2026-06-30");expect(body).toContain("2026-07-01");
    expect(body).toContain(code==="en"?"Partial; unknowns and gaps remain":"Parcial; persisten casos desconocidos y lagunas");
    expect(body).toContain(code==="en"?"Includes incoming loans, excludes outgoing loans":"Incluye cedidos entrantes, excluye cedidos salientes");
    expect(body).toContain(code==="en"?"This does not identify who recruited":"No indica quién fichó");
    expect(body).toContain("2026-07-02T08:00:00Z");
    expect(body).toContain(code==="en"?"current freshness not established":"vigencia actual no acreditada");
    expect(body.indexOf("Manager A · 1")).toBeLessThan(body.indexOf("Manager B · 1"));
  });
  it.each(Object.entries(reasonNames))("localizes unknown reason %s",(reason, names)=>{
    const m=fixture();m.result!.unknown[0]!.reason=reason as ArrivalUnknownReason;
    expect(render(m,"en")).toContain(names[0]);expect(render(m,"es")).toContain(names[1]);
  });
  it("preserves deterministic member order without mutating caller arrays",()=>{
    const m=fixture();m.result!.assigned[0]!.manager_id="a";
    const before=JSON.stringify(m), body=render(m);
    expect(body.indexOf("Player One")).toBeLessThan(body.indexOf("Player Two"));
    expect(body).toContain("Manager A · 2");expect(JSON.stringify(m)).toBe(before);
  });
  it.each(["en","es"] as const)("distinguishes missing, empty complete, incomplete and all-unknown in %s",code=>{
    const m=fixture(), r=m.result!;r.roster_snapshot_id=null;r.population_count=0;r.assigned=[];r.unknown=[];r.coverage="missing";r.feasibility="no_data";
    let body=render(m,code);expect(body).toContain(code==="en"?"unknown, not zero":"desconocido, no cero");expect(body).not.toContain(code==="en"?"Selected players: 0":"Jugadores seleccionados: 0");expect(body).not.toContain("<table");
    r.roster_snapshot_id="empty-roster";r.coverage="complete";r.feasibility="available";
    expect(render(m,code)).toContain(code==="en"?"contains no players":"no contiene jugadores");
    r.coverage="partial";expect(render(m,code)).toContain(code==="en"?"does not establish an empty squad":"no demuestra una plantilla vacía");
    r.population_count=1;r.unknown=fixture().result!.unknown;
    body=render(m,code);expect(body).toContain("Player Three");expect(body).toContain("<table");
    expect(body).toContain(`${code==="en"?"Assigned":"Asignados"}: 0`);
  });
  it.each(["en","es"] as const)("shows stale and unavailable observation honestly in %s",code=>{
    const m=fixture();m.roster!.freshness="stale";
    expect(render(m,code)).toContain(code==="en"?"Stale dated squad":"Plantilla fechada desactualizada");
    delete m.roster;expect(render(m,code)).toContain(code==="en"?"observation time and current freshness unavailable":"Hora de observación y vigencia actual");
  });
  it.each(["not_queued","queued","running","failed","published"] as const)("keeps %s separate from availability",status=>{
    const m=fixture();m.job={status};m.result!.feasibility="no_data";
    for(const code of ["en","es"] as const){const body=render(m,code);expect(body).toContain(code==="en"?"Required data unavailable":"Datos necesarios no disponibles");expect(body).toContain(code==="en"?"Task progress alone does not make data available":"El progreso de la tarea por sí solo no hace que los datos estén disponibles");expect(body).not.toContain('role="status">Available');}
  });
  it.each(["computable_now_queued","computable_but_expensive"] as const)("renders feasibility %s without inventing a queued job",feasibility=>{
    const m=fixture();m.result!.feasibility=feasibility;delete m.job;
    for(const code of ["en","es"] as const)expect(render(m,code)).not.toContain(code==="en"?"Data task:":"Tarea de datos:");
  });
  it.each(["en","es"] as const)("denies details before rendering injected people or sources in %s",code=>{
    const m=fixture();m.result!.feasibility="no_rights";
    const body=render(m,code);expect(body).toContain(code==="en"?"Data use is not permitted":"No se permite usar los datos");
    for(const privateText of ["Player One","Manager A","Synthetic source credit","synthetic-snapshot","<table","2026-07-02T08:00:00Z"])expect(body).not.toContain(privateText);
  });
  it("renders missing dates and event metadata without guessing, and retains uncertain ranges",()=>{
    const m=fixture();m.entries={e2:{...m.entries.e2!,date:null}};
    expect(render(m)).toContain('aria-label="Missing data"');expect(render(m)).not.toContain("2026-06-30");
    m.unknown_entries={m3:{event_type:"re_signing",date:{earliest:"2025-06-30",latest:"2025-07-01",precision:"range"}}};
    expect(render(m)).toContain("2025-06-30 – 2025-07-01 (uncertain range)");
    expect(render(m,"es")).toContain("Nueva etapa tras volver a fichar");
    m.unknown_entries.m3!.date={earliest:"2025-06-01",latest:"2025-06-30",precision:"month"};expect(render(m,"es")).toContain("precisión mensual");
  });
  it("round-trips all seven request fields in EN/ES question links with a fixed date",()=>{
    const m=fixture();
    for(const code of ["en","es"] as const){const href=arrivalManagerHref(m.request,code), url=new URL(href,"https://example.invalid");expect(url.pathname).toBe(`/${code}/discover/arrivals`);
      const values=Object.fromEntries(url.searchParams);expect({...values,version:Number(values.version)}).toEqual(m.request);
      expect([...url.searchParams.keys()]).toEqual(Object.keys(m.request));
      expect(render(m,code)).toContain(href.replace(/&/g,"&amp;"));
    }
    expect(arrivalManagerHref(m.request,"en").split("?")[1]).toBe(arrivalManagerHref(m.request,"es").split("?")[1]);
  });
  it("hides stale results on request mismatch or validation error",()=>{
    for(const mode of ["mismatch","error"]){const m=fixture();if(mode==="mismatch")m.result={...m.result!,request:{...m.request,as_of:"2026-06-01"}};else m.error='<bad "selection">';
      const body=render(m);expect(body).toContain('role="alert"');expect(body).not.toContain("<table");expect(body).not.toContain("Synthetic source credit");expect(body).not.toContain("synthetic-snapshot");}
  });
  it("escapes labels, dates, snapshot, observation, error and credits",()=>{
    const m=fixture(), attack='<img src=x onerror="bad()">';m.players={...m.players,m1:attack};m.managers={...m.managers,a:attack};m.entries.e1!.date!.earliest=attack;m.result!.snapshot_id=attack;m.roster!.observed_at=attack;m.credits={"ref:1":attack};
    const body=render(m);expect(body).not.toMatch(/<img|<script|<svg/);expect(body).toContain("&lt;img src=x onerror=&quot;bad()&quot;&gt;");
    m.error=attack;expect(render(m)).toContain('role="alert">&lt;img');
    m.request={...m.request,as_of:attack};delete m.result;expect(render(m)).not.toContain('value="<img');
  });
  it.each(["toString","constructor","__proto__"])("rejects inherited metadata and credits for %s",key=>{
    const m=fixture();m.result!.assigned=[{...m.result!.assigned[0]!,member_id:key,manager_id:key,event_id:key,lineage:[key]}];m.result!.unknown=[];m.result!.lineage=[key];m.result!.population_count=1;
    m.players=Object.create({[key]:"Inherited player"});m.managers=Object.create({[key]:"Inherited manager"});m.entries=Object.create({[key]:fixture().entries.e1});m.credits=Object.create({[key]:"Inherited credit"});
    const body=render(m);expect(body).not.toMatch(/Inherited (player|manager|credit)/);expect(body).toContain("Source attribution unavailable");expect(body).toContain('aria-label="Missing data"');
  });
  it("uses only referenced lineage credits, deduplicates and flags missing attribution",()=>{
    const m=fixture();let body=render(m);expect(body.match(/Synthetic source credit/g)).toHaveLength(1);expect(body).not.toContain("Unrelated credit");
    m.result!.unknown[0]!.lineage=["ref:unknown"];expect(render(m)).toContain("Source attribution unavailable");
    for(const invalid of ["","  ",null,7]){m.credits={"ref:1":invalid} as unknown as Record<string,string>;expect(render(m)).toContain("Source attribution unavailable");}
  });
  it("provides unique labelled native controls and grouped accessible table semantics",()=>{
    const body=render(), ids=[...body.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);expect(new Set(ids).size).toBe(ids.length);
    for(const m of body.matchAll(/(?:for|aria-describedby)="([^"]+)"/g))for(const id of m[1]!.split(" "))expect(ids).toContain(id);
    expect(body.match(/<tbody>/g)).toHaveLength(3);expect(body).toContain('scope="rowgroup"');expect(body).toContain('scope="row"');expect(body).toContain('scope="col"');expect(body).toContain('tabindex="0"');expect(body).toContain("<caption>");
    expect(body).toContain('method="get"');expect(body).toContain('type="date" required');expect(body).not.toMatch(/<script|<style|style=|onclick=/);
  });
  it("does not invent a result before confirmation",()=>{const m=fixture();delete m.result;const body=render(m);expect(body).not.toContain("<table");expect(body).not.toContain("Required data unavailable");expect(body).not.toContain("synthetic-snapshot");});
});
