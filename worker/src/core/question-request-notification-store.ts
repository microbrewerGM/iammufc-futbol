import type {Env} from "./db";
import {readQuestionResultStatus} from "./question-request-status";

export const NOTIFICATION_STATUSES=new Set(["received","triaging","clarification_required","confirmation_required","building","in_review","released","unsupported","unavailable","failed","expired","junk","stale"]);
export interface NotificationPayload {request_id:string;revision:number;status:string;result_path:string|null}
export interface NotificationRow {
  request_id:string;revision:number;desired_revision:number;desired_status:string;desired_result_path:string|null;delivered_revision:number;
  create_state:"ready"|"pending"|"bound";issue_number:number|null;creation_revision:number|null;creation_status:string|null;creation_result_path:string|null;
  lease_id:string|null;lease_owner:string|null;lease_expires_at:string|null;inflight_revision:number|null;inflight_status:string|null;inflight_result_path:string|null;
  expires_at:string;db_now:string;
}
interface Source {
  request_id:string;account_sub:string;locale:"en"|"es";q_revision:number;q_status:string;q_expires:string;q_lease:string|null;
  r_revision:number|null;r_parent:number|null;r_state:string|null;r_expires:string|null;r_deadline:string|null;snapshot_id:string|null;db_now:string;
}
interface Projection {source:Source;status:string;path:string|null}
const NOW="strftime('%Y-%m-%dT%H:%M:%SZ','now')";
const SNAPSHOT="(SELECT snapshot_id FROM snapshots ORDER BY created_at DESC LIMIT 1)";
const JOIN="question_requests q LEFT JOIN question_request_results r ON r.request_id=q.request_id";
const OWNED="(q.lease_id LIKE 'q2:%' OR r.request_id IS NOT NULL)";
const CLEAR="lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,inflight_revision=NULL,inflight_status=NULL,inflight_result_path=NULL";
const SOURCE_KEYS:(keyof Source)[]=["request_id","account_sub","locale","q_revision","q_status","q_expires","q_lease","r_revision","r_parent","r_state","r_expires","r_deadline","snapshot_id"];
const same=(a:Source,b:Source)=>SOURCE_KEYS.every(key=>a[key]===b[key]);

/** Only fixed metadata is returned. Account ownership is used internally by the
 * existing release verifier; neither question text nor person labels leave it. */
