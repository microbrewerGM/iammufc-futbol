import { expect, it } from "vitest";
import { withSecurityHeaders } from "../worker/src/security/headers";

it("preserves same-origin form Origin without sending external referrers", () => {
  const response = withSecurityHeaders(new Response("form"));
  // Fetch's append-request-Origin algorithm turns no-referrer POSTs into
  // Origin:null, which correctly fails the application's CSRF check.
  expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
  expect(response.headers.get("Content-Security-Policy")).toContain("form-action 'self'");
  expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'none'");
});
