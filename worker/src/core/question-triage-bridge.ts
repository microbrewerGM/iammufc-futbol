import compiledCatalog from "../generated/catalog.json";
import { decodeCompiledCatalog } from "./catalog-contract";
import { Catalog, VIZ_GRANULARITY } from "./feasibility";
import type { QueryIntent } from "./intent";

export const TRIAGE_CAPABILITY = "question:triage:v1";
export const TRIAGE_MAX_REQUEST_BYTES = 64 * 1024;
export const TRIAGE_LEASE_SECONDS = 900;
const PAGE_SIZE = 10;
const catalog = new Catalog(decodeCompiledCatalog(compiledCatalog));
const metrics = new Set(catalog.metrics.map(row => row.metric_id));
const competitions = new Set(catalog.coverage.map(row => row.competition));
const seasons = new Set(catalog.coverage.map(row => row.season));

export interface TriageCaller { service: string; capability: string }
export interface TriageQuestion { request_id: string; locale: "en" | "es"; text: string; account_sub: string; status: string; attempt: number; lease_id: string | null; lease_owner: string | null; lease_expires_at: string | null; retry_after: string | null; revision: number; claimed_at: string | null; verdict_json: string | null; exploration_request_id: string | null }
export interface TriageOperation { service: string; type: "claim" | "ack"; operation_id: string; body_hash: string; response: unknown; lease_id: string | null }
export interface TriageStore {
  page(after: string | null, limit: number): Promise<TriageQuestion[]>;
  get(id: string): Promise<TriageQuestion | null>;
  operation(service: string, type: "claim" | "ack", id: string): Promise<TriageOperation | null>;
  claim(row: TriageQuestion, next: TriageQuestion, op: TriageOperation): Promise<boolean>;
  ack(row: TriageQuestion, next: TriageQuestion, op: TriageOperation, admission: { requestId: string; requestJson: string; jobId: string; accountSub: string; createdAt: string } | null): Promise<boolean>;
  sweepRows(kind: "expired" | "triaged" | "queued", now: string, limit: number): Promise<TriageQuestion[]>;
  settle(row: TriageQuestion, next: TriageQuestion): Promise<boolean>;
  queueResult(row: TriageQuestion): Promise<"complete" | "partial" | "missing" | "failed" | "pending">;
}
export interface TriageDeps { store: TriageStore; now(): Date; newLeaseId(): string; cursorKey: Uint8Array }
export type TriageError = "malformed" | "too_large" | "invalid_caller" | "invalid_cursor";
export type TriageResult = { ok: true; body: string } | { ok: false; error: TriageError };
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9:_-]{0,95}$/;
type TriageFailure = Extract<TriageResult, { ok: false }>;
const bad = (error: TriageError): TriageFailure => ({ ok: false, error });
const isError = (value: Record<string, unknown> | TriageFailure): value is TriageFailure => "ok" in value && value.ok === false;
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const closed = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const wellFormed = (s: string) => { for (let i = 0; i < s.length; i++) { const n = s.charCodeAt(i); if (n >= 0xd800 && n <= 0xdbff) { const next = s.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; } else if (n >= 0xdc00 && n <= 0xdfff) return false; } return true; };
function checkStrings(v: unknown): boolean { if (typeof v === "string") return wellFormed(v); if (Array.isArray(v)) return v.every(checkStrings); if (object(v)) return Object.entries(v).every(([k, x]) => wellFormed(k) && checkStrings(x)); return true; }
function canonical(v: unknown): string { if (!checkStrings(v)) throw new TypeError("ill-formed string"); if (v === null || typeof v !== "object") return JSON.stringify(v); if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`; return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`; }
const bytes = (s: string) => new TextEncoder().encode(s).length;
async function hash(value: string): Promise<string> { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, "0")).join(""); }
function envelope(raw: unknown, kind: string): Record<string, unknown> | TriageFailure { if (typeof raw !== "string") return bad("malformed"); if (bytes(raw) > TRIAGE_MAX_REQUEST_BYTES) return bad("too_large"); let v: unknown; try { v = JSON.parse(raw); } catch { return bad("malformed"); } if (!object(v) || !closed(v, ["version", "kind", "payload"]) || v.version !== 1 || v.kind !== kind || !object(v.payload) || !checkStrings(v)) return bad("malformed"); return v.payload; }
function reply(kind: string, payload: unknown): TriageResult { const body = JSON.stringify({ version: 1, kind, payload }); return bytes(body) > 256 * 1024 ? bad("too_large") : { ok: true, body }; }
function time(ms: number): string { return new Date(ms).toISOString().replace(".000Z", "Z"); }
function nowMs(d: TriageDeps): number { return Math.floor(d.now().getTime() / 1000) * 1000; }
function callerOk(c: TriageCaller): boolean { return object(c) && ID.test(c.service) && c.capability === TRIAGE_CAPABILITY; }
function isInt(v: unknown, min: number, max: number): v is number { return Number.isInteger(v) && (v as number) >= min && (v as number) <= max; }

