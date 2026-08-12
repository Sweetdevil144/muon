import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // `URL.pathname` is PERCENT-ENCODED, so a checkout under a path with a
      // space resolved `@/…` to `…/Application%20Support/…` and every aliased
      // import failed to resolve. That is not hypothetical: MUON's own governed
      // task worktrees live outside the repository, and a governed run of this
      // repo failed its whole test suite for this reason (2026-08-05).
      // `fileURLToPath` decodes back to a real filesystem path.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: [
      "src/**/*.test.{ts,tsx}",
      "packages/protocol/tests/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    exclude: ["backend/**"],
  },
});
