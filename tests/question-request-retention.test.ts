import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Node test runtime module.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test runtime module.
import { DatabaseSync } from "node:sqlite";
import { collectQuestionRequestRetention } from "../worker/src/core/question-request-retention";
import { sweepQuestions, type TriageDeps } from "../worker/src/core/question-triage-bridge";
import { D1QuestionTriageStore, resetQuestionSweepForTest, sweepQuestionBeforeRequest } from "../worker/src/routes/question-triage-sweep";

type Db = InstanceType<typeof DatabaseSync>;
const opened: Db[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); vi.restoreAllMocks(); resetQuestionSweepForTest(); });
const id = (n: number) => n.toString(16).padStart(64, "0");
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const migrations = ["0001_schema", "0003_p16_dot_plot", "0004_cache_slots", "0005_account_question_history", "0006_season_splits", "0008_exploration_request_links", "0009_manager_era_records", "0010_question_requests", "0011_opponent_labels", "0012_cl_season_stage", "0013_question_request_results", "0014_question_request_clarifications", "0015_question_request_notifications", "0016_question_request_refresh", "0017_exploration_null_checks", "0018_question_request_local_notifications"];
const children = ["question_request_results", "question_request_clarifications", "question_request_refresh_counts", "question_request_result_refreshes", "question_request_confirmation_context", "question_request_confirmations", "question_request_notifications", "question_request_local_notifications"];
function fixture() {
  const db: Db = new DatabaseSync(":memory:"), clockDb: Db = new DatabaseSync(":memory:");
  opened.push(db, clockDb);
  let clock = "2026-11-04T00:00:00Z";
  db.function("strftime", { varargs: true }, (...args: unknown[]) => clockDb.prepare(`SELECT strftime(${args.map(() => "?").join(",")}) AS value`).get(...args.map(a => a === "now" ? clock : a)).value);
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of migrations) db.exec(readFileSync(`infra/migrations/${name}.sql`, "utf8"));
  db.prepare("INSERT INTO snapshots VALUES('snapshot-1',?,'{}','{}')").run(clock);
  db.exec("INSERT INTO players VALUES('fpl:1:2024-25',1,'2024-25','Player','First','Last','FWD','MUN'); INSERT INTO player_identities VALUES('fpl:1:2024-25','fpl:code:1','fpl',1,'2024-25')");
  const expires = iso(Date.parse(clock) + 90 * 86400_000);
  function add(n: number, populated = false) {
    const requestId = id(n);
    db.prepare("INSERT INTO question_requests(request_id,account_sub,text,locale,text_hash,status,created_at,updated_at,expires_at) VALUES(?,'owner','Question text','en',?,'received',?,?,?)").run(requestId, requestId, clock, clock, expires);
    if (!populated) return;
    const settle = () => {
      db.prepare("UPDATE question_requests SET status='triaging',attempt=attempt+1,lease_id='q2:fixture',lease_owner='service',claimed_at=?,lease_expires_at=?,updated_at=?,revision=revision+1 WHERE request_id=?").run(clock, iso(Date.parse(clock) + 900_000), clock, requestId);
      const verdict = JSON.stringify({ version: 1, request_id: requestId, relevant: true, junk_reason: null, restated_question: "Show goals", tables: [], visuals: [], field_status: [], families: [] });
      db.prepare("UPDATE question_requests SET status='triaged',verdict_json=?,lease_expires_at=NULL,revision=revision+1 WHERE request_id=?").run(verdict, requestId);
      db.prepare("UPDATE question_requests SET status='no_data',revision=revision+1 WHERE request_id=?").run(requestId);
    };
    settle();
    db.prepare("INSERT INTO question_request_results(request_id,request_revision,state,created_at,updated_at,response_deadline,expires_at) VALUES(?,4,'clarification_required',?,?,?,?)").run(requestId, clock, clock, iso(Date.parse(clock) + 86400_000), expires);
    db.prepare("UPDATE question_requests SET status='received',attempt=0,verdict_json=NULL,lease_id=NULL,lease_owner=NULL,claimed_at=NULL,revision=revision+1 WHERE request_id=?").run(requestId);
    db.prepare("INSERT INTO question_request_clarifications VALUES(?,1,5,'Clarified question',?)").run(requestId, clock);
    db.prepare("UPDATE question_request_results SET state='triaging',request_revision=5,clarification_count=1,revision=revision+1 WHERE request_id=?").run(requestId);
    settle();
    const spec = JSON.stringify({ version: 1, request_id: requestId, request_revision: 8, locale: "en", canonical_intent: JSON.stringify({ competition: "PL", dimensions: [], entity_id: "fpl:code:1", entity_type: "player", filters: {}, limit: 1, metric: "goals", season: "2024-25", viz: "bar" }), result_path: "/en/q?metric=goals&entity_type=player&entity_id=fpl%3Acode%3A1&season=2024-25&competition=PL&viz=bar&limit=1", data_snapshot_id: "snapshot-1", catalog_digest: id(1000), transform_code_version: "v1", renderer_version: "v1", artifact_key: id(1000), expected_cell_state: "computable_now_queued" });
    db.prepare("UPDATE question_request_results SET state='confirmation_required',request_revision=8,spec_json=?,revision=revision+1 WHERE request_id=?").run(spec, requestId);
    db.prepare("UPDATE question_request_results SET state='building',revision=revision+1 WHERE request_id=?").run(requestId);
    db.prepare("INSERT OR IGNORE INTO snapshots VALUES('snapshot-2',?,'{}','{}')").run(iso(Date.parse(clock) + 1000));
    const result = db.prepare("SELECT * FROM question_request_results WHERE request_id=?").get(requestId);
    db.prepare(`INSERT INTO question_request_result_refreshes(request_id,account_sub,expected_revision,expected_parent_revision,
      expected_clarification_count,expected_spec_json,expected_expires_at,expected_refresh_count,expected_player_id,next_spec_json)
      VALUES(?,'owner',?,8,1,?,?,0,'fpl:1:2024-25',?)`).run(requestId, result.revision, spec, expires, JSON.stringify({ ...JSON.parse(spec), data_snapshot_id: "snapshot-2", artifact_key: id(1001) }));
    db.prepare("UPDATE question_request_results SET state='building',revision=revision+1 WHERE request_id=?").run(requestId);
    db.prepare("INSERT INTO question_request_notifications(request_id,desired_status,created_at,updated_at,expires_at) VALUES(?,'building',?,?,?)").run(requestId, clock, clock, expires);
    db.prepare("INSERT INTO question_request_local_notifications(request_id,payload_revision,status,result_path) SELECT request_id,desired_revision,desired_status,desired_result_path FROM question_request_notifications WHERE request_id=?").run(requestId);
  }
  const d1 = {
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...args: unknown[]) { values = args; return this; },
        async run() { const result = db.prepare(sql).run(...values); return { meta: { changes: Number(result.changes) } }; },
        async all() { return { results: db.prepare(sql).all(...values) }; },
      };
    },
  } as unknown as D1Database;
  return { db, d1, add, expires, setClock: (value: string) => { clock = value; } };
}
const depsFor = (d1: D1Database): TriageDeps => ({ protocol: 2, store: new D1QuestionTriageStore(d1, 2), now: () => new Date("2026-11-04T00:00:00Z"), newLeaseId: () => "fixture", cursorKey: new Uint8Array(32) });

