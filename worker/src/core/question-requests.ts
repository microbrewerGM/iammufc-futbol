import type { Env } from "./db";

export const INTAKE_MAX_BYTES = 4096;
const REJECTED = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/u;
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, "0")).join("");
export function validQuestionText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.normalize("NFC");
  const count = [...text].length;
  if (count < 1 || count > 500 || encoder.encode(text).byteLength > 2000 || REJECTED.test(text)) return null;
  return text;
}
export function validAccountSub(raw: unknown): raw is string {
  return typeof raw === "string" && [...raw].length >= 1 && [...raw].length <= 512 &&
    encoder.encode(raw).byteLength <= 2048 && !REJECTED.test(raw);
}
export async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}
export function requestId(account: string, day: string, hash: string): Promise<string> {
  return sha256(`${account}\n${day}\n${hash}`);
}
export function utcDay(now: Date): string { return now.toISOString().slice(0, 10); }

export type IntakeResult = { kind: "stored" | "duplicate"; requestId: string } | { kind: "daily_limit" | "pending_limit" | "budget" | "unavailable" };
export async function storeQuestion(env: Env, account: string, text: string, locale: "en" | "es", now = new Date()): Promise<IntakeResult> {
  try {
    const day = utcDay(now);
    const hash = await sha256(text);
    const id = await requestId(account, day, hash);
    const existing = await env.DB.prepare(`SELECT request_id FROM question_requests
      WHERE account_sub = ? AND substr(created_at, 1, 10) = ? AND text_hash = ? LIMIT 1`)
      .bind(account, day, hash).first<{ request_id: string }>();
    if (existing) return { kind: "duplicate", requestId: existing.request_id };
    const created = now.toISOString().replace(/\.\d{3}Z$/, "Z");
    const pending = await env.DB.prepare("SELECT count(*) AS n FROM question_requests WHERE account_sub = ? AND status IN ('received','triaging','triaged','queued')")
      .bind(account).first<{ n: number }>();
    if (!pending || !Number.isFinite(pending.n)) return { kind: "unavailable" };
    if (pending.n >= 20) return { kind: "pending_limit" };
    const daily = await env.DB.prepare("SELECT count(*) AS n FROM question_requests WHERE account_sub = ? AND substr(created_at, 1, 10) = ?")
      .bind(account, day).first<{ n: number }>();
    if (!daily || !Number.isFinite(daily.n)) return { kind: "unavailable" };
    if (daily.n >= 10) return { kind: "daily_limit" };
    const budget = await env.DB.prepare("INSERT INTO budget_counter (day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1 RETURNING count")
      .bind(`intake:${day}`).first<{ count: number }>();
    if (!budget || !Number.isFinite(budget.count)) return { kind: "unavailable" };
    if (budget.count > 1000) return { kind: "budget" };
    const inserted = await env.DB.prepare(`INSERT INTO question_requests
      (request_id, account_sub, text, locale, text_hash, status, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, 'received', ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', ?, '+90 days'))`)
      .bind(id, account, text, locale, hash, created, created, created).run();
    if (Number(inserted.meta?.changes ?? 0) === 1) return { kind: "stored", requestId: id };
    const raced = await env.DB.prepare(`SELECT request_id FROM question_requests
      WHERE account_sub = ? AND substr(created_at, 1, 10) = ? AND text_hash = ? LIMIT 1`)
      .bind(account, day, hash).first<{ request_id: string }>();
    return raced ? { kind: "duplicate", requestId: raced.request_id } : { kind: "unavailable" };
  } catch { return { kind: "unavailable" }; }
}

export async function readQuestionStatus(env: Env, account: string, id: string): Promise<string | null> {
  try {
    const row = await env.DB.prepare("SELECT status FROM question_requests WHERE request_id = ? AND account_sub = ?")
      .bind(id, account).first<{ status: string }>();
    return row?.status ?? null;
  } catch { return null; }
}