export class D1NotificationStore {
  constructor(readonly env:Env){}
  private source(id:string):Promise<Source|null>{
    return this.env.DB.prepare(`SELECT q.request_id,q.account_sub,q.locale,q.revision AS q_revision,q.status AS q_status,q.expires_at AS q_expires,q.lease_id AS q_lease,
      r.revision AS r_revision,r.request_revision AS r_parent,r.state AS r_state,r.expires_at AS r_expires,r.response_deadline AS r_deadline,
      ${SNAPSHOT} AS snapshot_id,${NOW} AS db_now FROM ${JOIN} WHERE q.request_id=? AND ${OWNED}`).bind(id).first<Source>();
  }
  private async project(id:string):Promise<Projection|null>{
    const before=await this.source(id);if(!before || before.q_expires<=before.db_now)return null;
    let status:string,path:string|null=null;
    if(before.r_revision!==null){
      const view=await readQuestionResultStatus(this.env,before.account_sub,id,before.locale);if(!view)return null;
      status=view.state;
      if(status==="released"){
        if(!view.currentBinding || !view.resultPath)throw new Error("notification_projection_unavailable");
        path=view.resultPath;
      }
    }else status=({received:"received",triaging:"triaging",junk:"junk",triage_failed:"failed"} as Record<string,string>)[before.q_status] ?? "unavailable";
    const fresh=await this.source(id);if(!fresh || !same(before,fresh) || fresh.q_expires<=fresh.db_now)return null;
    if(fresh.r_deadline!==null && ["triaging","clarification_required","confirmation_required"].includes(fresh.r_state ?? "") && fresh.r_deadline<=fresh.db_now){status="expired";path=null;}
    if(!NOTIFICATION_STATUSES.has(status) || status!=="released" && path!==null)throw new Error("notification_projection_unavailable");
    return {source:fresh,status,path};
  }
  private fence(p:Projection):{sql:string;values:(string|number|null)[]}{
    const s=p.source;
    return {sql:`EXISTS(SELECT 1 FROM ${JOIN} WHERE q.request_id=? AND ${OWNED} AND q.account_sub=? AND q.locale=?
      AND q.revision=? AND q.status=? AND q.expires_at=? AND q.lease_id IS ? AND r.revision IS ? AND r.request_revision IS ? AND r.state IS ?
      AND r.expires_at IS ? AND r.response_deadline IS ? AND ${SNAPSHOT} IS ? AND q.expires_at>${NOW}
      AND (coalesce(r.state,'') NOT IN ('triaging','clarification_required','confirmation_required') OR (?='expired')=(r.response_deadline<=${NOW})))`,
      values:[s.request_id,s.account_sub,s.locale,s.q_revision,s.q_status,s.q_expires,s.q_lease,s.r_revision,s.r_parent,s.r_state,s.r_expires,s.r_deadline,s.snapshot_id,p.status]};
  }
  get(id:string):Promise<NotificationRow|null>{return this.env.DB.prepare(`SELECT n.*,${NOW} AS db_now FROM question_request_notifications n WHERE request_id=?`).bind(id).first<NotificationRow>();}
  private async recover(id:string):Promise<void>{
    await this.env.DB.prepare(`UPDATE question_request_notifications SET ${CLEAR},revision=revision+1,updated_at=max(updated_at,${NOW})
      WHERE request_id=? AND lease_expires_at<=${NOW} AND expires_at>${NOW}`).bind(id).all();
  }
  private async refresh(id:string):Promise<NotificationRow|null>{
    await this.recover(id);const old=await this.get(id),p=await this.project(id);if(!p)return null;
    const f=this.fence(p);
    if(!old)return this.env.DB.prepare(`INSERT INTO question_request_notifications(request_id,desired_status,desired_result_path,created_at,updated_at,expires_at)
      SELECT ?,?,?,${NOW},${NOW},? WHERE ${f.sql} RETURNING *,${NOW} AS db_now`).bind(id,p.status,p.path,p.source.q_expires,...f.values).first<NotificationRow>();
    return this.env.DB.prepare(`UPDATE question_request_notifications SET desired_revision=desired_revision+CASE WHEN desired_status IS NOT ? OR desired_result_path IS NOT ? THEN 1 ELSE 0 END,
      desired_status=?,desired_result_path=?,revision=revision+1,updated_at=max(updated_at,${NOW}) WHERE request_id=? AND revision=? AND ${f.sql} RETURNING *,${NOW} AS db_now`)
      .bind(p.status,p.path,p.status,p.path,id,old.revision,...f.values).first<NotificationRow>();
  }
  async read(limit:number):Promise<{request_id:string;revision:number}[]>{
    // Three full release projections plus schema probes stay below D1 Free's
    //50-query invocation cap. Each candidate is touched, including audit matches.
    const candidates=await this.env.DB.prepare(`SELECT q.request_id FROM ${JOIN} LEFT JOIN question_request_notifications n ON n.request_id=q.request_id
      WHERE ${OWNED} AND q.expires_at>${NOW} AND (n.lease_expires_at IS NULL OR n.lease_expires_at<=${NOW})
      ORDER BY coalesce(n.updated_at,q.updated_at),coalesce(n.revision,0),q.request_id LIMIT ?`).bind(Math.min(limit,3)).all<{request_id:string}>();
    const items:{request_id:string;revision:number}[]=[];
    for(const candidate of candidates.results){const row=await this.refresh(candidate.request_id);if(row && (!row.lease_expires_at || row.lease_expires_at<=row.db_now))items.push({request_id:row.request_id,revision:row.revision});}
    return items;
  }
  async prepare(id:string,expected:number,service:string,lease:string):Promise<{row:NotificationRow;action:"create"|"reconcile"|"update"}|null>{
    const old=await this.get(id);if(!old || old.revision!==expected || old.lease_id!==null)return null;
    const p=await this.project(id);if(!p)return null;
    if(old.desired_status!==p.status || old.desired_result_path!==p.path){await this.refresh(id);return null;}
    const f=this.fence(p),initial=old.create_state==="ready";
    return this.env.DB.prepare(`UPDATE question_request_notifications SET create_state=CASE WHEN create_state='ready' THEN 'pending' ELSE create_state END,
      creation_revision=CASE WHEN create_state='ready' THEN desired_revision ELSE creation_revision END,
      creation_status=CASE WHEN create_state='ready' THEN desired_status ELSE creation_status END,
      creation_result_path=CASE WHEN create_state='ready' THEN desired_result_path ELSE creation_result_path END,
      lease_id=?,lease_owner=?,lease_expires_at=min(expires_at,strftime('%Y-%m-%dT%H:%M:%SZ','now','+900 seconds')),
      inflight_revision=CASE WHEN create_state='pending' THEN creation_revision ELSE desired_revision END,
      inflight_status=CASE WHEN create_state='pending' THEN creation_status ELSE desired_status END,
      inflight_result_path=CASE WHEN create_state='pending' THEN creation_result_path ELSE desired_result_path END,
      revision=revision+1,updated_at=max(updated_at,${NOW}) WHERE request_id=? AND revision=? AND lease_id IS NULL AND expires_at>${NOW} AND ${f.sql}
      RETURNING *,${NOW} AS db_now`).bind(lease,service,id,expected,...f.values).first<NotificationRow>().then(row=>row?{row,action:initial?"create":old.create_state==="pending"?"reconcile":"update"}:null);
  }
  async check(id:string,expected:number,lease:string,service:string):Promise<boolean>{
    const row=await this.get(id);if(!row || row.revision!==expected || row.lease_id!==lease || row.lease_owner!==service)return false;
    const p=await this.project(id);if(!p)return false;
    if((row.create_state==="bound" || row.inflight_status==="released") && (row.inflight_status!==p.status || row.inflight_result_path!==p.path))return false;
    const f=this.fence(p);
    return !!await this.env.DB.prepare(`SELECT request_id FROM question_request_notifications WHERE request_id=? AND revision=? AND lease_id=? AND lease_owner=?
      AND lease_expires_at>${NOW} AND expires_at>${NOW} AND ${f.sql}`).bind(id,expected,lease,service,...f.values).first();
  }
  async bind(id:string,expected:number,lease:string,service:string,issue:number):Promise<boolean>{
    const row=await this.env.DB.prepare(`UPDATE question_request_notifications SET create_state='bound',issue_number=?,${CLEAR},revision=revision+1,updated_at=max(updated_at,${NOW})
      WHERE request_id=? AND revision=? AND create_state='pending' AND lease_id=? AND lease_owner=? AND lease_expires_at>${NOW} AND expires_at>${NOW} RETURNING request_id`)
      .bind(issue,id,expected,lease,service).first();return !!row;
  }
  async ack(id:string,expected:number,lease:string,service:string,outcome:"delivered"|"retry"):Promise<boolean>{
    let fence:{sql:string;values:(string|number|null)[]}|undefined;
    if(outcome==="delivered"){
      const row=await this.get(id),p=await this.project(id);
      if(!row || !p || row.inflight_status!==p.status || row.inflight_result_path!==p.path)return false;
      fence=this.fence(p);
    }
    if(outcome==="retry"){
      const row=await this.get(id);if(!row || row.revision!==expected || row.lease_id!==lease || row.lease_owner!==service || !row.lease_expires_at || row.lease_expires_at<=row.db_now || row.expires_at<=row.db_now)return false;
      if(row.create_state==="bound")return true; // uncertain PATCH keeps frozen lease until expiry
    }
    return !!await this.env.DB.prepare(`UPDATE question_request_notifications SET delivered_revision=${outcome==="delivered"?"max(delivered_revision,inflight_revision)":"delivered_revision"},
      ${CLEAR},revision=revision+1,updated_at=max(updated_at,${NOW}) WHERE request_id=? AND revision=? AND lease_id=? AND lease_owner=? AND lease_expires_at>${NOW}
      AND expires_at>${NOW} AND create_state=?${fence?" AND "+fence.sql:""} RETURNING request_id`).bind(id,expected,lease,service,outcome==="delivered"?"bound":"pending",...(fence?.values ?? [])).first();
  }
}

export function issuedPayload(row:NotificationRow):NotificationPayload {
  if(row.inflight_revision===null || row.inflight_status===null)throw new Error("notification_grant_unavailable");
  return {request_id:row.request_id,revision:row.inflight_revision,status:row.inflight_status,result_path:row.inflight_result_path};
}
