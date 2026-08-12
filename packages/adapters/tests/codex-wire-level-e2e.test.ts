import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { CodexSessionDriver } from "../src/codex-session-driver.js";
import { MUON_CONTEXT_TOOL_NAMES, type LaneEvent } from "@muon/protocol";
import { installFakeCodexBinary } from "./fixtures/spawn-fake-codex-binary.js";

// ── The session-protocol double, exercised over a REAL wire (P10) ──────────
//
// Every other CodexSessionDriver test substitutes the `RpcTransport` seam
// in-memory (see `fakeAppServer()` in codex-session-driver.test.ts) — proven,
// but it never crosses a real process boundary, so it cannot catch a framing
// bug in `spawnCodexTransport` itself (NDJSON line splitting, stdin write
// shape, exit-code plumbing). This test drives the UNMODIFIED production
// transport: it puts a wire-level fake `codex` binary
// (fixtures/fake-codex-app-server.mjs) on `PATH`, lets `commandExists("codex")`
// and `spawn("codex", ["app-server", ...])` resolve to it exactly as they
// would resolve to the real vendor CLI, and asserts the driver completes a
// full turn over real stdin/stdout NDJSON framing.
//
// Hermetic: no network, no real vendor CLI, a fresh temp PATH entry cleaned up
// after each test, and the original `process.env.PATH` is always restored.
describe("CodexSessionDriver wire-level double (real process, real NDJSON stdio)", () => {
  const originalPath = process.env.PATH;
  let cleanupBinary: (() => void) | undefined;

  afterEach(() => {
    process.env.PATH = originalPath;
    cleanupBinary?.();
    cleanupBinary = undefined;
  });

  it("completes a full turn by spawning the fake codex binary and speaking real NDJSON over its stdio", async () => {
    const { binDir, cleanup } = installFakeCodexBinary({
      muonToolNames: MUON_CONTEXT_TOOL_NAMES,
    });
    cleanupBinary = cleanup;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    const driver = new CodexSessionDriver();
    const events: LaneEvent[] = [];

    const handle = await driver.start(
      { taskId: "task-wire-e2e", brief: "prove the wire round-trips" },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );

    expect(handle.vendorSessionId).toBe("fake-wire-thread-1");

    const result = await handle.wait();

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(
      "hello from the fake wire-level codex app-server"
    );
    expect(events.some((event) => event.kind === "task.completed")).toBe(true);

    await handle.interrupt();
  });
});
