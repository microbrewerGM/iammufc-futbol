/** Fixed, database-clock purge. The 0010 migration test executes this constant
 * and checks it byte-for-byte against the documented PURGE markers. */
export const QUESTION_REQUEST_PURGE_SQL = "DELETE FROM question_requests WHERE request_id IN (SELECT request_id FROM question_requests WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now') ORDER BY expires_at, request_id LIMIT 100);";

export async function collectQuestionRequestRetention(db: Pick<D1Database, "prepare">): Promise<number> {
  const result = await db.prepare(QUESTION_REQUEST_PURGE_SQL).run();
  return result.meta.changes;
}
