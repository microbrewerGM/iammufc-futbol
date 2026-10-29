import { describe, expect, it } from "vitest";
import { Hono } from "hono";
// @ts-expect-error Node's built-in modules are available in the configured test runtime.
import { readFileSync } from "node:fs";
// @ts-expect-error Node's built-in SQLite module is available in the configured test runtime.
import { DatabaseSync } from "node:sqlite";
import { ackQuestion, claimQuestion, readQuestions, sweepQuestions, type TriageCaller, type TriageDeps, type TriageOperation, type TriageQuestion, type TriageStore } from "../worker/src/core/question-triage-bridge";
import { createQuestionTriageBridgeRouter, type QuestionTriageEnv } from "../worker/src/routes/question-triage-bridge";
import { D1QuestionTriageStore } from "../worker/src/routes/question-triage-sweep";
import type { AccessIdentity } from "../worker/src/security/auth";

const service: TriageCaller = { service: "triage_runner", capability: "question:triage:v1" };
const id = "a".repeat(64);
const blank: Omit<TriageQuestion, "request_id"> = { locale: "en", text: "How many goals?", account_sub: "verified-human-sub", status: "received", attempt: 0, lease_id: null, lease_owner: null, lease_expires_at: null, retry_after: null, revision: 1, claimed_at: null, verdict_json: null, exploration_request_id: null };
const envelope = (kind: string, payload: unknown) => JSON.stringify({ version: 1, kind, payload });
const payload = (result: { ok: boolean; body?: string }) => JSON.parse(result.body!).payload;

class Store implements TriageStore {
  rows = new Map<string, TriageQuestion>(); ops = new Map<string, TriageOperation>(); admissions: unknown[] = []; settlements = 0; throwFirstSettle = false;
  async page(after: string | null, limit: number) { return [...this.rows.values()].filter(r => r.status === "received" && (!after || r.request_id > after)).sort((a, b) => a.request_id.localeCompare(b.request_id)).slice(0, limit); }
  async get(requestId: string) { return this.rows.get(requestId) ?? null; }
  async operation(serviceName: string, type: "claim" | "ack", operationId: string) { return this.ops.get(`${serviceName}:${type}:${operationId}`) ?? null; }
  async claim(_row: TriageQuestion, next: TriageQuestion, op: TriageOperation) { this.rows.set(next.request_id, next); this.ops.set(`${op.service}:${op.type}:${op.operation_id}`, op); return true; }
  async ack(_row: TriageQuestion, next: TriageQuestion, op: TriageOperation, admission: unknown) { this.rows.set(next.request_id, next); this.ops.set(`${op.service}:${op.type}:${op.operation_id}`, op); if (admission) this.admissions.push(admission); return true; }
  async sweepRows(kind: "expired" | "triaged" | "queued") { return [...this.rows.values()].filter(r => kind === "expired" ? r.status === "triaging" : r.status === kind); }
  async settle(_row: TriageQuestion, next: TriageQuestion) { this.settlements++; if (this.throwFirstSettle && this.settlements === 1) throw Error("row-specific abort"); this.rows.set(next.request_id, next); return true; }
  async queueResult() { return "pending" as const; }
}
function setup(row: TriageQuestion = { ...blank, request_id: id }): { store: Store; deps: TriageDeps } {
  const store = new Store(); store.rows.set(row.request_id, row);
  return { store, deps: { store, cursorKey: new TextEncoder().encode("test cursor key is not a credential"), now: () => new Date("2026-10-29T10:00:00Z"), newLeaseId: () => "random-lease-1" } };
}
function claimedRow(): TriageQuestion { return { ...blank, request_id: id, status: "triaging", attempt: 1, lease_id: "lease-a", lease_owner: service.service, lease_expires_at: "2026-10-29T10:15:00Z", claimed_at: "2026-10-29T10:00:00Z", revision: 2 }; }
function verdict(overrides: Record<string, unknown> = {}) { return { version: 1, request_id: id, relevant: true, junk_reason: null, restated_question: "Compare goals by season", tables: [], visuals: [], field_status: [], families: [], ...overrides }; }

