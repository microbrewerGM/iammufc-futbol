/** Server-owned time based collection for the account-neutral exploration store.
 * The statements are fixed 0008 SQL; this module accepts no query input and
 * never creates a timer or scheduled worker. Call from an existing request path.
 */
import type { Env } from "./db";

export const EXPLORATION_RETENTION_BATCH = 100;

/** Run one bounded retention batch. Each statement is independently atomic;
 * expired link deletes invoke the migration's orphan trigger. */
export async function collectExplorationRetention(env: Pick<Env, "DB">): Promise<number> {
  const links = await env.DB.prepare(`DELETE FROM exploration_request_links
    WHERE (request_id, account_sub) IN (
      SELECT request_id, account_sub FROM exploration_request_links
      WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      ORDER BY expires_at, request_id, account_sub LIMIT ${EXPLORATION_RETENTION_BATCH}
    )`).run();
  const requests = await env.DB.prepare(`DELETE FROM exploration_shared_requests
    WHERE request_id IN (
      SELECT request_id FROM exploration_collectable_requests
      ORDER BY created_at, request_id LIMIT ${EXPLORATION_RETENTION_BATCH}
    )`).run();
  const tombstones = await env.DB.prepare(`DELETE FROM exploration_shared_job_tombstones
    WHERE job_id IN (
      SELECT job_id FROM exploration_shared_job_tombstones
      WHERE deleted_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-30 days')
      ORDER BY deleted_at, job_id LIMIT ${EXPLORATION_RETENTION_BATCH}
    )`).run();
  // Return only database-reported affected-row counts, never row identifiers.
  return (links?.meta?.changes ?? 0) + (requests?.meta?.changes ?? 0) + (tombstones?.meta?.changes ?? 0);
}
