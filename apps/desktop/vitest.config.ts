import { defineConfig } from "vitest/config";

export default defineConfig({
  // The renderer is built with the automatic JSX runtime (`--jsx=automatic`);
  // mirror that here so tests can render renderer components (e.g. the
  // onboarding wizard) without a classic `import React` in scope.
  esbuild: { jsx: "automatic" },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // MATCHES `packages/graph` and `packages/codegraph`, the repo's other two
    // I/O-heavy workspaces, which already set exactly this.
    //
    // This suite spawns real node-pty processes, real child processes and real
    // temp directories across 8+ files, all against vitest's 5s DEFAULT. On
    // 2026-08-08 a full-matrix run failed 1 of 1868 here and then passed
    // 1868/1868 four times in a row — the same signature as a backend test
    // measured at 5008ms against the same 5s default: not a behaviour change,
    // a scheduling loss under parallel load.
    //
    // Raised for the CLASS rather than per-test, because the failing member
    // was never captured (the matrix pipe kept only summary lines) and eight
    // files share the risk. A genuinely hung test still fails — it just takes
    // 30s to say so, which is the right trade against a suite that
    // intermittently lies about a green tree.
    testTimeout: 30_000,
  },
});
