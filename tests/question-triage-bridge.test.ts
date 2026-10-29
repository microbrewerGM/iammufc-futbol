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
  constructor(private readonly db: InstanceType<typeof DatabaseSync>, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values; return this; }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.values) as T[] }; }
  async first<T>() { return (this.db.prepare(this.sql).get(...this.values) as T | undefined) ?? null; }
}
class SqliteD1 {
  constructor(private readonly db: InstanceType<typeof DatabaseSync>) {}
  prepare(sql: string) { return new SqliteStatement(this.db, sql); }
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
  });
});