class SqliteStatement {
  private values: unknown[] = [];
  constructor(private readonly db: InstanceType<typeof DatabaseSync>, private readonly sql: string, private readonly onFirst?: () => void | Promise<void>) {}
  bind(...values: unknown[]) { this.values = values; return this; }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.values) as T[] }; }
  async first<T>() { const value = (this.db.prepare(this.sql).get(...this.values) as T | undefined) ?? null; await this.onFirst?.(); return value; }
}
class SqliteD1 {
  afterQuestionRead?: () => void | Promise<void>;
  constructor(private readonly db: InstanceType<typeof DatabaseSync>) {}
  prepare(sql: string) { return new SqliteStatement(this.db, sql, sql.includes("FROM question_requests WHERE request_id=?") ? () => { const hook = this.afterQuestionRead; this.afterQuestionRead = undefined; hook?.(); } : undefined); }
  async batch(statements: SqliteStatement[]) {
    this.db.exec("BEGIN");
    try { const result = []; for (const statement of statements) result.push(await statement.all()); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
function sqliteForBridge() {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
  for (const name of ["0001_schema.sql", "0003_p16_dot_plot.sql", "0004_cache_slots.sql", "0005_account_question_history.sql", "0006_season_splits.sql", "0008_exploration_request_links.sql", "0009_manager_era_records.sql", "0010_question_requests.sql"]) db.exec(readFileSync(`infra/migrations/${name}`, "utf8"));
  const created = new Date(), createdAt = created.toISOString().replace(/\.\d{3}Z$/, "Z"), expires = new Date(created.getTime() + 90 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  db.prepare(`INSERT INTO question_requests(request_id,account_sub,text,locale,text_hash,status,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,'received',?,?,?)`).run(id,"stored-account-sub","How many goals?","en","b".repeat(64),createdAt,createdAt,expires);
  return { db, d1: new SqliteD1(db) };
}
function addQuestion(db: InstanceType<typeof DatabaseSync>, requestId: string, status: "received" | "triaging" | "queued" = "received", leaseOffsetSeconds = 900, owner = service.service, attempt = 1) {
  const createdDate = new Date(Date.now() + (leaseOffsetSeconds < 0 ? -120_000 : 0)), created = createdDate.toISOString().replace(/\.\d{3}Z$/, "Z"), retention = new Date(createdDate.getTime() + 90 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const expires = new Date(createdDate.getTime() + (leaseOffsetSeconds < 0 ? 30_000 : leaseOffsetSeconds * 1000)).toISOString().replace(/\.\d{3}Z$/, "Z");
  db.prepare(`INSERT INTO question_requests(request_id,account_sub,text,locale,text_hash,status,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,'received',?,?,?)`).run(requestId, `account-${requestId.slice(0, 6)}`, "How many goals?", "en", requestId, created, created, retention);
  if (status === "triaging") db.prepare(`UPDATE question_requests SET status='triaging',attempt=?,lease_id='lease-a',lease_owner=?,lease_expires_at=?,claimed_at=?,revision=2 WHERE request_id=?`).run(attempt, owner, expires, created, requestId);
  return requestId;
}
function sqliteDeps(d1: SqliteD1, clock = "now"): TriageDeps {
  return { store: new D1QuestionTriageStore(d1 as unknown as D1Database), cursorKey: new TextEncoder().encode("fixture cursor signing key"), now: () => clock === "now" ? new Date() : new Date(clock), newLeaseId: () => "lease-new" };
}
function addPublishedQueue(db: InstanceType<typeof DatabaseSync>, questionId: string, requestId: string, coverage: "complete" | "partial" | "missing") {
  const createdDate = new Date(), created = createdDate.toISOString().replace(/\.\d{3}Z$/, "Z"), expires = new Date(createdDate.getTime() + 30 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z"), jobId = questionId;
  const req = JSON.stringify({ version: 1, family: "arrival_manager", population: "first_team_available", joining_basis: "effective_first_team_spell_entry", academy_basis: "documented_first_team_promotion", visualization: "table", as_of: created.slice(0, 10) });
  db.prepare("INSERT INTO exploration_shared_requests(request_id,contract_version,request_json,created_at) VALUES(?,1,?,?)").run(requestId, req, created);
  db.exec("DROP TRIGGER IF EXISTS exploration_shared_jobs_initial_insert; DROP TRIGGER IF EXISTS exploration_shared_jobs_publication_shape_insert;");
  const publication = JSON.stringify({ artifact_key: "a".repeat(64), request_id: requestId, validation_record_id: "validation-1", publication_id: "publication-1", loaded_snapshot_id: "snapshot-1", coverage_record_id: "coverage-1", loaded_at: created, lineage: ["lineage-1"] });
  db.prepare(`INSERT INTO exploration_shared_jobs(job_id,request_id,status,attempt,lease_id,lease_owner,claimed_at,publication_json,admitted_at,created_at,updated_at,expires_at) VALUES(?,?,'published',1,'lease-a','runner-a',?,?,?, ?,?,?)`).run(jobId, requestId, created, publication, created, created, created, expires);
  db.prepare(`INSERT INTO exploration_shared_results(request_id,snapshot_id,artifact_key,transform_code_version,renderer_version,roster_snapshot_id,feasibility,coverage,population_count,assigned_json,unknown_json,lineage_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,0,'[]','[]','[]',?,?)`).run(requestId, "snapshot-1", "a".repeat(64), "transform-v1", "renderer-v1", coverage === "missing" ? null : "roster-1", coverage === "missing" ? "no_data" : "available", coverage, created, expires);
  db.exec("DROP TRIGGER IF EXISTS question_requests_state_machine;");
  const questionVerdict = JSON.stringify(verdict({ request_id: questionId, tables: [{ fields: ["goals"], filters: { season: ["2010-11"], competition: ["PL"], opponent_id: [], person_id: [] } }] }));
  db.prepare("UPDATE question_requests SET status='queued',attempt=1,lease_id='lease-a',lease_owner='runner-a',lease_expires_at=NULL,claimed_at=?,verdict_json=?,exploration_request_id=?,revision=3 WHERE request_id=?").run(created, questionVerdict, requestId, questionId);
}

describe("question triage service bridge", () => {
  it("projects only question fields and caps reads at ten", async () => {
    const { store, deps } = setup();
    for (let n = 1; n <= 12; n++) store.rows.set(n.toString(16).padStart(64, "0"), { ...blank, request_id: n.toString(16).padStart(64, "0"), account_sub: `private-${n}` });
    const result = await readQuestions(deps, service, envelope("read", { cursor: null, limit: 10 }));
    expect(result.ok).toBe(true); expect(payload(result).questions).toHaveLength(10);
    expect(payload(result).questions[0]).toEqual({ request_id: "0".repeat(63) + "1", locale: "en", text: "How many goals?" });
    expect(JSON.stringify(payload(result))).not.toContain("private-");
  });

  it("claims with a fresh bounded lease and persists claim idempotency", async () => {
    const { store, deps } = setup();
    const result = await claimQuestion(deps, service, envelope("claim", { request_id: id, expected_attempt: 0, operation_id: "qt:claim-1" }));
    expect(payload(result).outcome).toBe("claimed");
    expect(store.rows.get(id)).toMatchObject({ status: "triaging", attempt: 1, lease_id: "random-lease-1", lease_owner: service.service, lease_expires_at: "2026-10-29T10:15:00Z" });
    const replay = await claimQuestion(deps, service, envelope("claim", { request_id: id, expected_attempt: 0, operation_id: "qt:claim-1" }));
    expect(payload(replay).outcome).toBe("claimed");
  });

  it("rejects malformed UTF-16, invalid verdict shape, and blank relevant restatements", async () => {
    const { deps } = setup(claimedRow());
    const ack = (v: unknown, op: string) => ackQuestion(deps, service, envelope("ack", { request_id: id, attempt: 1, lease_id: "lease-a", operation_id: `qt:ack-${op}`, outcome: { status: "verdict", verdict: v } }));
    expect(payload(await ack(verdict({ restated_question: "   " }), "blank")).outcome).toBe("invalid_verdict");
    expect(payload(await ack(verdict({ tables: [{ fields: ["not_in_catalog"], filters: { season: [], competition: [], opponent_id: [], person_id: [] } }] }), "allowlist")).outcome).toBe("invalid_verdict");
    expect(payload(await ack(verdict({ restated_question: "Check evil.example" }), "screen")).outcome).toBe("invalid_verdict");
    const loneSurrogate = envelope("ack", { request_id: id, attempt: 1, lease_id: "lease-a", operation_id: "qt:surrogate", outcome: { status: "verdict", verdict: verdict({ restated_question: "bad\ud800" }) } });
    expect(await ackQuestion(deps, service, loneSurrogate)).toEqual({ ok: false, error: "malformed" });
  });

  it("settles zero cells as no_data and derives shared admission identity from the stored row", async () => {
    const { store, deps } = setup(claimedRow());
    const zero = await ackQuestion(deps, service, envelope("ack", { request_id: id, attempt: 1, lease_id: "lease-a", operation_id: "qt:zero", outcome: { status: "verdict", verdict: verdict() } }));
    expect(payload(zero)).toMatchObject({ outcome: "accepted", status: "no_data" });
    expect(store.rows.get(id)?.status).toBe("no_data");

    const second = "b".repeat(64), row = { ...claimedRow(), request_id: second, account_sub: "stored-account-only" }; store.rows.set(second, row);
    const familyVerdict = verdict({ request_id: second, families: ["arrival_manager"] });
    const admitted = await ackQuestion(deps, service, envelope("ack", { request_id: second, attempt: 1, lease_id: "lease-a", operation_id: "qt:family", outcome: { status: "verdict", verdict: familyVerdict } }));
    expect(payload(admitted)).toMatchObject({ outcome: "accepted", status: "queued" });
    expect(store.admissions[0]).toMatchObject({ accountSub: "stored-account-only", requestJson: expect.stringContaining("arrival_manager") });
  });

  it("commits the triaging-to-triaged-to-queued path with shared rows atomically", async () => {
    const { db, d1 } = sqliteForBridge();
    const deps: TriageDeps = { store: new D1QuestionTriageStore(d1 as unknown as D1Database), cursorKey: new TextEncoder().encode("test cursor key is not a credential"), now: () => new Date(), newLeaseId: () => "unique-lease" };
    const claim = await claimQuestion(deps, service, envelope("claim", { request_id: id, expected_attempt: 0, operation_id: "qt:d1-claim" }));
    expect(payload(claim).outcome).toBe("claimed");
    const accepted = await ackQuestion(deps, service, envelope("ack", { request_id: id, attempt: 1, lease_id: "unique-lease", operation_id: "qt:d1-ack", outcome: { status: "verdict", verdict: verdict({ families: ["arrival_manager"] }) } }));
    expect(payload(accepted)).toMatchObject({ outcome: "accepted", status: "queued" });
    expect(db.prepare("SELECT status,revision FROM question_requests WHERE request_id=?").get(id)).toEqual({ status: "queued", revision: 4 });
    expect(db.prepare("SELECT account_sub FROM exploration_request_links").get()).toEqual({ account_sub: "stored-account-sub" });
    expect(db.prepare("SELECT count(*) AS n FROM exploration_shared_requests").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM exploration_shared_jobs").get()).toEqual({ n: 1 });
    db.close();
  });

  it("stale_lease_ack_conflicts and ack_replay_returns_replayed with SQLite claim replay and cursor rules", async () => {
    const { db, d1 } = sqliteForBridge();
    const deps = sqliteDeps(d1);
    const claimed = await claimQuestion(deps, service, envelope("claim", { request_id: id, expected_attempt: 0, operation_id: "qt:sqlite-claim" }));
    expect(payload(claimed).outcome).toBe("claimed");
    expect(payload(await claimQuestion(deps, service, envelope("claim", { request_id: id, expected_attempt: 0, operation_id: "qt:sqlite-claim" }))).outcome).toBe("claimed");
    expect(payload(await claimQuestion(deps, service, envelope("claim", { request_id: id, expected_attempt: 1, operation_id: "qt:sqlite-claim" }))).outcome).toBe("conflict");
    const expiredReplay = await claimQuestion(sqliteDeps(d1, new Date(Date.now() + 901_000).toISOString()), service, envelope("claim", { request_id: id, expected_attempt: 0, operation_id: "qt:sqlite-claim" }));
    expect(payload(expiredReplay).outcome).toBe("conflict");

    const ackBody = { request_id: id, attempt: 1, lease_id: "lease-new", operation_id: "qt:sqlite-ack", outcome: { status: "verdict", verdict: verdict() } };
    const acked = await ackQuestion(deps, service, envelope("ack", ackBody));
    expect(payload(acked)).toMatchObject({ outcome: "accepted", status: "no_data" });
    expect(payload(await ackQuestion(deps, service, envelope("ack", ackBody))).outcome).toBe("replayed");
    expect(payload(await ackQuestion(deps, service, envelope("ack", { ...ackBody, outcome: { status: "failed", reason: "source_unavailable" } }))).outcome).toBe("conflict");

    const staleId = "c".repeat(64);
    addQuestion(db, staleId, "triaging", -1);
    const staleAck = (overrides: Record<string, unknown> = {}, caller = service) => ackQuestion(deps, caller, envelope("ack", { request_id: staleId, attempt: 1, lease_id: "lease-a", operation_id: `qt:stale-${Object.keys(overrides).join("-") || caller.service}`, outcome: { status: "failed", reason: "source_unavailable" }, ...overrides }));
    expect(payload(await staleAck()).outcome).toBe("conflict");
    for (const [label, caller] of [
      ["lease", service],
      ["attempt", service],
      ["owner", { ...service, service: "other_runner" }],
    ] as const) {
      const requestId = label === "lease" ? "d".repeat(64) : label === "attempt" ? "e".repeat(64) : "f".repeat(64);
      addQuestion(db, requestId, "triaging", 900, label === "owner" ? "another_runner" : service.service);
      const result = await ackQuestion(deps, caller, envelope("ack", { request_id: requestId, attempt: label === "attempt" ? 2 : 1, lease_id: label === "lease" ? "wrong-lease" : "lease-a", operation_id: `qt:wrong-${label}`, outcome: { status: "failed", reason: "source_unavailable" } }));
      expect(payload(result).outcome, label).toBe("conflict");
    }

    const second = "b".repeat(64), third = "9".repeat(64); addQuestion(db, second); addQuestion(db, third);
    const page = payload(await readQuestions(deps, service, envelope("read", { cursor: null, limit: 1 })));
    expect(page.next_cursor).toBeTruthy();
    const forged = await readQuestions(deps, service, envelope("read", { cursor: `${page.next_cursor}x`, limit: 1 }));
    expect(forged.ok ? null : forged.error).toBe("invalid_cursor");
    const crossCaller = await readQuestions(deps, { ...service, service: "other_runner" }, envelope("read", { cursor: page.next_cursor, limit: 1 }));
    expect(crossCaller.ok ? null : crossCaller.error).toBe("invalid_cursor");
    db.close();
  });

  it("sweep_and_ack_race_one_winner and unexpired sweep fencing use SQLite", async () => {
    const { db, d1 } = sqliteForBridge();
    const expiredId = "c".repeat(64); addQuestion(db, expiredId, "triaging", -1);
    const deps = sqliteDeps(d1);
    d1.afterQuestionRead = async () => { expect(await sweepQuestions(deps, 100, "expired")).toEqual({ moved: 1 }); };
    const result = await ackQuestion(deps, service, envelope("ack", { request_id: expiredId, attempt: 1, lease_id: "lease-a", operation_id: "qt:expired-race", outcome: { status: "failed", reason: "source_unavailable" } }));
    expect(payload(result).outcome).toBe("conflict");
    expect(await deps.store.get(expiredId)).toMatchObject({ status: "received", lease_expires_at: null });

    const liveId = "d".repeat(64); addQuestion(db, liveId, "triaging", 900);
    expect(await sweepQuestions(deps, 100, "expired")).toEqual({ moved: 0 });
    const live = await deps.store.get(liveId);
    expect(live?.status).toBe("triaging");
    expect(Date.parse(live!.lease_expires_at!) > Date.now()).toBe(true);

    const raceId = "e".repeat(64); addQuestion(db, raceId, "triaging", 900);
    const racingDeps = sqliteDeps(d1, new Date(Date.now() + 60_000).toISOString());
    db.exec("DROP TRIGGER question_requests_state_machine");
    const racedExpiry = new Date(Date.now() + 30_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    d1.afterQuestionRead = () => { db.prepare("UPDATE question_requests SET lease_expires_at=? WHERE request_id=?").run(racedExpiry, raceId); };
    const raced = await ackQuestion(racingDeps, service, envelope("ack", { request_id: raceId, attempt: 1, lease_id: "lease-a", operation_id: "qt:sql-lease-fence", outcome: { status: "failed", reason: "source_unavailable" } }));
    expect(payload(raced).outcome).toBe("conflict");
    expect(await racingDeps.store.get(raceId)).toMatchObject({ status: "triaging", lease_expires_at: racedExpiry });

    const queuedRaceId = "f".repeat(64); addQuestion(db, queuedRaceId, "triaging", 900);
    const queuedRaceExpiry = new Date(Date.now() + 30_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    d1.afterQuestionRead = () => { db.prepare("UPDATE question_requests SET lease_expires_at=? WHERE request_id=?").run(queuedRaceExpiry, queuedRaceId); };
    const queuedRace = await ackQuestion(racingDeps, service, envelope("ack", { request_id: queuedRaceId, attempt: 1, lease_id: "lease-a", operation_id: "qt:sql-queued-lease-fence", outcome: { status: "verdict", verdict: verdict({ request_id: queuedRaceId, families: ["arrival_manager"] }) } }));
    expect(payload(queuedRace).outcome).toBe("conflict");
    expect(await racingDeps.store.get(queuedRaceId)).toMatchObject({ status: "triaging", lease_expires_at: queuedRaceExpiry });
    db.close();
  });

  it("no_shared_rows_when_status_update_missed", async () => {
    const { db, d1 } = sqliteForBridge();
    db.exec("DROP TRIGGER question_requests_state_machine");
    const requestId = "9".repeat(64); addQuestion(db, requestId, "triaging", 900);
    const deps = sqliteDeps(d1, new Date(Date.now() + 60_000).toISOString());
    const racedExpiry = new Date(Date.now() + 30_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    d1.afterQuestionRead = () => { db.prepare("UPDATE question_requests SET lease_expires_at=? WHERE request_id=?").run(racedExpiry, requestId); };
    const result = await ackQuestion(deps, service, envelope("ack", { request_id: requestId, attempt: 1, lease_id: "lease-a", operation_id: "qt:no-shared-rows", outcome: { status: "verdict", verdict: verdict({ request_id: requestId, families: ["arrival_manager"] }) } }));
    expect(payload(result).outcome).toBe("conflict");
    expect(db.prepare("SELECT count(*) AS n FROM exploration_shared_requests").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM exploration_request_links").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM exploration_shared_jobs").get()).toEqual({ n: 0 });
    db.close();
  });

  it("settles queued questions from complete, partial, and missing D1 results", async () => {
    const { db, d1 } = sqliteForBridge();
    const completeId = "c".repeat(64), partialId = "d".repeat(64), missingId = "e".repeat(64);
    for (const questionId of [completeId, partialId, missingId]) addQuestion(db, questionId, "triaging", 900, "runner-a");
    addPublishedQueue(db, completeId, "1".repeat(64), "complete");
    addPublishedQueue(db, partialId, "2".repeat(64), "partial");
    addPublishedQueue(db, missingId, "3".repeat(64), "missing");
    const goneId = "f".repeat(64); addQuestion(db, goneId, "triaging", 900, "runner-a");
    db.prepare("UPDATE question_requests SET status='queued',lease_expires_at=NULL,verdict_json=?,exploration_request_id=?,revision=3 WHERE request_id=?").run(JSON.stringify(verdict({ request_id: goneId, tables: [{ fields: ["goals"], filters: { season: ["2010-11"], competition: ["PL"], opponent_id: [], person_id: [] } }] })), "4".repeat(64), goneId);
    const deps = sqliteDeps(d1);
    expect(await sweepQuestions(deps, 100, "queued")).toEqual({ moved: 4 });
    expect(await deps.store.get(completeId)).toMatchObject({ status: "filled" });
    expect(await deps.store.get(partialId)).toMatchObject({ status: "partial" });
    expect(await deps.store.get(missingId)).toMatchObject({ status: "no_data" });
    expect(await deps.store.get(goneId)).toMatchObject({ status: "filled" });
    db.close();
  });

  it("rotates queued SQLite sweep pages so rows past the first 100 are reached", async () => {
    const { db, d1 } = sqliteForBridge();
    db.exec("DROP TRIGGER question_requests_state_machine");
    const firstId = (n: number) => n.toString(16).padStart(64, "0");
    for (let n = 1; n <= 102; n++) {
      const requestId = firstId(n); addQuestion(db, requestId, "triaging", 900);
      const v = JSON.stringify(verdict({ request_id: requestId }));
      db.prepare("UPDATE question_requests SET status='queued',lease_expires_at=NULL,verdict_json=?,exploration_request_id=?,revision=3 WHERE request_id=?").run(v, requestId, requestId);
    }
    const store = new D1QuestionTriageStore(d1 as unknown as D1Database);
    const first = await store.sweepRows("queued", new Date().toISOString(), 100);
    const second = await store.sweepRows("queued", new Date().toISOString(), 100);
    expect(first).toHaveLength(100);
    expect(second).toHaveLength(100);
    expect(second.slice(0, 2).map(row => row.request_id)).toEqual([firstId(101), firstId(102)]);
    db.close();
  });

  it("ack_rejects_verdict_outside_allowlist and shares validator screen fixtures", async () => {
    const cases = JSON.parse(readFileSync("tests/fixtures/question-triage-screen-parity.json", "utf8")) as { accept: string[]; reject: string[] };
    const checkScreen = async (question: string, index: number, expected: "accepted" | "invalid_verdict") => {
      const { db, d1 } = sqliteForBridge(), requestId = (index + 101).toString(16).padStart(64, "0");
      addQuestion(db, requestId, "triaging", 900);
      const deps = sqliteDeps(d1);
      const result = await ackQuestion(deps, service, envelope("ack", { request_id: requestId, attempt: 1, lease_id: "lease-a", operation_id: `qt:screen-${index}`, outcome: { status: "verdict", verdict: verdict({ request_id: requestId, restated_question: question }) } }));
      expect(payload(result).outcome).toBe(expected);
      db.close();
    };
    for (let i = 0; i < cases.accept.length; i++) {
      const question = cases.accept[i]!;
      await checkScreen(question, i, "accepted");
    }
    for (let i = 0; i < cases.reject.length; i++) {
      const question = cases.reject[i]!;
      await checkScreen(question, cases.accept.length + i, "invalid_verdict");
    }
    const rejected: unknown[] = [
      verdict({ families: ["unknown_family"] }),
      { ...verdict(), extra: "closed object" },
      verdict({ relevant: false, junk_reason: null, restated_question: "" }),
      { ...verdict(), extra: "x".repeat(10_300) },
    ];
    for (let i = 0; i < rejected.length; i++) {
      const { db, d1 } = sqliteForBridge(), requestId = (i + 301).toString(16).padStart(64, "0");
      addQuestion(db, requestId, "triaging", 900);
      const deps = sqliteDeps(d1), candidate = typeof rejected[i] === "object" && rejected[i] !== null ? { ...rejected[i] as Record<string, unknown>, request_id: requestId } : rejected[i];
      const result = await ackQuestion(deps, service, envelope("ack", { request_id: requestId, attempt: 1, lease_id: "lease-a", operation_id: `qt:invalid-${i}`, outcome: { status: "verdict", verdict: candidate } }));
      expect(payload(result).outcome).toBe("invalid_verdict");
      db.close();
    }
  });

  it("continues a sweep after one row aborts", async () => {
    const first = { ...claimedRow(), request_id: "1".repeat(64) }, second = { ...claimedRow(), request_id: "2".repeat(64) };
    const { store, deps } = setup(first); store.rows.set(second.request_id, second); store.throwFirstSettle = true;
    const result = await sweepQuestions(deps);
    expect(result.moved).toBe(1); expect(store.rows.get(second.request_id)?.status).toBe("received");
  });

  it("keeps the route service-token-only and rejects oversized bodies before configuration", async () => {
    const identity: { value: AccessIdentity } = { value: { sub: "human-sub", email: "owner@example.test" } };
    const app = new Hono<QuestionTriageEnv>();
    app.use("*", async (c, next) => { c.set("accessIdentity", identity.value); await next(); });
    app.route("/internal/question-triage-bridge", createQuestionTriageBridgeRouter());
    const env = { ACCESS_SERVICE_CLIENT_IDS: "runner" } as QuestionTriageEnv["Bindings"];
    const human = await app.request("/internal/question-triage-bridge/read", { method: "POST", body: "{}" }, env);
    expect(human.status).toBe(403);
    identity.value = { sub: "", serviceClientId: "unknown" };
    const unknown = await app.request("/internal/question-triage-bridge/read", { method: "POST", body: "{}" }, env);
    expect(unknown.status).toBe(403);
    identity.value = { sub: "", serviceClientId: "runner" };
    const oversized = await app.request("/internal/question-triage-bridge/read", { method: "POST", body: "x".repeat(64 * 1024 + 1) }, env);
    expect(oversized.status).toBe(413);
    const method = await app.request("/internal/question-triage-bridge/read", { method: "GET" }, env);
    expect(method.status).toBe(405);
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array([123])); controller.close(); } });
    const request = new Request("http://localhost/internal/question-triage-bridge/read", { method: "POST", headers: { "content-length": String(64 * 1024 + 1) }, body: stream, duplex: "half" } as RequestInit);
    const early = await app.fetch(request, env);
    expect(early.status).toBe(413);
    expect(request.bodyUsed).toBe(false);
  });
});
