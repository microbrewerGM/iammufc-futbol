import { describe, expect, it } from "vitest";
// @ts-expect-error Node test runtime module.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test runtime module.
import { DatabaseSync } from "node:sqlite";

const id = "a".repeat(64), hash = "b".repeat(64);
const iso = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
const now = iso(Date.now()), expires = iso(Date.parse(now) + 90 * 86400_000), deadline = iso(Date.parse(now) + 86400_000);
const migration = readFileSync("infra/migrations/0013_question_request_results.sql", "utf8");
const spec = () => ({ version: 1, request_id: id, request_revision: 4, locale: "en", canonical_intent: JSON.stringify({ competition: "PL", dimensions: [], entity_id: "fpl:code:1", entity_type: "player", filters: {}, limit: 1, metric: "goals", season: "2024-25", viz: "bar" }), result_path: "/en/q?metric=goals&entity_type=player&entity_id=fpl%3Acode%3A1&season=2024-25&competition=PL&viz=bar&limit=1", data_snapshot_id: "snapshot-1", catalog_digest: hash, transform_code_version: "v1", renderer_version: "v1", artifact_key: hash, expected_cell_state: "computable_now_queued" });
function fresh() {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
  for (const name of ["0001_schema", "0003_p16_dot_plot", "0004_cache_slots", "0005_account_question_history", "0006_season_splits", "0008_exploration_request_links", "0009_manager_era_records", "0010_question_requests", "0011_opponent_labels", "0012_cl_season_stage"]) db.exec(readFileSync(`infra/migrations/${name}.sql`, "utf8"));
  db.exec(migration);
  db.prepare("INSERT INTO question_requests(request_id,account_sub,text,locale,text_hash,status,created_at,updated_at,expires_at) VALUES(?,'owner','Show goals','en',?,'received',?,?,?)").run(id, hash, now, now, expires);
  db.prepare("UPDATE question_requests SET status='triaging',attempt=1,lease_id='lease-1',lease_owner='service',claimed_at=?,lease_expires_at=?,revision=revision+1 WHERE request_id=?").run(now, iso(Date.parse(now)+900_000), id);
  const verdict = JSON.stringify({ version: 1, request_id: id, relevant: true, junk_reason: null, restated_question: "Show goals", tables: [], visuals: [], field_status: [], families: [] });
  db.prepare("UPDATE question_requests SET status='triaged',verdict_json=?,lease_expires_at=NULL,revision=revision+1 WHERE request_id=?").run(verdict, id);
  db.prepare("UPDATE question_requests SET status='no_data',revision=revision+1 WHERE request_id=?").run(id);
  return db;
}
function insert(db: InstanceType<typeof DatabaseSync>, value = spec(), state = "confirmation_required") {
  db.prepare("INSERT INTO question_request_results(request_id,request_revision,state,spec_json,created_at,updated_at,response_deadline,expires_at) VALUES(?,4,?,?,?,?,?,?)").run(id,state,JSON.stringify(value),now,now,deadline,expires);
}
function claim(db: InstanceType<typeof DatabaseSync>) {
  db.exec("UPDATE question_request_results SET state='building',revision=revision+1");
  db.prepare("UPDATE question_request_results SET state='in_review',attempt=1,lease_id='run-1',lease_owner='service',lease_expires_at=?,revision=revision+1").run(iso(Date.parse(now)+900_000));
}
const evidence = () => ({ artifact_key: hash, snapshot_id: "snapshot-1", entity_id: "fpl:code:1", value: 0, attribution: "Source", verified_at: now });
describe("request result persistence foundation", () => {
  it("reapplies safely and preserves existing requests", () => {
    const db = fresh(); insert(db); db.exec(migration);
    expect(db.prepare("SELECT count(*) n FROM question_requests").get().n).toBe(1);
    expect(db.prepare("SELECT revision FROM question_request_results").get().revision).toBe(1);
  });
  it("requires settled parent and forbids initial release", () => {
    const db = fresh(); expect(() => insert(db,spec(),"released")).toThrow();
    db.exec("DELETE FROM question_requests"); expect(() => insert(db)).toThrow();
  });
  it.each(["catalog_digest", "artifact_key", "canonical_intent"])("rejects invalid acceptance %s", field => {
    const db = fresh(); expect(() => insert(db,{ ...spec(), [field]: "bad" })).toThrow();
  });
  it("rejects incomplete specs, duplicate keys and boolean versions", () => {
    const db = fresh(); const value = spec();
    expect(() => insert(db,{ ...value, version: true } as unknown as ReturnType<typeof spec>)).toThrow();
    expect(() => db.prepare("INSERT INTO question_request_results(request_id,request_revision,state,spec_json,created_at,updated_at,response_deadline,expires_at) VALUES(?,4,'confirmation_required',?,?,?, ?,?)").run(id,JSON.stringify(value).replace('"version":1','"version":1,"version":1'),now,now,deadline,expires)).toThrow();
  });
  it("requires a real bounded lease and revision increment", () => {
    const db = fresh(); insert(db);
    expect(() => db.exec("UPDATE question_request_results SET state='building'")).toThrow();
    db.exec("UPDATE question_request_results SET state='building',revision=2");
    expect(() => db.exec("UPDATE question_request_results SET state='in_review',attempt=1,lease_id='x',lease_owner='service',revision=3")).toThrow();
    expect(() => db.prepare("UPDATE question_request_results SET state='in_review',attempt=1,lease_id='x',lease_owner='service',lease_expires_at=?,revision=3").run(iso(Date.parse(now)+901_000))).toThrow();
  });
  it("rejects hidden filters, extra intent text and mismatched result links", () => {
    const db = fresh(), value = spec(), intent = JSON.parse(value.canonical_intent);
    for (const change of [{ filters: { venue: "home" } }, { text: "private" }, { limit: 50 }, { dimensions: ["season"] }]) expect(() => insert(db, { ...value, canonical_intent: JSON.stringify({ ...intent, ...change }) })).toThrow();
    expect(() => insert(db, { ...value, result_path: value.result_path.replace("2024-25", "2023-24") })).toThrow();
    expect(() => insert(db, { ...value, locale: "es" })).toThrow();
    expect(() => insert(db, { ...value, data_snapshot_id: "snapshot with spaces" })).toThrow();
    expect(() => insert(db, { ...value, data_snapshot_id: "snapshot\u0000hidden" })).toThrow();
    for (const entity of [":bad", "_bad", "-bad"]) expect(() => insert(db, { ...value, canonical_intent: JSON.stringify({ ...intent, entity_id: entity }), result_path: value.result_path.replace("fpl%3Acode%3A1", encodeURIComponent(entity)) })).toThrow();
    for (const competition of ["1", "_PL"]) expect(() => insert(db, { ...value, canonical_intent: JSON.stringify({ ...intent, competition }), result_path: value.result_path.replace("competition=PL", `competition=${competition}`) })).toThrow();
    expect(() => insert(db, { ...value, canonical_intent: JSON.stringify(intent,null,2) })).toThrow();
  });
  it("accepts genuine zero evidence and rejects player/snapshot/artifact mismatch", () => {
    const db = fresh(); insert(db); claim(db);
    for (const change of [{ entity_id: "other" }, { snapshot_id: "other" }, { artifact_key: "c".repeat(64) }, { value: null }, { attribution: "" }]) expect(() => db.prepare("UPDATE question_request_results SET state='released',verified_json=?,lease_expires_at=NULL,revision=revision+1").run(JSON.stringify({ ...evidence(), ...change }))).toThrow();
    db.prepare("UPDATE question_request_results SET state='released',verified_json=?,lease_expires_at=NULL,revision=revision+1").run(JSON.stringify(evidence()));
    expect(db.prepare("SELECT state FROM question_request_results").get().state).toBe("released");
  });
  it("marks a release stale only after clearing its evidence", () => {
    const db = fresh(); insert(db); claim(db);
    db.prepare("UPDATE question_request_results SET state='released',verified_json=?,lease_expires_at=NULL,revision=revision+1").run(JSON.stringify(evidence()));
    expect(() => db.exec("UPDATE question_request_results SET state='stale',revision=revision+1")).toThrow();
    db.exec("UPDATE question_request_results SET state='stale',verified_json=NULL,revision=revision+1");
    expect(db.prepare("SELECT state FROM question_request_results").get().state).toBe("stale");
  });
  it("does not permit deletion or replacement while a parent is retained", () => {
    const db = fresh(); insert(db);
    expect(() => db.exec("DELETE FROM question_request_results")).toThrow();
    expect(() => db.exec("UPDATE question_requests SET status='received',revision=revision+1")).toThrow();
  });
});