const restatedScreens: readonly RegExp[] = [
  /(?:(?<![\w+-])[a-z][a-z0-9+.\-]*:\/\/|\b(?:javascript|vbscript)\s*:|\b(?:https?|ftps?|file|data|mailto|blob|wss?|tel|sms|about|gopher|ldap|ssh):\S|(?<![\w-])(?!(?:ee\.uu|p\.ej)(?!\w))[\w-]+(?:\.[\w-]+)*\.[^\W\d_][\w-]{1,62}(?!\w)|(?<!\w)(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+)){2,3}(?!\w)|(?<!\w)0x[0-9a-f]+(?!\w)|(?<!\w)\d{10,}(?!\w)|::|(?<![\w:])[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){2,7}(?![\w:])|\[[0-9a-f:.]{2,}\])/i,
  /\S@\S|@\w|%[0-9a-f]{2}/i,
  /(?:\\|\/\/|\.\.?\/|~\/|\b[a-z]:[/\\]|(?:^|[\s(["'])\/\S|\b(?:etc|usr|var|bin|tmp|root|proc|dev|api|admin|oauth|login|graphql|cgi-bin|wp-admin|wp-content)\/\w|\bv\d+\/\w)/i,
  /[<>`]|&#?\w+;|\]\(|!\[|[\w.-]+\/[\w.-]+#\d/,
  /\bunion\s+(?:all\s+)?select\b|\bselect\s+(?:'[^']*'|"[^"]*"|[\w.()*]+)(?:\s*,\s*(?:'[^']*'|"[^"]*"|[\w.()*]+))*\s+from\b|\b(?:insert\s+into|replace\s+into|delete\s+from|drop\s+(?:table|database|view|index|trigger)|alter\s+(?:table|database|view|index|trigger)|create\s+(?:table|database|view|index|trigger)|truncate\s+(?:table|database|view|index|trigger)|pragma\s+\w+|exec(?:ute)?\s*\(|xp_\w+|sqlite_master|information_schema|sleep\s*\(|benchmark\s*\(|pg_sleep\s*\(|waitfor\s+delay)\b|\b(?:or|and)\s+\d+\s*=\s*\d+|;\s*(?:select|insert|update|delete|drop|alter|create|pragma)\b|--|\/\*|\*\//i,
  /(?:\b(?:sk|pk|ghp|gho|ghs|ghu|github_pat|xox[abpr])[-_][a-z0-9_-]{8,}|\bAKIA[0-9A-Z]{16}|-----BEGIN|\bbearer\s+\S|\beyJ[a-z0-9_-]{4,}|(?<![0-9a-f])[0-9a-f]{32,}(?![0-9a-f])|(?:oauth|api)[_ -]?(?:token|key)|\b[a-z][a-z0-9]*_(?:token|secret)\b|\b(?:password|passwd|authorization)\s*[:=])/i,
  /\S{30,}/,
];
function screenQuestion(s: string): boolean {
  if (s !== s.normalize("NFC") || [...s].some(ch => {
    const cp = ch.codePointAt(0)!;
    return !(" .,?!'\"-():;/+%&–—¿¡".includes(ch) || (cp < 128 && /[a-z0-9]/i.test(ch)) || (cp >= 0x00c0 && cp <= 0x017f && /\p{L}/u.test(ch) && cp !== 0x013f && cp !== 0x0140));
  })) return false;
  const folded = s.normalize("NFKC");
  if (restatedScreens.some(pattern => pattern.test(folded))) return false;
  if ((folded.match(/\S{20,}/g) ?? []).some(token => { const core = token.replace(/[-/]/g, ""); return core.length >= 20 && /[a-z]/i.test(core) && /\d/.test(core); })) return false;
  return !(/(?:https?:|www\.|\S@\S|@\w|%[0-9a-f]{2}|\\|\/\/|\.\.?\/|~\/|\b[a-z]:[/\\]|\b(?:select|insert|update|delete|drop|alter|create|union|pragma)\b|\b(?:union\s+(?:all\s+)?select|insert\s+into|replace\s+into|update\s+[\w.]+\s+set|delete\s+from|sqlite_master|information_schema)\b|[<>`]|\S{30,})/i.test(folded));
}
function validateVerdict(v: unknown, requestId: string): v is Record<string, any> {
  if (!object(v) || !checkStrings(v) || bytes(canonical(v)) > 10240 || !closed(v, ["version", "request_id", "relevant", "junk_reason", "restated_question", "tables", "visuals", "field_status", "families"])) return false;
  if (v.version !== 1 || v.request_id !== requestId || typeof v.relevant !== "boolean" || typeof v.restated_question !== "string" || v.restated_question.length > 300 || !screenQuestion(v.restated_question) || !Array.isArray(v.tables) || v.tables.length > 3 || !Array.isArray(v.visuals) || v.visuals.length > 4 || !Array.isArray(v.field_status) || v.field_status.length > 24 || !Array.isArray(v.families) || v.families.length > 1) return false;
  if (v.relevant ? v.junk_reason !== null || !v.restated_question.trim() : !["off_topic", "not_a_question", "abusive", "prompt_injection", "unintelligible", "out_of_scope"].includes(String(v.junk_reason)) || v.tables.length || v.visuals.length || v.field_status.length || v.families.length) return false;
  const tableFields = new Set<string>();
  for (const t of v.tables) {
    if (!object(t) || !closed(t, ["fields", "filters"]) || !Array.isArray(t.fields) || t.fields.length < 1 || t.fields.length > 8 || new Set(t.fields).size !== t.fields.length || !object(t.filters) || !closed(t.filters, ["season", "competition", "opponent_id", "person_id"])) return false;
    if (!t.fields.every((x: unknown) => typeof x === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(x) && metrics.has(x))) return false;
    t.fields.forEach((x: string) => tableFields.add(x));
    const f = t.filters;
    if (!Array.isArray(f.season) || f.season.length > 20 || new Set(f.season).size !== f.season.length || !f.season.every((x: unknown) => typeof x === "string" && /^[0-9]{4}-[0-9]{2}$/.test(x) && seasons.has(x)) || !Array.isArray(f.competition) || f.competition.length > 4 || new Set(f.competition).size !== f.competition.length || !f.competition.every((x: unknown) => typeof x === "string" && /^[A-Z][A-Z0-9_]{0,15}$/.test(x) && competitions.has(x)) || !Array.isArray(f.opponent_id) || f.opponent_id.length > 5 || new Set(f.opponent_id).size !== f.opponent_id.length || !f.opponent_id.every((x: unknown) => typeof x === "string" && /^[a-z0-9][a-z0-9:_-]{0,63}$/.test(x)) || !Array.isArray(f.person_id) || f.person_id.length > 5 || new Set(f.person_id).size !== f.person_id.length || !f.person_id.every((x: unknown) => typeof x === "string" && /^[a-z0-9][a-z0-9:_-]{0,63}$/.test(x))) return false;
  }
  for (const visual of v.visuals) if (!object(visual) || !closed(visual, ["kind", "table_index"]) || !["table", "bar", "dot_plot", "line"].includes(String(visual.kind)) || !isInt(visual.table_index, 0, v.tables.length - 1)) return false;
  const seen = new Set<string>();
  for (const row of v.field_status) { if (!object(row) || !closed(row, ["field", "status"]) || typeof row.field !== "string" || !tableFields.has(row.field) || seen.has(row.field) || !["available", "missing", "unknown"].includes(String(row.status))) return false; seen.add(row.field); }
  return v.families.every((x: unknown) => x === "arrival_manager");
}

function cellStatus(verdict: Record<string, any>): { total: number; available: number; fieldStatus: { field: string; status: "available" | "missing" | "unknown" }[] } {
  let total = 0, available = 0; const statuses = new Map<string, ("available" | "missing" | "unknown")[]>();
  for (const table of verdict.tables) {
    const entity = table.filters.person_id.length ? "player" : table.filters.opponent_id.length ? "opponent" : "season";
    const comps: string[] = table.filters.competition.length ? table.filters.competition : ["PL"];
    for (const field of table.fields) for (const comp of comps) {
      // Keep every catalog season (including no-rights cells) for this competition.
      const ss: string[] = table.filters.season.length ? table.filters.season : [...new Set(catalog.coverage.filter(c => c.metric === field && c.entity_type === entity && c.granularity === VIZ_GRANULARITY.table && c.competition === comp).map(c => c.season))].sort().reverse();
      const fieldCells = statuses.get(field) ?? []; statuses.set(field, fieldCells);
      if (!ss.length) { total++; fieldCells.push("missing"); continue; }
      for (const season of ss) { total++; const intent = { metric: field, entity_type: entity, season, competition: comp, viz: "table", limit: 50 } as QueryIntent; const state = catalog.checkFeasibility(intent).state; const cell = state === "available" || state === "computable_now_queued" ? "available" : state === "no_rights" ? "unknown" : "missing"; fieldCells.push(cell); if (cell === "available") available++; }
    }
  }
  const fieldStatus = [...statuses].map(([field, cells]) => ({ field, status: cells.includes("unknown") ? "unknown" as const : cells.length > 0 && cells.every(x => x === "available") ? "available" as const : "missing" as const }));
  return { total, available, fieldStatus };
}

export async function readQuestions(deps: TriageDeps, caller: TriageCaller, raw: unknown): Promise<TriageResult> {
  if (!callerOk(caller)) return bad("invalid_caller"); const p = envelope(raw, "read"); if (isError(p)) return p;
  if (!closed(p, ["cursor", "limit"]) || (p.cursor !== null && typeof p.cursor !== "string") || !isInt(p.limit, 1, PAGE_SIZE)) return bad("malformed");
  let after: string | null = null;
  if (p.cursor !== null) { const m = /^q1:([0-9a-f]{64}):([0-9a-f]{32})$/.exec(p.cursor as string); if (!m || !(await verifyCursor(deps.cursorKey, caller, m[1]!, m[2]!))) return bad("invalid_cursor"); after = m[1]!; }
  const rows = await deps.store.page(after, p.limit + 1), page = rows.slice(0, p.limit);
  const next = rows.length > p.limit && page.length ? `q1:${page[page.length - 1]!.request_id}:${await signCursor(deps.cursorKey, caller, page[page.length - 1]!.request_id)}` : null;
  return reply("read_result", { questions: page.map(({ request_id, locale, text }) => ({ request_id, locale, text })), next_cursor: next });
}
async function cursorMac(key: Uint8Array, caller: TriageCaller, id: string): Promise<string> { const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); const tag = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${caller.service}\n${caller.capability}\n${id}`))); return [...tag.slice(0, 16)].map(x => x.toString(16).padStart(2, "0")).join(""); }
async function signCursor(key: Uint8Array, caller: TriageCaller, id: string): Promise<string> { return cursorMac(key, caller, id); }
async function verifyCursor(key: Uint8Array, caller: TriageCaller, id: string, tag: string): Promise<boolean> { return tag === await cursorMac(key, caller, id); }
export async function claimQuestion(deps: TriageDeps, caller: TriageCaller, raw: unknown): Promise<TriageResult> {
  if (!callerOk(caller)) return bad("invalid_caller"); const p = envelope(raw, "claim"); if (isError(p)) return p;
  if (!closed(p, ["request_id", "expected_attempt", "operation_id"]) || typeof p.request_id !== "string" || !HASH.test(p.request_id) || !isInt(p.expected_attempt, 0, 2) || typeof p.operation_id !== "string" || !/^qt:[a-z0-9:_-]{1,92}$/.test(p.operation_id)) return bad("malformed");
  const now = nowMs(deps), bodyHash = await hash(canonical(p)), prior = await deps.store.operation(caller.service, "claim", p.operation_id);
  if (prior) { if (prior.body_hash !== bodyHash) return reply("claim_result", { outcome: "conflict" }); const cur = await deps.store.get(p.request_id); if (!cur || cur.status !== "triaging" || cur.lease_id !== prior.lease_id || cur.lease_owner !== caller.service || !cur.lease_expires_at || Date.parse(cur.lease_expires_at) <= now) return reply("claim_result", { outcome: "conflict" }); return reply("claim_result", prior.response); }
  const cur = await deps.store.get(p.request_id); if (!cur) return reply("claim_result", { outcome: "not_found" }); if (cur.status !== "received" || cur.attempt !== p.expected_attempt || cur.attempt >= 3 || cur.retry_after && Date.parse(cur.retry_after) > now) return reply("claim_result", { outcome: "conflict" });
  const lease = deps.newLeaseId(); if (!ID.test(lease) || cur.lease_id === lease) throw new Error("invalid random lease id");
  const next = { ...cur, status: "triaging", attempt: cur.attempt + 1, lease_id: lease, lease_owner: caller.service, lease_expires_at: time(now + TRIAGE_LEASE_SECONDS * 1000), claimed_at: time(now), retry_after: null, revision: cur.revision + 1 };
  const response = { outcome: "claimed", question: { request_id: cur.request_id, locale: cur.locale, text: cur.text, attempt: next.attempt, lease_id: lease, lease_expires_at: next.lease_expires_at } };
  const op: TriageOperation = { service: caller.service, type: "claim", operation_id: p.operation_id, body_hash: bodyHash, response, lease_id: lease };
  return await deps.store.claim(cur, next, op) ? reply("claim_result", response) : reply("claim_result", { outcome: "conflict" });
}
export async function ackQuestion(deps: TriageDeps, caller: TriageCaller, raw: unknown): Promise<TriageResult> {
  if (!callerOk(caller)) return bad("invalid_caller"); const p = envelope(raw, "ack"); if (isError(p)) return p;
  if (!closed(p, ["request_id", "attempt", "lease_id", "operation_id", "outcome"]) || typeof p.request_id !== "string" || !HASH.test(p.request_id) || !isInt(p.attempt, 1, 3) || typeof p.lease_id !== "string" || !ID.test(p.lease_id) || typeof p.operation_id !== "string" || !/^qt:[a-z0-9:_-]{1,92}$/.test(p.operation_id) || !object(p.outcome)) return bad("malformed");
  const now = nowMs(deps), bodyHash = await hash(canonical(p)), prior = await deps.store.operation(caller.service, "ack", p.operation_id);
  if (prior) return prior.body_hash === bodyHash ? reply("ack_result", { outcome: "replayed", response: prior.response }) : reply("ack_result", { outcome: "conflict" });
  const cur = await deps.store.get(p.request_id); if (!cur || cur.status !== "triaging" || cur.attempt !== p.attempt || cur.lease_id !== p.lease_id || cur.lease_owner !== caller.service) return reply("ack_result", { outcome: "conflict" });
  const outcome = p.outcome; let next: TriageQuestion; let admission: { requestId: string; requestJson: string; jobId: string; accountSub: string; createdAt: string } | null = null;
  if (closed(outcome, ["status", "reason"]) && outcome.status === "failed" && ["source_unavailable", "validation_failed", "publication_failed"].includes(String(outcome.reason))) {
    if (cur.attempt === 3) next = { ...cur, status: "triage_failed", retry_after: null, lease_expires_at: null, revision: cur.revision + 1 };
    else next = { ...cur, status: "received", retry_after: time(Math.min(now + ({ 1: 300, 2: 1800 }[cur.attempt] ?? 1800) * 1000, Date.parse(cur.claimed_at!) + 86400_000)), lease_expires_at: null, revision: cur.revision + 1 };
  } else if (closed(outcome, ["status", "verdict"]) && outcome.status === "verdict" && validateVerdict(outcome.verdict, cur.request_id)) {
    const verdict = outcome.verdict; const computed = cellStatus(verdict); const stored = { ...verdict, field_status: computed.fieldStatus };
    if (verdict.relevant === false) next = { ...cur, status: "junk", verdict_json: canonical(stored), lease_expires_at: null, retry_after: null, revision: cur.revision + 1 };
    else if (verdict.families.includes("arrival_manager")) {
      const createdAt = time(now);
      const request = { academy_basis: "documented_first_team_promotion", as_of: createdAt.slice(0, 10), family: "arrival_manager", joining_basis: "effective_first_team_spell_entry", population: "first_team_available", version: 1, visualization: "table" };
      const requestJson = canonical(request), requestId = await hash(requestJson), jobId = await hash(`${requestId}\njob`);
      admission = { requestId, requestJson, jobId, accountSub: cur.account_sub, createdAt };
      next = { ...cur, status: "queued", verdict_json: canonical(stored), exploration_request_id: requestId, lease_expires_at: null, retry_after: null, revision: cur.revision + 2 };
    } else { const status = computed.total === 0 || computed.available === 0 ? "no_data" : computed.available === computed.total ? "filled" : "partial"; next = { ...cur, status, verdict_json: canonical(stored), lease_expires_at: null, retry_after: null, revision: cur.revision + 2 }; }
  } else return reply("ack_result", { outcome: "invalid_verdict" });
  const response = { outcome: "accepted", status: next.status };
  const op: TriageOperation = { service: caller.service, type: "ack", operation_id: p.operation_id, body_hash: bodyHash, response, lease_id: cur.lease_id };
  return await deps.store.ack(cur, next, op, admission) ? reply("ack_result", response) : reply("ack_result", { outcome: "conflict" });
}

export async function sweepQuestions(deps: TriageDeps, limit = 100, selected?: "expired" | "triaged" | "queued"): Promise<{ moved: number }> {
  const now = nowMs(deps), stamp = time(now); let moved = 0;
  for (const kind of (selected ? [selected] : ["expired", "triaged", "queued"] as const)) {
    const rows = await deps.store.sweepRows(kind, stamp, limit);
    for (const row of rows) {
      try {
        let next: TriageQuestion | null = null;
        if (kind === "expired") next = row.attempt >= 3 ? { ...row, status: "triage_failed", lease_expires_at: null, retry_after: null, revision: row.revision + 1 } : { ...row, status: "received", lease_expires_at: null, retry_after: time(Math.min(now + ({ 1: 300, 2: 1800 }[row.attempt] ?? 1800) * 1000, Date.parse(row.claimed_at!) + 86400_000)), revision: row.revision + 1 };
        else if (kind === "triaged") { const v = JSON.parse(row.verdict_json ?? "null"); const cells = cellStatus(v); const status = cells.total === 0 || cells.available === 0 ? "no_data" : cells.total === cells.available ? "filled" : "partial"; next = { ...row, status, revision: row.revision + 1 }; }
        else { const result = await deps.store.queueResult(row); if (result !== "pending") { const cells = cellStatus(JSON.parse(row.verdict_json ?? "null")); const status = cells.total === 0 || result === "missing" || result === "failed" ? "no_data" : result === "complete" && cells.available === cells.total ? "filled" : "partial"; next = { ...row, status, revision: row.revision + 1 }; } }
        if (next && await deps.store.settle(row, next)) moved++;
      } catch { /* A corrupt or aborting row never blocks later rows in the batch. */ }
    }
  }
  return { moved };
}
