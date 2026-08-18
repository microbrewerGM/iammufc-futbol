import { defineConfig } from "vitest/config";

// Core logic tests run in plain Node: they exercise pure functions plus
// crypto.subtle, which Node provides globally. The Workers runtime pool
// (@cloudflare/vitest-pool-workers) is introduced alongside the route tests,
// where real bindings actually matter -- running pure-logic tests inside
// workerd would cost startup time for no additional fidelity.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
