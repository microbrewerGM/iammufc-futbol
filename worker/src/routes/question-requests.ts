import { Hono } from "hono";
import { INTAKE_MAX_BYTES, readQuestionStatus, storeQuestion, validAccountSub, validQuestionText } from "../core/question-requests";
import type { Env } from "../core/db";
import { accessIdentity, type AccessEnv } from "../security/auth";
import { questionRequestPage } from "../views/question-requests";

export type RouteEnv = AccessEnv & { Bindings: Env };
export function createQuestionRequestsRouter() {
  const router = new Hono<RouteEnv>();
  router.get("/:locale{en|es}/requests", async (c) => {
    const identity = accessIdentity(c);
    if (!identity || !validAccountSub(identity.sub)) return c.text("Forbidden.", 403);
    const locale = c.req.param("locale") as "en" | "es";
    const id = c.req.query("id") ?? "";
    const status = /^[0-9a-f]{64}$/.test(id) ? await readQuestionStatus(c.env, identity.sub, id) : null;
    return c.html(questionRequestPage(locale, status ?? undefined));
  });
  router.post("/:locale{en|es}/requests", async (c) => {
    const identity = accessIdentity(c);
    if (!identity || !validAccountSub(identity.sub)) return c.text("Forbidden.", 403);
    const locale = c.req.param("locale") as "en" | "es";
    const length = c.req.header("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > INTAKE_MAX_BYTES)) return c.text("Request too large.", 413);
    if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) return c.text("Invalid request.", 400);
    let raw: string;
    try { raw = await c.req.text(); } catch { return c.html(questionRequestPage(locale, undefined, "invalid"), 400); }
    if (new TextEncoder().encode(raw).byteLength > INTAKE_MAX_BYTES) return c.text("Request too large.", 413);
    let form: URLSearchParams;
    try { form = new URLSearchParams(raw); } catch { return c.html(questionRequestPage(locale, undefined, "invalid"), 400); }
    const text = validQuestionText(form.get("text"));
    if (!text) return c.html(questionRequestPage(locale, undefined, "invalid"), 400);
    const result = await storeQuestion(c.env, identity.sub, text, locale);
    if (result.kind !== "stored" && result.kind !== "duplicate") {
      const status = result.kind === "daily_limit" || result.kind === "pending_limit" ? 429 : 503;
      return c.html(questionRequestPage(locale, undefined, "unavailable"), status);
    }
    return c.redirect(`/${locale}/requests?id=${encodeURIComponent(result.requestId)}`, 303);
  });
  router.all("/:locale{en|es}/requests", (c) => c.text("Method not allowed.", 405, { Allow: "GET, POST" }));
  return router;
}
