import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error Node test runtime module.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test runtime module.
import { DatabaseSync } from "node:sqlite";
import { collectExplorationRetention } from "../worker/src/core/exploration-retention";
import { collectQuestionRequestRetention } from "../worker/src/core/question-request-retention";

type Db = InstanceType<typeof DatabaseSync>;
const opened: Db[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
const id = (n: number) => n.toString(16).padStart(64, "0");
const initial = "2026-11-04T00:00:00Z";
const request = JSON.stringify({ version: 1, family: "arrival_manager", as_of: "2026-11-04", population: "first_team_available", joining_basis: "effective_first_team_spell_entry", academy_basis: "documented_first_team_promotion", visualization: "table" });
function fixture() {
  const db: Db = new DatabaseSync(":memory:"), clockDb: Db = new DatabaseSync(":memory:");
  opened.push(db, clockDb);
  let clock = initial;
  db.function("strftime", { varargs: true }, (...args: unknown[]) => clockDb.prepare(`SELECT strftime(${args.map(() => "?").join(",")}) value`).get(...args.map(a => a === "now" ? clock : a)).value);
  db.exec("PRAGMA foreign_keys=ON");
  const script = JSON.parse(readFileSync("package.json", "utf8")).scripts["d1:seed"] as string;
  for (const part of script.split("&&").slice(0, -1)) db.exec(readFileSync(part.trim().split(" ").at(-1)!, "utf8"));
  const count = (table: string) => db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
  const d1 = { prepare(sql: string) { return { async run() { return { meta: { changes: Number(db.prepare(sql).run().changes) } }; } }; } } as unknown as D1Database;
  function shared(n: number, linked = true) {
    db.prepare("INSERT INTO exploration_shared_requests VALUES(?,1,?,?)").run(id(n), request, initial);
    if (linked) db.prepare("INSERT INTO exploration_request_links VALUES(?,'owner','2026-08-05T00:00:00Z','2026-11-03T00:00:00Z')").run(id(n));
  }
  function question(n: number, sharedId: number) {
    db.prepare("INSERT INTO question_requests(request_id,account_sub,text,locale,text_hash,status,created_at,updated_at,expires_at) VALUES(?,'owner','Show managers','en',?,'received',?,?,strftime('%Y-%m-%dT%H:%M:%SZ',?,'+90 days'))").run(id(n), id(n), clock, clock, clock);
    db.prepare("UPDATE question_requests SET status='triaging',attempt=1,lease_id='fixture',lease_owner='service',claimed_at=?,lease_expires_at=strftime('%Y-%m-%dT%H:%M:%SZ',?,'+900 seconds'),revision=revision+1 WHERE request_id=?").run(clock, clock, id(n));
    const verdict = JSON.stringify({ version: 1, request_id: id(n), relevant: true, junk_reason: null, restated_question: "Show managers", tables: [], visuals: [], field_status: [], families: [] });
    db.prepare("UPDATE question_requests SET status='triaged',verdict_json=?,lease_expires_at=NULL,revision=revision+1 WHERE request_id=?").run(verdict, id(n));
    db.prepare("UPDATE question_requests SET status='queued',exploration_request_id=?,revision=revision+1 WHERE request_id=?").run(id(sharedId), id(n));
  }
  function job(n: number) {
    db.prepare("INSERT INTO exploration_shared_jobs(job_id,request_id,status,attempt,admitted_at,created_at,updated_at,expires_at) VALUES(?,?,'queued',0,?,?,?,strftime('%Y-%m-%dT%H:%M:%SZ',?,'+30 days'))").run(id(n), id(n), clock, clock, clock, clock);
  }
  function claim(n: number) {
    db.prepare("UPDATE exploration_shared_jobs SET status='running',attempt=1,lease_id='fixture',lease_owner='service',claimed_at=?,lease_expires_at=strftime('%Y-%m-%dT%H:%M:%SZ',?,'+900 seconds'),revision=revision+1 WHERE job_id=?").run(clock, clock, id(n));
  }
  return { db, d1, count, shared, question, job, claim, setClock: (value: string) => { clock = value; } };
}

describe("exploration retention with live question references", () => {
  it("removes an older link while preserving the live question's request, job and result; collects at last-question expiry", async () => {
    const x = fixture(); x.shared(1); x.job(1); x.question(101, 1);
    x.db.prepare("INSERT INTO exploration_shared_results VALUES(?,'snapshot',?,'v1','v1',NULL,'no_data','missing',0,'[]','[]','[]',?,strftime('%Y-%m-%dT%H:%M:%SZ',?,'+30 days'))").run(id(1), id(2), initial, initial);
    expect(await collectExplorationRetention({ DB: x.d1 })).toBe(1);
    expect(x.count("exploration_request_links")).toBe(0);
    for (const table of ["exploration_shared_requests", "exploration_shared_jobs", "exploration_shared_results"]) expect(x.count(table)).toBe(1);
    // This job update used to bypass the collectable view and delete live data.
    x.claim(1);
    x.db.prepare("UPDATE exploration_shared_jobs SET status='failed',lease_expires_at=NULL,failure='lease_expired',retry_after='2026-11-04T00:15:00Z',revision=revision+1 WHERE job_id=?").run(id(1));
    expect(x.count("exploration_shared_requests")).toBe(1);
    x.setClock("2027-02-01T23:59:59Z");
    await collectExplorationRetention({ DB: x.d1 });
    expect(x.count("exploration_shared_requests")).toBe(1);
    x.setClock("2027-02-02T00:00:00Z");
    // No question delete trigger: the view sweep handles expiry even before purge.
    await collectExplorationRetention({ DB: x.d1 });
    for (const table of ["exploration_shared_requests", "exploration_shared_jobs", "exploration_shared_results"]) expect(x.count(table)).toBe(0);
    expect(x.count("question_requests")).toBe(1);
  });
  it("rechecks after purging the last of multiple questions without a link trigger", async () => {
    const x = fixture(); x.shared(1); x.question(101, 1);
    x.setClock("2026-11-05T00:00:00Z"); x.question(102, 1);
    await collectExplorationRetention({ DB: x.d1 });
    x.setClock("2027-02-02T00:00:00Z");
    expect(await collectQuestionRequestRetention(x.d1)).toBe(1);
    await collectExplorationRetention({ DB: x.d1 });
    expect(x.count("exploration_shared_requests")).toBe(1);
    x.setClock("2027-02-03T00:00:00Z");
    expect(await collectQuestionRequestRetention(x.d1)).toBe(1);
    expect(x.count("exploration_shared_requests")).toBe(1);
    await collectExplorationRetention({ DB: x.d1 });
    expect(x.count("exploration_shared_requests")).toBe(0);
  });
  it("collects an expired link with no question, but waits for a live lease", async () => {
    const x = fixture(); x.shared(1); x.shared(2); x.job(2); x.claim(2);
    await collectExplorationRetention({ DB: x.d1 });
    expect(x.count("exploration_request_links")).toBe(0);
    expect(x.db.prepare("SELECT request_id FROM exploration_shared_requests").all()).toEqual([{ request_id: id(2) }]);
    x.setClock("2026-11-04T00:15:00Z");
    await collectExplorationRetention({ DB: x.d1 });
    expect(x.count("exploration_shared_requests")).toBe(0);
  });
  it("bounds each link, orphan and tombstone statement to 100", async () => {
    const x = fixture();
    for (let n = 1; n <= 101; n++) {
      x.shared(n); x.question(1000 + n, n); x.shared(2000 + n, false);
      x.db.prepare("INSERT INTO exploration_shared_job_tombstones VALUES(?,?,'2026-10-01T00:00:00Z')").run(id(3000 + n), id(3000 + n));
    }
    expect(await collectExplorationRetention({ DB: x.d1 })).toBe(300);
    expect(x.count("exploration_request_links")).toBe(1);
    expect(x.count("exploration_shared_requests")).toBe(102);
    expect(x.count("exploration_shared_job_tombstones")).toBe(1);
  });
});
