import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createExplorationBridgeRouter } from "../worker/src/routes/exploration-bridge";
import { hmacCursorSigner } from "../worker/src/core/exploration-bridge";
import type { StoredJob } from "../worker/src/core/exploration-bridge";
import type { AccessEnv, AccessIdentity } from "../worker/src/security/auth";

const serviceClientId = "0123456789abcdef0123456789abcdef.access";
const router = createExplorationBridgeRouter();
const env = (overrides: Record<string, unknown> = {}) => ({
  ACCESS_ISSUER: "https://test.cloudflareaccess.com",
  ACCESS_AUD: "a".repeat(64),
  ACCESS_OWNER_EMAILS: "owner@example.com",
  ACCESS_SERVICE_CLIENT_IDS: serviceClientId,
  BRIDGE_CURSOR_KEY: "synthetic-cursor-key",
  BRIDGE_PUBLICATION_VERIFIER: { verify: async () => true },
  BRIDGE_NOW: () => new Date("2026-01-01T00:00:00Z"),
  BRIDGE_NEW_LEASE_ID: () => "lease:test",
  DB: {
    prepare: () => ({ bind() { return this; }, first: async () => null, all: async () => ({ results: [] }) }),
    batch: async () => [],
  },
  ...overrides,
});
const request = (path: string, body = "{}", method = "POST", headers: Record<string, string> = {}) =>
  new Request(`https://site.invalid${path}`, { method, headers: { "content-type": "application/json", Origin: "https://site.invalid", ...headers }, body: method === "GET" ? undefined : body });

const authenticatedEnv = (overrides: Record<string, unknown> = {}) => env({ ...overrides, ACCESS_SERVICE_CLIENT_IDS: overrides.ACCESS_SERVICE_CLIENT_IDS ?? serviceClientId });

function withIdentity(identity: AccessIdentity | undefined): typeof router {
  const app = new Hono<AccessEnv>();
  app.use("*", async (c, next) => {
    if (identity) c.set("accessIdentity", identity);
    await next();
  });
  app.route("/", createExplorationBridgeRouter());
  return app;
}
const serviceRouter = withIdentity({ sub: "", serviceClientId });
const humanRouter = withIdentity({ sub: "human", email: "owner@example.com" });
const missingIdentityRouter = withIdentity(undefined);

function stored(): StoredJob {
  return { admitted_at: "2026-01-01T00:00:00Z", revision: 1, lease_owner: null, job: {
    job_id: "a".repeat(64), request: { version: 1, family: "arrival_manager", as_of: "2025-01-01", population: "first_team_available",
      joining_basis: "effective_first_team_spell_entry", academy_basis: "documented_first_team_promotion", visualization: "table" },
    status: "queued", attempt: 0, lease_id: null, lease_expires_at: null, retry_after: null, failure: null, publication: null,
  } };
}

