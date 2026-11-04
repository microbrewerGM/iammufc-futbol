import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error Node test runtime module.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test runtime module.
import { DatabaseSync } from "node:sqlite";
import { refreshQuestionResult, refreshSchemaReady, readQuestionConfirmations } from "../worker/src/core/question-request-refresh";
import { mapQuestionVerdict, requestResultPath, retainedRequestSpec, type RequestAcceptanceSpec } from "../worker/src/core/question-request-intent";
import { artifactKey, canonicalize, type QueryIntent } from "../worker/src/core/intent";
import { D1QuestionResultStore } from "../worker/src/core/question-request-result-store";
import { completeQuestionResult, confirmQuestionResult } from "../worker/src/core/question-request-results";

type Sqlite = InstanceType<typeof DatabaseSync>;
const opened: Sqlite[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
const id = "a".repeat(64), hash = "b".repeat(64);
const names = ["0001_schema", "0003_p16_dot_plot", "0004_cache_slots", "0005_account_question_history", "0006_season_splits", "0007_exploration_requests", "0008_exploration_request_links", "0009_manager_era_records", "0010_question_requests", "0011_opponent_labels", "0012_cl_season_stage", "0013_question_request_results", "0014_question_request_clarifications", "0015_question_request_notifications", "0016_question_request_refresh", "0017_exploration_null_checks"];
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
class D1 {
  beforeWrite: (() => void) | null = null;
  afterIdentity: (() => void) | null = null;
  constructor(readonly db: Sqlite) {}
  prepare(sql: string) {
    let values: unknown[] = [];
    const read = () => this.db.prepare(sql);
    const writeHook = () => {
      if (sql.startsWith("INSERT INTO question_request_result_refreshes") || sql.startsWith("UPDATE question_request_results")) {
        const hook = this.beforeWrite; this.beforeWrite = null; hook?.();
      }
    };
    const statement = {
      bind(...args: unknown[]) { values = args; return statement; },
      first: async <T>() => read().get(...values) as T | null,
      all: async <T>() => {
        writeHook();
        const results = read().all(...values) as T[];
        if (sql.startsWith("SELECT i.player_id")) { const hook = this.afterIdentity; this.afterIdentity = null; hook?.(); }
        return { results };
      },
      run: async () => { writeHook(); return read().run(...values); },
    };
    return statement;
  }
}
async function fixture(options: { locale?: "en" | "es"; withoutRefresh?: boolean; intent?: Partial<QueryIntent>; badHash?: boolean; oldCode?: boolean } = {}) {
  const db: Sqlite = new DatabaseSync(":memory:"), clockDb: Sqlite = new DatabaseSync(":memory:");
  opened.push(db, clockDb); db.exec("PRAGMA foreign_keys=ON");
  let time = Date.parse("2026-11-04T00:00:00Z"), publications = 0;
  const now = () => iso(time), expires = iso(time + 90 * 86400_000), locale = options.locale ?? "en";
  db.function("strftime", { varargs: true }, (...args: (string | number | null)[]) => {
    const bound = args.map(a => a === "now" ? now() : a);
    return clockDb.prepare(`SELECT strftime(${bound.map(() => "?").join(",")}) AS value`).get(...bound).value;
  });
  for (const name of names) if (!options.withoutRefresh || name !== "0016_question_request_refresh") db.exec(readFileSync(`infra/migrations/${name}.sql`, "utf8"));
  const publish = (snapshot: string) => db.prepare("INSERT INTO snapshots(snapshot_id,created_at,sources_json,row_counts) VALUES(?,?,'{}','{}')").run(snapshot, iso(time + ++publications * 1000));
  publish("snapshot-1");
  db.exec("INSERT INTO players VALUES('fpl:1:2024-25',1,'2024-25','Player','First','Last','FWD','MUN')");
  db.exec("INSERT INTO player_identities VALUES('fpl:1:2024-25','fpl:code:1','fpl',1,'2024-25')");
  const verdict = { version: 1, request_id: id, relevant: true, junk_reason: null, restated_question: "Show goals",
    tables: [{ fields: ["goals"], filters: { season: ["2024-25"], competition: ["PL"], person_id: ["fpl:code:1"], opponent_id: [] } }],
    visuals: [{ kind: "bar", table_index: 0 }], field_status: [{ field: "goals", status: "available" }], families: [] };
  db.prepare("INSERT INTO question_requests(request_id,account_sub,text,locale,text_hash,status,created_at,updated_at,expires_at) VALUES(?,'owner','Show goals',?,?,'received',?,?,?)").run(id, locale, hash, now(), now(), expires);
  db.prepare("UPDATE question_requests SET status='triaging',attempt=1,lease_id='triage-1',lease_owner='service',claimed_at=?,lease_expires_at=?,revision=2").run(now(), iso(time + 900_000));
  db.prepare("UPDATE question_requests SET status='triaged',verdict_json=?,lease_expires_at=NULL,revision=3").run(JSON.stringify(verdict));
  db.exec("UPDATE question_requests SET status='filled',revision=4");
  const mapped = await mapQuestionVerdict(verdict, { requestId: id, revision: 4, locale, snapshotId: "snapshot-1", resolvePerson: async p => p });
  if (mapped.kind !== "ready") throw new Error("fixture_not_ready");
  const intent = { ...mapped.intent, ...options.intent };
  if (intent.season !== "2024-25") {
    db.prepare("INSERT INTO players VALUES(?,2,?,'Player','First','Last','FWD','MUN')").run(`fpl:2:${intent.season}`, intent.season);
    db.prepare("INSERT INTO player_identities VALUES(?,'fpl:code:1','fpl',1,?)").run(`fpl:2:${intent.season}`, intent.season);
  }
  const spec: RequestAcceptanceSpec = { ...mapped.spec, canonical_intent: canonicalize(intent), result_path: requestResultPath(intent, locale), artifact_key: await artifactKey(intent, "snapshot-1") };
  if (options.badHash) spec.artifact_key = hash;
  if (options.oldCode) {
    spec.transform_code_version = "old-version";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode([spec.canonical_intent, spec.data_snapshot_id, spec.transform_code_version, spec.renderer_version].join("|")));
    spec.artifact_key = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
  }
  db.prepare("INSERT INTO question_request_results(request_id,request_revision,state,spec_json,created_at,updated_at,response_deadline,expires_at) VALUES(?,4,'confirmation_required',?,?,?,?,?)")
    .run(id, JSON.stringify(spec), now(), now(), iso(time + 86400_000), expires);
  const d1 = new D1(db), port = d1 as unknown as D1Database, store = new D1QuestionResultStore(port);
  const row = () => db.prepare("SELECT * FROM question_request_results").get();
  const count = () => db.prepare("SELECT refresh_count n FROM question_request_refresh_counts").get().n;
  const refresh = (revision = row().revision, account = "owner") => refreshQuestionResult(port, account, id, revision);
  const confirm = () => confirmQuestionResult({ store, now: () => new Date(time), newLeaseId: () => "lease",
    currentBinding: async () => ({ revision: 4, snapshotId: db.prepare("SELECT snapshot_id FROM snapshots ORDER BY created_at DESC LIMIT 1").get().snapshot_id }) }, id, row().revision, "owner");
  return { db, d1, port, row, count, publish, refresh, confirm, spec, expires, now, advance: (seconds: number) => { time += seconds * 1000; } };
}
describe("same-intent request refresh against the real migration chain", () => {
  it.each(["en", "es"] as const)("renews an owned obsolete %s proposal, preserving intent and retention", async locale => {
    const x = await fixture({ locale }); const before = x.row();
    x.advance(2 * 86400); x.publish("snapshot-2");
    expect(await x.refresh()).toBe("accepted");
    const after = x.row(), spec = JSON.parse(after.spec_json);
    expect(after).toMatchObject({ state: "confirmation_required", revision: before.revision + 1, request_revision: before.request_revision,
      clarification_count: before.clarification_count, expires_at: before.expires_at, created_at: before.created_at, attempt: 0,
      verified_json: null, lease_id: null, lease_owner: null, lease_expires_at: null, response_deadline: iso(Date.parse(x.now()) + 86400_000) });
    expect(spec).toMatchObject({ canonical_intent: x.spec.canonical_intent, locale, result_path: x.spec.result_path, data_snapshot_id: "snapshot-2" });
    expect(spec.artifact_key).not.toBe(x.spec.artifact_key); expect(x.count()).toBe(1);
    expect(await readQuestionConfirmations(x.port, "owner", id)).toEqual([]);
    expect(x.db.prepare("SELECT * FROM question_request_result_refreshes").all()).toEqual([]);
    expect(await x.confirm()).toBe("accepted");
    expect(await readQuestionConfirmations(x.port, "owner", id)).toMatchObject([{ acceptedRevision: 2, spec, expiresAt: x.expires }]);
  });
  it("refreshes code bindings without requiring a different snapshot", async () => {
    const x = await fixture({ oldCode: true }); expect(await x.refresh()).toBe("accepted");
    expect(JSON.parse(x.row().spec_json).transform_code_version).not.toBe("old-version");
  });
  it.each(["building", "in_review", "released", "stale"])("renews eligible %s work without carrying execution authority", async state => {
    const x = await fixture(); expect(await x.confirm()).toBe("accepted");
    if (state === "in_review" || state === "released") {
      x.db.prepare("UPDATE question_request_results SET state='in_review',revision=revision+1,attempt=1,lease_id='old',lease_owner='service',lease_expires_at=?").run(iso(Date.parse(x.now()) + 900_000));
    }
    if (state === "released") {
      x.db.prepare("UPDATE question_request_results SET state='released',revision=revision+1,lease_expires_at=NULL,verified_json=?").run(JSON.stringify({ artifact_key: x.spec.artifact_key, snapshot_id: x.spec.data_snapshot_id,
        entity_id: "fpl:code:1", value: 0, attribution: "Source", verified_at: x.now() }));
    }
    if (state === "stale") x.db.exec("UPDATE question_request_results SET state='stale',revision=revision+1,verified_json=NULL,lease_expires_at=NULL");
    const before = x.row(); expect(before.state).toBe(state); x.publish("snapshot-2");
    expect(await x.refresh()).toBe("accepted");
    expect(x.row()).toMatchObject({ state: "confirmation_required", revision: before.revision + 1, verified_json: null, attempt: 0, lease_id: null, lease_owner: null, lease_expires_at: null });
    const store = new D1QuestionResultStore(x.port);
    expect(await completeQuestionResult({ store, now: () => new Date(x.now()), newLeaseId: () => "new",
      currentBinding: async () => ({ revision: 4, snapshotId: "snapshot-2" }) }, id, before.revision, "service", "old", {})).toBe("conflict");
  });
  it("does not renew an unchanged proposal or leak another account's status", async () => {
    const x = await fixture();
    expect(await x.refresh()).toBe("conflict"); x.publish("snapshot-2");
    expect(await x.refresh(1, "other")).toBe("conflict"); expect(await x.refresh(99)).toBe("conflict");
    expect(await x.refresh(1, "")).toBe("conflict"); expect(x.count()).toBe(0);
  });
  it("fails closed when 0016 is absent or its installation lock remains", async () => {
    const x = await fixture({ withoutRefresh: true });
    expect(await refreshSchemaReady(x.port)).toBe(false); expect(await x.refresh()).toBe("unavailable");
    x.db.exec(readFileSync("infra/migrations/0016_question_request_refresh.sql", "utf8"));
    expect(await refreshSchemaReady(x.port)).toBe(true);
    x.db.exec("CREATE TRIGGER question_request_results_refresh_upgrade_lock BEFORE UPDATE ON question_request_results BEGIN SELECT RAISE(ABORT,'incomplete'); END");
    expect(await refreshSchemaReady(x.port)).toBe(false); expect(await x.refresh()).toBe("unavailable");
  });
  it("requires every installed refresh/history and predecessor guard", async () => {
    const x = await fixture();
    const triggers = x.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('question_requests','question_request_results','question_request_clarifications','question_request_refresh_counts','question_request_result_refreshes','question_request_confirmation_context','question_request_confirmations')").all();
    for (const trigger of triggers) {
      x.db.exec(`DROP TRIGGER ${trigger.name}`);
      expect(await refreshSchemaReady(x.port), trigger.name).toBe(false);
      x.db.exec(trigger.sql);
    }
  });
  it.each(["DELETE FROM player_identities", "UPDATE player_identities SET season='2023-24'", "UPDATE players SET season='2023-24'", "UPDATE player_identities SET source_person_code=2"])("requires exact season-specific identity: %s", async mutation => {
    const x = await fixture(); x.publish("snapshot-2"); x.db.exec(mutation);
    expect(await x.refresh()).toBe("unavailable"); expect(x.count()).toBe(0);
  });
  it.each(["publication", "identity", "parent", "revision", "expiry"])("rolls back a %s race at the SQL write", async race => {
    const x = await fixture(); x.publish("snapshot-2"); const before = x.row();
    x.d1.beforeWrite = () => {
      if (race === "publication") x.publish("snapshot-3");
      if (race === "identity") x.db.exec("DELETE FROM player_identities");
      if (race === "parent") { x.db.exec("DROP TRIGGER question_requests_clarification_state_machine"); x.db.exec("UPDATE question_requests SET revision=revision+1"); }
      if (race === "revision") x.db.exec("UPDATE question_request_results SET state='stale',revision=revision+1");
      if (race === "expiry") x.advance(90 * 86400);
    };
    expect(await x.refresh()).toBe("conflict"); expect(x.count()).toBe(0);
    if (race !== "revision") expect(x.row()).toEqual(before);
    expect(x.db.prepare("SELECT * FROM question_request_result_refreshes").all()).toEqual([]);
  });
  it("rechecks publication after asynchronous digest work", async () => {
    const x = await fixture(); x.publish("snapshot-2"); x.d1.afterIdentity = () => x.publish("snapshot-3");
    expect(await x.refresh()).toBe("conflict"); expect(x.count()).toBe(0);
  });
  it.each([{ season: "1900-01" }, { metric: "xg", season: "2018-19" }])("never promotes missing/unavailable coverage %j", async intent => {
    const x = await fixture({ intent }); x.publish("snapshot-2");
    expect(await x.refresh()).toBe("unavailable"); expect(x.count()).toBe(0);
  });
  it("rejects invalid artifact binding and missing snapshot", async () => {
    const x = await fixture({ badHash: true }); x.publish("snapshot-2");
    expect(await x.refresh()).toBe("unavailable"); expect(x.count()).toBe(0);
    const y = await fixture(); y.db.exec("DELETE FROM snapshots"); expect(await y.refresh()).toBe("unavailable");
  });
  it("caps request-wide refreshes at three, retains approvals and rejects old completions", async () => {
    const x = await fixture(); expect(await x.confirm()).toBe("accepted");
    x.db.prepare("UPDATE question_request_results SET state='in_review',revision=revision+1,attempt=1,lease_id='old',lease_owner='service',lease_expires_at=?").run(iso(Date.parse(x.now()) + 900_000));
    const old = x.row();
    for (let n = 1; n <= 3; n++) { x.publish(`snapshot-${n + 1}`); expect(await x.refresh()).toBe("accepted"); expect(x.count()).toBe(n); expect(await x.confirm()).toBe("accepted"); }
    x.publish("snapshot-5"); expect(await x.refresh()).toBe("exhausted");
    expect(x.db.prepare("UPDATE question_request_results SET state='released',revision=revision+1 WHERE revision=? AND lease_id=?").run(old.revision, old.lease_id).changes).toBe(0);
    const history = await readQuestionConfirmations(x.port, "owner", id);
    expect(history).toHaveLength(4); expect(history[0]!.spec).toEqual(x.spec);
    expect(await readQuestionConfirmations(x.port, "other", id)).toEqual([]);
    expect(history.every(h => !Object.hasOwn(h, "evidence") && !Object.hasOwn(h, "released"))).toBe(true);
  });
  it("bounds history reads and uses the original retention deadline", async () => {
    const x = await fixture(); expect(await x.confirm()).toBe("accepted");
    x.advance(90 * 86400 - 3600); x.publish("snapshot-2"); expect(await x.refresh()).toBe("accepted");
    expect(x.row().response_deadline).toBe(x.expires);
    expect(await x.confirm()).toBe("accepted"); x.advance(3600); x.publish("snapshot-3");
    expect(await x.refresh()).toBe("expired"); expect(await readQuestionConfirmations(x.port, "owner", id)).toEqual([]);
  });
  it("does not infer approval for work confirmed before 0016", async () => {
    const x = await fixture({ withoutRefresh: true }); expect(await x.confirm()).toBe("accepted");
    x.db.exec(readFileSync("infra/migrations/0016_question_request_refresh.sql", "utf8"));
    expect(await readQuestionConfirmations(x.port, "owner", id)).toEqual([]);
  });
  it("keeps retained-spec validation closed and canonical", async () => {
    const x = await fixture(); expect(retainedRequestSpec(x.spec)).not.toBeNull();
    for (const override of [{ extra: "untrusted" }, { canonical_intent: "{}" }, { result_path: "/es/q" }, { locale: "xx" }, { request_revision: 1.5 }, { artifact_key: "bad" }]) {
      expect(retainedRequestSpec({ ...x.spec, ...override })).toBeNull();
    }
  });
});
