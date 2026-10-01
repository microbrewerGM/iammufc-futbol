import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { createMiddleware } from "hono/factory";
import type { Env } from "../core/db";

interface AccessConfig { issuer: string; audience: string; owners: string[]; serviceClientIds?: string[] }
export type AccessIdentity = { sub: string; email: string } | { sub: ""; serviceClientId: string };
type AccessVerifier = (token: string, config: AccessConfig) => Promise<AccessIdentity>;
const resolvers = new Map<string, JWTVerifyGetKey>();

export async function verifyAccess(token: string, config: AccessConfig, keys?: JWTVerifyGetKey): Promise<AccessIdentity> {
  if (!token || token.length > 16384) throw new Error("access_denied");
  if (!keys) {
    keys = resolvers.get(config.issuer);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000 });
      resolvers.set(config.issuer, keys);
    }
  }
  const { payload } = await jwtVerify(token, keys, {
    issuer: config.issuer, audience: config.audience, algorithms: ["RS256"],
    requiredClaims: ["exp", "sub"],
  });
  // Service identities have no human email and an empty subject. Only trust
  // this claim after signature/issuer/audience/expiry verification above.
  if (payload.common_name !== undefined) {
    if (payload.type !== "app" || payload.sub !== "" || payload.email !== undefined ||
        typeof payload.common_name !== "string" ||
        !config.serviceClientIds?.includes(payload.common_name)) throw new Error("access_denied");
    return { sub: "", serviceClientId: payload.common_name };
  }
  if (typeof payload.sub !== "string" || !payload.sub || typeof payload.email !== "string" ||
      !config.owners.includes(payload.email.toLowerCase())) throw new Error("access_denied");
  return { sub: payload.sub, email: payload.email.toLowerCase() };
}

function configuration(env: Env): AccessConfig | null {
  if (!env.ACCESS_ISSUER || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_ISSUER) ||
      !env.ACCESS_AUD || !/^[a-f0-9]{64}$/i.test(env.ACCESS_AUD) ||
      !env.ACCESS_OWNER_EMAILS) return null;
  const owners = env.ACCESS_OWNER_EMAILS.split(",").map((v) => v.trim().toLowerCase());
  if (owners.some((v) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))) return null;
  const serviceClientIds = env.ACCESS_SERVICE_CLIENT_IDS
    ? env.ACCESS_SERVICE_CLIENT_IDS.split(",").map((v) => v.trim()) : [];
  if (serviceClientIds.some((v) => !/^[A-Za-z0-9._-]{1,256}$/.test(v))) return null;
  return { issuer: env.ACCESS_ISSUER, audience: env.ACCESS_AUD, owners, serviceClientIds };
}

/** Always mounted before every route; no local/preview/health auth bypass. */
export function accessGate(verifier: AccessVerifier = verifyAccess) {
  return createMiddleware<{ Bindings: Env }>(async (c, next) => {
    const config = configuration(c.env);
    if (!config) return c.text("Site access is not configured.", 503);
    try { await verifier(c.req.header("cf-access-jwt-assertion") ?? "", config); }
    catch { return c.text("Access denied.", 403); }
    // Access is cookie-backed in browsers. Authorization alone is not CSRF
    // protection. /q also writes demand and consumes budget despite using GET.
    const url = new URL(c.req.url);
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
    // Use the same decoded path as Hono's router (for example /en/%71).
    const query = /^\/(?:en\/|es\/)?q\/?$/.test(c.req.path);
    if (unsafe || query) {
      const origin = c.req.header("Origin");
      const site = c.req.header("Sec-Fetch-Site");
      const sameOrigin = origin === url.origin;
      const sameOriginNavigation = !unsafe && origin === undefined && site === "same-origin";
      if (url.protocol !== "https:" || (site !== undefined && site !== "same-origin") ||
          (!sameOrigin && !sameOriginNavigation)) return c.text("Request origin denied.", 403);
    }
    await next();
  });
}