describe("exploration bridge routes", () => {
  it("rejects non-POST requests", async () => {
    const response = await serviceRouter.fetch(request("/read", "", "GET"), authenticatedEnv() as never);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it.each(["anonymous", "human", "forged-header", "wrong-service"])("denies %s before D1 lookup", async (variant) => {
    const first = vi.fn(async () => null);
        const init = request("/claim", JSON.stringify({ version: 1, kind: "claim", payload: { job_id: "a".repeat(64), expected_attempt: 0, operation_id: "op:1" } }));
    const app = variant === "human" ? humanRouter : variant === "anonymous" ? missingIdentityRouter
      : variant === "forged-header" ? withIdentity(undefined) : serviceRouter;
    const testRequest = variant === "forged-header"
      ? request("/claim", JSON.stringify({ version: 1, kind: "claim", payload: { job_id: "a".repeat(64), expected_attempt: 0, operation_id: "op:1" } }), "POST", { "x-access-service-client-id": serviceClientId })
      : init;
    const targetEnv = variant === "wrong-service"
      ? authenticatedEnv({ ACCESS_SERVICE_CLIENT_IDS: "another.machine" })
      : authenticatedEnv({ DB: { prepare: () => ({ bind() { return this; }, first, all: async () => ({ results: [] }) }), batch: async () => [] } });
    const response = await app.fetch(testRequest, targetEnv as never);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "invalid_caller" });
    expect(first).not.toHaveBeenCalled();
  });

  it("production caller gate rejects missing identity and unconfigured service", async () => {
    const missing = await missingIdentityRouter.fetch(request("/read"), authenticatedEnv() as never);
    expect(missing.status).toBe(403);
    const wrongService = await serviceRouter.fetch(request("/read"), authenticatedEnv({ ACCESS_SERVICE_CLIENT_IDS: "another.machine" }) as never);
    expect(wrongService.status).toBe(403);
  });

  it("enforces content-length and actual byte size before parsing", async () => {
    const tooLong = await serviceRouter.fetch(request("/read", "{}", "POST", { "content-length": "70000" }), authenticatedEnv() as never);
    expect(tooLong.status).toBe(413);
    expect(await tooLong.json()).toEqual({ error: "too_large" });
    const longBody = await serviceRouter.fetch(request("/read", "x".repeat(64 * 1024 + 1)), authenticatedEnv() as never);
    expect(longBody.status).toBe(413);
  });

  it("maps malformed envelopes to 400 without exposing details", async () => {
    const response = await serviceRouter.fetch(request("/read", "{"), authenticatedEnv() as never);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "malformed" });
  });

  it("delegates read to the core backed by the D1 adapter", async () => {
    const job = stored();
    const all = vi.fn(async () => ({ results: [{
      job_id: job.job.job_id, request_json: JSON.stringify(job.job.request), status: "queued", attempt: 0,
      lease_id: null, lease_owner: null, lease_expires_at: null, retry_after: null, failure: null, publication_json: null,
      admitted_at: job.admitted_at, revision: 1,
    }] }));
    const db = { prepare: () => ({ bind() { return this; }, first: async () => null, all }), batch: async () => [] };
    const response = await serviceRouter.fetch(request("/read", JSON.stringify({ version: 1, kind: "read", payload: { cursor: null, limit: 5 } })),
      authenticatedEnv({ DB: db }) as never);
    expect(response.status).toBe(200);
    const body = await response.json() as { payload: { jobs: Array<{ job_id: string }> } };
    expect(body.payload.jobs.map((j) => j.job_id)).toEqual([job.job.job_id]);
    expect(all).toHaveBeenCalledOnce();
  });

  it("uses the normalized Access client id as the cursor caller service", async () => {
    const job = stored();
    const all = async () => ({ results: [{
      job_id: job.job.job_id, request_json: JSON.stringify(job.job.request), status: "queued", attempt: 0,
      lease_id: null, lease_owner: null, lease_expires_at: null, retry_after: null, failure: null, publication_json: null,
      admitted_at: job.admitted_at, revision: 1,
    }, { job_id: "b".repeat(64), request_json: JSON.stringify(job.job.request), status: "queued", attempt: 0,
      lease_id: null, lease_owner: null, lease_expires_at: null, retry_after: null, failure: null, publication_json: null,
      admitted_at: "2026-01-02T00:00:00Z", revision: 1 }] });
    const body = JSON.stringify({ version: 1, kind: "read", payload: { cursor: null, limit: 1 } });
    const response = await serviceRouter.fetch(request("/read", body), authenticatedEnv({
      DB: { prepare: () => ({ bind() { return this; }, first: async () => null, all }), batch: async () => [] },
      BRIDGE_CURSOR_KEY: "synthetic-cursor-key",
    }) as never);
    expect(response.status).toBe(200);
    const result = await response.json() as { payload: { next_cursor: string } };
    const cursor = result.payload.next_cursor;
    const signature = cursor.split(":")[1];
    const signer = hmacCursorSigner(new TextEncoder().encode("synthetic-cursor-key"));
    const expectedSignature = await signer.sign(`0123456789abcdef0123456789abcdef_access\narrival_manager:bridge:v1\n2026-01-01T00:00:00.000Z\n${job.job.job_id}`);
    expect(signature).toBe(expectedSignature);
  });
});
