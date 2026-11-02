import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error Node test runtime module.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test runtime module.
import { DatabaseSync } from "node:sqlite";
type DB = InstanceType<typeof DatabaseSync>;
const id = "a".repeat(64), hash = "b".repeat(64);
const iso = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
const names = ["0001_schema", "0003_p16_dot_plot", "0004_cache_slots", "0005_account_question_history", "0006_season_splits", "0008_exploration_request_links", "0009_manager_era_records", "0010_question_requests", "0011_opponent_labels", "0012_cl_season_stage", "0013_question_request_results", "0014_question_request_clarifications", "0015_question_request_notifications"];
const sql = readFileSync("infra/migrations/0016_question_request_refresh.sql", "utf8");
const opened: DB[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
function spec(revision = 4) {
  return { version: 1, request_id: id, request_revision: revision, locale: "en",
    canonical_intent: JSON.stringify({ competition: "PL", dimensions: [], entity_id: "fpl:code:1", entity_type: "player", filters: {}, limit: 1, metric: "goals", season: "2024-25", viz: "bar" }),
    result_path: "/en/q?metric=goals&entity_type=player&entity_id=fpl%3Acode%3A1&season=2024-25&competition=PL&viz=bar&limit=1",
    data_snapshot_id: "snapshot-1", catalog_digest: hash, transform_code_version: "v1", renderer_version: "v1",
    artifact_key: hash, expected_cell_state: "computable_now_queued" };
}
function fixture(options: { legacy?: boolean; clarification?: boolean; deferResult?: boolean } = {}) {
  const db: DB = new DatabaseSync(":memory:"), clockDb: DB = new DatabaseSync(":memory:");
  opened.push(db, clockDb); db.exec("PRAGMA foreign_keys=ON");
  let clock = "2026-11-02T00:00:00Z", publications = 0;
  db.function("strftime", { varargs: true }, (...args: (string | number | null)[]) => {
    const bound = args.map(a => a === "now" ? clock : a);
    return clockDb.prepare(`SELECT strftime(${bound.map(() => "?").join(",")}) AS value`).get(...bound).value;
  });
  for (const name of names) db.exec(readFileSync(`infra/migrations/${name}.sql`, "utf8"));
  if (!options.legacy) db.exec(sql);
  const expires = iso(Date.parse(clock) + 90 * 86400_000);
  const parent = () => db.prepare("SELECT * FROM question_requests WHERE request_id=?").get(id);
  const result = () => db.prepare("SELECT * FROM question_request_results WHERE request_id=?").get(id);
  const count = () => db.prepare("SELECT refresh_count n FROM question_request_refresh_counts WHERE request_id=?").get(id).n;
  const history = () => db.prepare("SELECT * FROM question_request_confirmations ORDER BY accepted_revision").all();
  const advance = (seconds: number) => { clock = iso(Date.parse(clock) + seconds * 1000); };
  const publish = (snapshot: string) => db.prepare("INSERT INTO snapshots(snapshot_id,created_at,sources_json,row_counts) VALUES(?,?,'{}','{}')").run(snapshot, iso(Date.parse(clock) + ++publications * 1000));
  publish("snapshot-1");
  db.exec("INSERT INTO players VALUES('fpl:1:2024-25',1,'2024-25','Player','First','Last','FWD','MUN')");
  db.exec("INSERT INTO player_identities VALUES('fpl:1:2024-25','fpl:code:1','fpl',1,'2024-25')");
  db.prepare("INSERT INTO question_requests(request_id,account_sub,text,locale,text_hash,status,created_at,updated_at,expires_at) VALUES(?,'owner','Original question','en',?,'received',?,?,?)").run(id, hash, clock, clock, expires);
  const verdict = JSON.stringify({ version: 1, request_id: id, relevant: true, junk_reason: null, restated_question: "Show goals", tables: [], visuals: [], field_status: [], families: [] });
  const settle = () => {
    db.prepare("UPDATE question_requests SET status='triaging',attempt=attempt+1,lease_id=?,lease_owner='service',claimed_at=?,lease_expires_at=?,retry_after=NULL,updated_at=?,revision=revision+1").run("parent-" + parent().revision, clock, iso(Date.parse(clock) + 900_000), clock);
    db.prepare("UPDATE question_requests SET status='triaged',verdict_json=?,lease_expires_at=NULL,updated_at=?,revision=revision+1").run(verdict, clock);
    db.prepare("UPDATE question_requests SET status='no_data',updated_at=?,revision=revision+1").run(clock);
  };
  settle();
  const insertResult = () => db.prepare("INSERT INTO question_request_results(request_id,request_revision,state,spec_json,created_at,updated_at,response_deadline,expires_at) VALUES(?,4,?,?,?,?,?,?)").run(id, options.clarification ? "clarification_required" : "confirmation_required", options.clarification ? null : JSON.stringify(spec()), clock, clock, iso(Date.parse(clock) + 86400_000), expires);
  if (!options.deferResult) insertResult();
  const command = (next: object = {}, overrides: Record<string, unknown> = {}) => {
    const r = result();
    return { request_id: id, account_sub: "owner", expected_revision: r.revision,
      expected_parent_revision: parent().revision, expected_clarification_count: r.clarification_count,
      expected_spec_json: r.spec_json, expected_expires_at: expires, expected_refresh_count: count(),
      expected_player_id: "fpl:1:2024-25", next_spec_json: JSON.stringify({ ...JSON.parse(r.spec_json), data_snapshot_id: "snapshot-2", artifact_key: "c".repeat(64), ...next }), ...overrides };
  };
  const insertCommand = (c: Record<string, unknown>, ignore = false) => db.prepare(`INSERT ${ignore ? "OR IGNORE " : ""}INTO question_request_result_refreshes(${Object.keys(c).join(",")}) VALUES(${Object.keys(c).map(() => "?").join(",")})`).run(...Object.values(c));
  const refresh = (next: object = {}, overrides: Record<string, unknown> = {}) => insertCommand(command(next, overrides));
  const update = (state: string, fields = "") => db.prepare(`UPDATE question_request_results SET state=?,updated_at=?,revision=revision+1${fields ? "," + fields : ""} WHERE request_id=?`).run(state, clock, id);
  const confirm = () => update("building");
  const lease = () => update("in_review", "attempt=attempt+1,lease_id='execution-" + (result().attempt + 1) + "',lease_owner='service',lease_expires_at='" + iso(Date.parse(clock) + 900_000) + "'");
  const release = () => {
    const s = JSON.parse(result().spec_json);
    const evidence = { artifact_key: s.artifact_key, snapshot_id: s.data_snapshot_id, entity_id: "fpl:code:1", value: 0, attribution: "Source", verified_at: clock };
    db.prepare("UPDATE question_request_results SET state='released',verified_json=?,lease_expires_at=NULL,updated_at=?,revision=revision+1").run(JSON.stringify(evidence), clock);
  };
  const stale = () => update("stale", "verified_json=NULL,lease_expires_at=NULL");
  const clarify = (ready = false) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const q = parent(), r = result();
      db.prepare("UPDATE question_requests SET status='received',attempt=0,verdict_json=NULL,exploration_request_id=NULL,lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,claimed_at=NULL,retry_after=NULL,updated_at=?,revision=revision+1").run(clock);
      const changed = db.prepare("UPDATE question_request_clarifications SET generation=?,parent_revision=?,text='Clarified',submitted_at=? WHERE request_id=?").run(r.clarification_count + 1, q.revision + 1, clock, id).changes;
      if (!changed) db.prepare("INSERT INTO question_request_clarifications VALUES(?,?,?,'Clarified',?)").run(id, r.clarification_count + 1, q.revision + 1, clock);
      db.prepare("UPDATE question_request_results SET state='triaging',request_revision=?,clarification_count=clarification_count+1,spec_json=NULL,verified_json=NULL,attempt=0,lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=?,response_deadline=min(expires_at,strftime('%Y-%m-%dT%H:%M:%SZ',?,'+1 day')),revision=revision+1").run(q.revision + 1, clock, clock);
      settle();
      db.prepare("UPDATE question_request_results SET state=?,request_revision=?,spec_json=?,updated_at=?,response_deadline=min(expires_at,strftime('%Y-%m-%dT%H:%M:%SZ',?,'+1 day')),revision=revision+1").run(ready ? "confirmation_required" : "clarification_required", parent().revision, ready ? JSON.stringify(spec(parent().revision)) : null, clock, clock);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  return { db, parent, result, count, history, advance, publish, command, insertCommand, refresh, update, confirm, lease, release, stale, clarify, insertResult, clock: () => clock, expires };
}
describe("bounded request refresh and confirmation history", () => {
  it("initializes a result inserted between counter hook installation and backfill", () => {
    const x = fixture({ legacy: true, deferResult: true });
    const boundary = sql.indexOf("INSERT OR IGNORE INTO question_request_refresh_counts");
    expect(boundary).toBeGreaterThan(0); x.db.exec(sql.slice(0, boundary)); x.insertResult();
    expect(x.count()).toBe(0); x.db.exec(sql); expect(x.count()).toBe(0);
  });
  it.each(["question_request_result_refreshes_validate", "question_request_confirmation_context_insert"])("fails closed and discards partial command/context before %s", checkpoint => {
    const x = fixture({ legacy: true });
    const boundary = sql.indexOf("CREATE TRIGGER IF NOT EXISTS " + checkpoint);
    expect(boundary).toBeGreaterThan(0); x.db.exec(sql.slice(0, boundary));
    if (checkpoint === "question_request_result_refreshes_validate") {
      x.publish("snapshot-2"); x.insertCommand(x.command());
      expect(x.db.prepare("SELECT * FROM question_request_result_refreshes").all()).toHaveLength(1);
    } else {
      x.db.prepare("INSERT INTO question_request_confirmation_context VALUES(?,?,?,?,?)").run(id, x.result().revision, x.result().spec_json, x.clock(), x.expires);
    }
    expect(() => x.confirm()).toThrow(/migration incomplete|invalid confirmation capture/);
    expect(x.result().state).toBe("confirmation_required");
    x.db.exec(sql);
    expect(x.db.prepare("SELECT * FROM question_request_result_refreshes").all()).toHaveLength(0);
    expect(x.db.prepare("SELECT * FROM question_request_confirmation_context").all()).toHaveLength(0);
    expect(x.history()).toHaveLength(0); expect(x.count()).toBe(0);
    x.confirm(); expect(x.history()).toHaveLength(1);
  });
  it("blocks confirmation while only its capture trigger has been installed", () => {
    const x = fixture({ legacy: true });
    x.db.exec(sql.slice(0, sql.indexOf("CREATE TRIGGER IF NOT EXISTS question_request_results_record_confirmation")));
    expect(() => x.confirm()).toThrow(/migration incomplete|invalid confirmation capture/);
    expect(x.result().state).toBe("confirmation_required");
    expect(x.db.prepare("SELECT * FROM question_request_confirmation_context").all()).toHaveLength(0);
    x.db.exec(sql); x.confirm(); expect(x.history()).toHaveLength(1);
  });
  it("records only an actual separate confirmation with exact proposal revision and no private prose", () => {
    const x = fixture(), proposal = x.result(); expect(x.history()).toHaveLength(0);
    x.confirm();
    expect(x.history()).toEqual([{ request_id: id, accepted_revision: proposal.revision, spec_json: proposal.spec_json, accepted_at: x.clock(), expires_at: x.expires }]);
    expect(x.db.prepare("SELECT * FROM question_request_confirmation_context").all()).toHaveLength(0);
    expect(x.count()).toBe(0);
  });
  it.each(["confirmation_required", "building", "in_review", "released", "stale"])("renews obsolete %s without confirming or retaining execution evidence", state => {
    const x = fixture();
    if (["building", "in_review", "released"].includes(state)) x.confirm();
    if (["in_review", "released"].includes(state)) x.lease();
    if (state === "released") x.release();
    if (state === "stale") x.stale();
    const old = x.result(), parent = x.parent(), approvals = x.history().length;
    x.advance(60); x.publish("snapshot-2"); x.refresh();
    const next = x.result();
    for (const key of ["request_id", "request_revision", "clarification_count", "created_at", "expires_at"]) expect(next[key]).toBe(old[key]);
    expect(x.parent()).toEqual(parent);
    expect(next).toMatchObject({ state: "confirmation_required", revision: old.revision + 1, attempt: 0, verified_json: null, lease_id: null, lease_owner: null, lease_expires_at: null, updated_at: x.clock(), response_deadline: iso(Date.parse(x.clock()) + 86400_000) });
    expect(x.count()).toBe(1); expect(x.history()).toHaveLength(approvals);
    expect(x.db.prepare("SELECT * FROM question_request_result_refreshes").all()).toHaveLength(0);
    const accepted = next.spec_json; x.confirm();
    expect(x.history().at(-1)).toMatchObject({ accepted_revision: next.revision, spec_json: accepted });
  });
  it("keeps stale terminal except for renewal then separate confirmation", () => {
    const x = fixture(); x.stale();
    expect(() => x.confirm()).toThrow();
    expect(() => x.refresh({ data_snapshot_id: "snapshot-1", artifact_key: hash })).toThrow();
    x.publish("snapshot-2"); x.refresh(); expect(x.result().state).toBe("confirmation_required"); x.confirm();
  });
  it.each([
    { account_sub: "other" }, { expected_revision: 99 }, { expected_parent_revision: 99 },
    { expected_clarification_count: 1 }, { expected_spec_json: "{}" }, { expected_expires_at: "2027-01-01T00:00:00Z" },
    { expected_refresh_count: 1 }, { expected_refresh_count: -1 }, { expected_player_id: "wrong" }, { request_id: "d".repeat(64) }
  ])("rejects a wrong CAS fence %j atomically", overrides => {
    const x = fixture(); x.publish("snapshot-2"); const before = x.result();
    expect(() => x.refresh({}, overrides)).toThrow(); expect(x.result()).toEqual(before); expect(x.count()).toBe(0);
    expect(x.db.prepare("SELECT * FROM question_request_result_refreshes").all()).toHaveLength(0);
  });
  it.each(["no_data", "no_rights", "computable_but_expensive", "unresolved"])("never promotes a %s cell", expected_cell_state => {
    const x = fixture(); x.publish("snapshot-2"); expect(() => x.refresh({ expected_cell_state })).toThrow(); expect(x.count()).toBe(0);
  });
  it("rejects a publication between the read and write, including a missing snapshot", () => {
    const x = fixture(); x.publish("snapshot-2"); const c = x.command(); x.publish("snapshot-3");
    expect(() => x.insertCommand(c)).toThrow(); expect(x.count()).toBe(0);
    x.db.exec("DELETE FROM snapshots"); expect(() => x.insertCommand(c)).toThrow();
  });
  it.each(["DELETE FROM player_identities", "UPDATE player_identities SET person_id='fpl:code:2',source_person_code=2", "UPDATE player_identities SET season='2023-24'", "UPDATE players SET season='2023-24'"])("fences identity races: %s", mutation => {
    const x = fixture(); x.publish("snapshot-2"); const c = x.command(); x.db.exec(mutation);
    expect(() => x.insertCommand(c)).toThrow(); expect(x.count()).toBe(0);
  });
  it.each([
    { locale: "es" }, { result_path: "/en/q?other" }, { request_revision: 5 }, { request_id: "d".repeat(64) },
    { canonical_intent: JSON.stringify({ ...JSON.parse(spec().canonical_intent), metric: "assists" }) },
    { canonical_intent: JSON.stringify({ ...JSON.parse(spec().canonical_intent), entity_id: "fpl:code:2" }) },
    { canonical_intent: JSON.stringify({ ...JSON.parse(spec().canonical_intent), season: "2023-24" }) },
    { artifact_key: "bad" }, { extra: "untrusted" }, { version: true }
  ])("preserves closed spec and semantics: %j", next => {
    const x = fixture(); x.publish("snapshot-2"); expect(() => x.refresh(next)).toThrow(); expect(x.count()).toBe(0);
  });
  it("rejects malformed JSON without incrementing the count", () => {
    const x = fixture(); x.publish("snapshot-2"); expect(() => x.refresh({}, { next_spec_json: "{" })).toThrow(); expect(x.count()).toBe(0);
  });
  it("cannot suppress a partial renewal using an outer INSERT OR IGNORE", () => {
    const x = fixture(); x.publish("snapshot-2"); const before = x.result();
    const c = x.command(); c.next_spec_json = String(c.next_spec_json) + " ".repeat(16384);
    expect(() => x.insertCommand(c, true)).toThrow(); expect(x.result()).toEqual(before); expect(x.count()).toBe(0);
    // Simulate a future table constraint that IGNORE suppresses after the count
    // write: the final complete-result assertion must still force rollback.
    x.db.exec("CREATE TRIGGER simulated_ignored_result BEFORE UPDATE ON question_request_results BEGIN SELECT RAISE(IGNORE); END");
    expect(() => x.insertCommand(x.command(), true)).toThrow(/incomplete request refresh/);
    expect(x.result()).toEqual(before); expect(x.count()).toBe(0);
    expect(x.db.prepare("SELECT * FROM question_request_result_refreshes").all()).toHaveLength(0);
  });
  it.each(["verified_json='{}'", "lease_expires_at='2026-11-02T00:01:00Z'", "updated_at='2026-11-02T00:00:0xZ'"])("cannot leave capture context via UPDATE OR IGNORE: %s", invalid => {
    const x = fixture();
    expect(() => x.db.exec("UPDATE OR IGNORE question_request_results SET state='building',revision=revision+1," + invalid)).toThrow(/invalid confirmation fields/);
    expect(x.result().state).toBe("confirmation_required"); expect(x.history()).toHaveLength(0);
    expect(x.db.prepare("SELECT * FROM question_request_confirmation_context").all()).toHaveLength(0);
    x.confirm(); expect(x.history()).toHaveLength(1);
  });
  it("supports a catalog/code binding change on the current snapshot", () => {
    const x = fixture(); x.refresh({ data_snapshot_id: "snapshot-1", catalog_digest: "d".repeat(64), artifact_key: hash });
    expect(x.count()).toBe(1); expect(x.result().state).toBe("confirmation_required");
  });
  it("caps refreshes at three and does not reset on ordinary transitions or replay", () => {
    const x = fixture(); x.confirm();
    for (let n = 1; n <= 3; n++) {
      x.publish("snapshot-" + (n + 1)); x.refresh({ data_snapshot_id: "snapshot-" + (n + 1) }); x.confirm(); x.lease(); x.release(); x.stale();
      expect(x.count()).toBe(n);
      for (const name of names) x.db.exec(readFileSync(`infra/migrations/${name}.sql`, "utf8")); x.db.exec(sql); x.db.exec(sql);
      expect(x.count()).toBe(n);
    }
    x.publish("snapshot-5"); const before = x.result(); expect(() => x.refresh({ data_snapshot_id: "snapshot-5" })).toThrow();
    expect(x.result()).toEqual(before); expect(x.count()).toBe(3); expect(x.history()).toHaveLength(4);
    expect(() => x.db.exec("UPDATE question_request_refresh_counts SET refresh_count=0")).toThrow();
    expect(() => x.db.exec("DELETE FROM question_request_refresh_counts")).toThrow();
    x.db.prepare("INSERT OR REPLACE INTO question_request_refresh_counts VALUES(?,0)").run(id); expect(x.count()).toBe(3);
    expect(() => x.db.exec("UPDATE question_request_refresh_counts SET refresh_count=4")).toThrow();
  });
  it("preserves clarification generations and counter storage through their full lifecycle", () => {
    const x = fixture({ clarification: true });
    x.clarify(); x.clarify(); x.clarify(true);
    expect(x.result().clarification_count).toBe(3); expect(x.count()).toBe(0);
    x.confirm(); x.publish("snapshot-2"); x.refresh(); expect(x.result().clarification_count).toBe(3); expect(x.count()).toBe(1);
    expect(() => x.db.exec("UPDATE question_request_results SET state='triaging',clarification_count=0,revision=revision+1")).toThrow();
    expect(x.db.prepare("SELECT generation FROM question_request_clarifications").get().generation).toBe(3);
  });
  it("uses DB time and original expiry even when the old proposal deadline expired", () => {
    const x = fixture(); x.advance(90 * 86400 - 3600); x.publish("snapshot-2"); x.refresh();
    expect(x.result().response_deadline).toBe(x.expires); expect(x.result().expires_at).toBe(x.expires);
    x.advance(3600); x.publish("snapshot-3"); expect(() => x.refresh({ data_snapshot_id: "snapshot-3" })).toThrow();
    expect(x.count()).toBe(1);
  });
  it("does not accept future audit timestamps as the refresh clock", () => {
    const x = fixture(); x.publish("snapshot-2");
    // A future audit time is legal within the existing 300s tolerance, but a
    // refresh cannot turn it into a future deadline.
    x.db.prepare("UPDATE question_request_results SET state='stale',updated_at=?,revision=revision+1").run(iso(Date.parse(x.clock()) + 120_000));
    expect(() => x.refresh()).toThrow(); expect(x.count()).toBe(0);
  });
  it("rejects old completion and lease after renewal", () => {
    const x = fixture(); x.confirm(); x.lease(); const old = x.result(); x.publish("snapshot-2"); x.refresh();
    expect(x.db.prepare("UPDATE question_request_results SET state='released',revision=revision+1 WHERE request_id=? AND revision=? AND lease_id=?").run(id, old.revision, old.lease_id).changes).toBe(0);
    expect(() => x.release()).toThrow(); expect(() => x.lease()).toThrow(); expect(x.result().state).toBe("confirmation_required");
  });
  it("keeps history immutable and denies standalone/replaced approval records", () => {
    const x = fixture(), proposed = x.result();
    const insert = () => x.db.prepare("INSERT OR REPLACE INTO question_request_confirmations VALUES(?,?,?,?,?)").run(id, proposed.revision, proposed.spec_json, x.clock(), x.expires);
    expect(insert).toThrow(); x.confirm(); expect(insert).toThrow();
    expect(() => x.db.exec("UPDATE question_request_confirmations SET accepted_at='2026-11-03T00:00:00Z'")).toThrow();
    expect(() => x.db.exec("DELETE FROM question_request_confirmations")).toThrow();
    expect(() => x.db.prepare("INSERT INTO question_request_confirmation_context VALUES(?,?,?,?,?)").run(id, proposed.revision, proposed.spec_json, x.clock(), x.expires)).toThrow();
    expect(x.history()).toHaveLength(1);
  });
  it.each(["building", "stale"])("does not infer approvals for legacy %s work", state => {
    const x = fixture({ legacy: true }); x.confirm(); if (state === "stale") x.stale();
    x.db.exec(sql); expect(x.history()).toHaveLength(0); expect(x.count()).toBe(0);
    const r = x.result();
    expect(() => x.db.prepare("INSERT INTO question_request_confirmations VALUES(?,?,?,?,?)").run(id, r.revision - 1, r.spec_json, x.clock(), x.expires)).toThrow();
  });
  it("retains history/count until the parent is removed and cascades at original expiry", () => {
    const x = fixture(); x.confirm(); x.publish("snapshot-2"); x.refresh(); x.confirm();
    expect(() => x.db.exec("DELETE FROM question_request_confirmations")).toThrow();
    x.advance(90 * 86400); x.db.prepare("DELETE FROM question_requests WHERE request_id=? AND expires_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')").run(id);
    for (const table of ["question_request_results", "question_request_refresh_counts", "question_request_confirmations", "question_request_confirmation_context", "question_request_result_refreshes"]) expect(x.db.prepare(`SELECT count(*) n FROM ${table}`).get().n).toBe(0);
  });
  it("preserves old retry/expiration branches and exact readiness trigger name", () => {
    const x = fixture(); x.confirm(); x.lease(); x.advance(900); x.update("building", "lease_expires_at=NULL"); expect(x.count()).toBe(0);
    x.lease(); x.advance(900); x.update("building", "lease_expires_at=NULL"); x.lease(); x.advance(900); x.update("failed", "lease_expires_at=NULL");
    expect(x.result().state).toBe("failed"); expect(x.count()).toBe(0);
    const y = fixture({ clarification: true }); y.advance(86400); y.update("expired"); expect(y.result().state).toBe("expired");
    expect(x.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='question_request_results_generation_transition'").all()).toHaveLength(1);
    expect(x.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='question_request_results_refresh_upgrade_lock'").all()).toHaveLength(0);
  });
});