describe("request retention maintenance", () => {
  it("cascades populated children at expiry, preserves them one second before, and leaves shared exploration alone", async () => {
    const x = fixture(); x.add(1, true);
    for (const table of children) {
      expect(x.db.prepare(`PRAGMA foreign_key_list(${table})`).all()).toEqual(expect.arrayContaining([expect.objectContaining({ table: "question_requests", on_delete: "CASCADE" })]));
    }
    for (const table of ["question_request_results", "question_request_clarifications", "question_request_refresh_counts", "question_request_notifications", "question_request_local_notifications"]) expect(x.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, table).toBe(1);
    expect(x.db.prepare("SELECT refresh_count FROM question_request_refresh_counts").get().refresh_count).toBe(1);
    expect(x.db.prepare("SELECT count(*) n FROM question_request_confirmations").get().n).toBe(2);
    const shared = JSON.stringify({ version: 1, family: "arrival_manager", as_of: "2026-11-04", population: "first_team_available", joining_basis: "effective_first_team_spell_entry", academy_basis: "documented_first_team_promotion", visualization: "table" });
    x.db.prepare("INSERT INTO exploration_shared_requests VALUES(?,1,?,?)").run(id(900), shared, "2026-11-04T00:00:00Z");
    x.setClock(iso(Date.parse(x.expires) - 1000));
    const before = children.map(table => x.db.prepare(`SELECT * FROM ${table}`).all());
    expect(await collectQuestionRequestRetention(x.d1)).toBe(0);
    expect(children.map(table => x.db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    x.setClock(x.expires);
    expect(await collectQuestionRequestRetention(x.d1)).toBe(1);
    for (const table of ["question_requests", ...children]) expect(x.db.prepare(`SELECT count(*) n FROM ${table}`).get().n).toBe(0);
    expect(x.db.prepare("SELECT count(*) n FROM exploration_shared_requests").get().n).toBe(1);
    expect(x.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("deletes at most 100 parents per invocation", async () => {
    const x = fixture(); for (let n = 1; n <= 101; n++) x.add(n);
    x.setClock(x.expires);
    expect(await collectQuestionRequestRetention(x.d1)).toBe(100);
    expect(x.db.prepare("SELECT request_id FROM question_requests").all()).toEqual([{ request_id: id(101) }]);
    expect(await collectQuestionRequestRetention(x.d1)).toBe(1);
  });
  it("runs both collectors from protocol-2 maintenance without changing moved counts", async () => {
    const x = fixture(); x.add(1, true); x.setClock(x.expires);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const prepared = vi.spyOn(x.d1, "prepare");
    expect(await sweepQuestions(depsFor(x.d1), 100, "expired")).toEqual({ moved: 1 });
    expect(x.db.prepare("SELECT count(*) n FROM question_requests").get().n).toBe(0);
    for (const table of ["exploration_request_links", "exploration_shared_requests", "exploration_shared_job_tombstones"]) expect(prepared.mock.calls.some(([sql]) => sql.startsWith(`DELETE FROM ${table}`))).toBe(true);
    expect(log.mock.calls).toEqual([["retention", { deleted: 1, failed: 0 }], ["retention", { deleted: 0, failed: 0 }]]);
  });
  it.each(["question", "exploration"])("isolates a %s retention failure from the other collector and triage", async failing => {
    const x = fixture();
    const original = x.d1.prepare.bind(x.d1);
    const prepared = vi.spyOn(x.d1, "prepare").mockImplementation(sql => {
      if (sql.startsWith(failing === "question" ? "DELETE FROM question_requests" : "DELETE FROM exploration_request_links")) throw new Error("private question and identity must not be logged");
      return original(sql);
    });
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const deps = depsFor(x.d1), rows = vi.spyOn(deps.store, "sweepRows");
    expect(await sweepQuestionBeforeRequest(deps)).toBe(true);
    expect(rows).toHaveBeenCalledOnce();
    expect(prepared.mock.calls.some(([sql]) => sql.startsWith("DELETE FROM question_requests"))).toBe(true);
    expect(prepared.mock.calls.some(([sql]) => sql.startsWith("DELETE FROM exploration_request_links"))).toBe(true);
    expect(log.mock.calls.map(([, counts]) => counts)).toEqual(expect.arrayContaining([{ deleted: 0, failed: 1 }, { deleted: 0, failed: 0 }]));
  });
  it("runs retention even when result maintenance fails and isolates an unexpected collector rejection", async () => {
    const x = fixture(), deps = depsFor(x.d1);
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(deps.store, "maintainResults").mockRejectedValue(new Error("maintenance failure"));
    const retention = vi.spyOn(deps.store, "collectRetention").mockRejectedValue(new Error("retention failure"));
    const rows = vi.spyOn(deps.store, "sweepRows");
    expect(await sweepQuestions(deps, 100, "expired")).toEqual({ moved: 0 });
    expect(retention).toHaveBeenCalledOnce(); expect(rows).toHaveBeenCalledOnce();
    deps.protocol = 1; await sweepQuestions(deps, 100, "expired");
    expect(retention).toHaveBeenCalledOnce();
  });
});
