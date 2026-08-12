import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import type {
  AgentRole,
  LaneCapabilities,
  LaneEvent,
  LaneEventKind,
  LaneProfile,
  LaneTaskSubmission,
} from "@muon/protocol";
import { BaseLaneAdapter } from "./base-lane-adapter.js";
import type { LaneCommandResult } from "./lane-runner.js";
import { sanitizeGuardedArgs } from "./vendor-capabilities.js";

/**
 * The DEV/TEST-ONLY fake vendor (P7 validation seam).
 *
 * This is the injectable driver the full-loop E2E drives THROUGH the real
 * runner spine (dispatch → runner loop → executeJob → runLaneTask). It replaces
 * ONLY the leaf, the vendor CLI subprocess, with a deterministic double:
 * everything above it (agent claim/release, the dispatch state machine, the
 * stream recorder, captureMemories, the two-token boundary) is the REAL code.
 *
 * It normally NEVER spawns a process and NEVER touches the network. Given a brief it:
 *   1. emits a couple of StreamChunk-bearing progress events,
 *   2. makes a known ADDITIVE edit in the task workspace (append-only, it can
 *      never clobber existing content),
 *   3. emits a deterministic `VERDICT: CONCERNS …` line so a dispatch under the
 *      `review` harness exercises the real self-filling-brain capture path, and
 *   4. returns a terminal exit-0 (→ dispatch status `done`).
 *
 * A second, explicit test-only seam (`MUON_FAKE_VENDOR_DESCENDANT_FILE`) may
 * leave one inert child alive and write its PID. Packaged-desktop smoke uses
 * that orphan on purpose to prove supervisor process-group cleanup.
 *
 * PRODUCTION SAFETY: it is only reachable when `MUON_FAKE_VENDOR=1`. The seam is
 * gated in three independent places, the adapter registry (below), the dispatch
 * route's vendor allowlist, and the fleet claim allowlist + seed, so with the
 * env unset there is no `fake` adapter, no `fake` lane, no `fake` fleet agent,
 * and the dispatch route 400s a `fake` vendor before any work is enqueued.
 */

/** The vendor/lane key the fake is registered under. */
export const FAKE_VENDOR_KEY = "fake";

/**
 * ADR-0013 #52 v2, the exact invocation the fake WOULD have spawned, captured
 * for tests. `command`/`args` are what actually reaches the (simulated) spawn:
 * a resolved subcommand `argvOverride` reshapes them, and the same defensive
 * `sanitizeGuardedArgs` backstop the real BaseLaneAdapter runs is applied here,
 * so a guarded flag (e.g. `--strict-mcp-config`) can never appear in `args`.
 */
export type FakeInvocation = {
  taskId: string;
  command: string;
  args: string[];
  profile?: LaneProfile;
};

const fakeInvocations: FakeInvocation[] = [];

/** Every invocation the fake adapter has "spawned" this process, oldest-first. */
export function getFakeInvocations(): readonly FakeInvocation[] {
  return fakeInvocations;
}

/** Most recent captured invocation (or undefined). */
export function lastFakeInvocation(): FakeInvocation | undefined {
  return fakeInvocations[fakeInvocations.length - 1];
}

/** Reset the capture buffer (tests call this in a beforeEach). */
export function clearFakeInvocations(): void {
  fakeInvocations.length = 0;
}

/** The additive artifact the fake writes into the task workspace. */
export const FAKE_ARTIFACT_FILENAME = "MUON_FAKE_VENDOR.touched.md";

/** A stable, searchable word the fake always emits into its verdict body. */
export const FAKE_MEMORY_SENTINEL = "faultline";

/**
 * The single env seam. Reads live env each call so a route/test can toggle the
 * seam within one process (the E2E boots the backend + runner with it set).
 */
export function fakeVendorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MUON_FAKE_VENDOR === "1";
}

export class FakeLaneAdapter extends BaseLaneAdapter {
  readonly id = FAKE_VENDOR_KEY;
  readonly displayName = "Fake Vendor (dev/test)";
  readonly provider = "muon-fake";
  readonly role = "worker" as const;
  // No real binary, the fake never spawns. Kept non-empty so health() has a
  // candidate to name, but runTask is fully overridden below and never uses it.
  readonly commandCandidates = ["muon-fake-vendor"];

  readonly laneCapabilities: LaneCapabilities = {
    canStreamEvents: true,
    canInterrupt: true,
    canBackground: true,
    supportsApprovals: true,
    supportsWorktrees: true,
  };

  /**
   * A full-capability double, so the E2E can drive ANY role through the real
   * assignment engine and the real runner spine without a vendor binary.
   */
  readonly supportedRoles: readonly AgentRole[] = [
    "orchestrator",
    "architect",
    "implementer",
    "reviewer",
    "qa",
    "scout",
    "docs",
  ];

  /**
   * Flat and neutral ON PURPOSE. The fake must never change which lane the
   * assignment engine picks in a mixed crew, and a constant keeps role plans
   * deterministic and diffable — the same property the engine itself promises.
   */
  readonly roleAffinity: Partial<Record<AgentRole, number>> = {
    orchestrator: 0.5,
    architect: 0.5,
    implementer: 0.5,
    reviewer: 0.5,
    qa: 0.5,
    scout: 0.5,
    docs: 0.5,
  };

  /**
   * Deterministic, hermetic run. Overrides BaseLaneAdapter.runTask entirely so
   * NO child process is ever spawned, the whole point of the seam.
   */
  override async runTask(
    input: LaneTaskSubmission,
    onEvent: (event: LaneEvent) => void,
    options?: {
      cwd?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      profile?: LaneProfile;
      /** ADR-0013 #52 v2, per-run subcommand override (see BaseLaneAdapter). */
      argvOverride?: { command?: string; args: string[] };
      /**
       * Live stderr sink (see BaseLaneAdapter). Accepted for seam parity and
       * never called: this adapter spawns no vendor child, so it has no stderr
       * to surface and must not fabricate one.
       */
      onDiagnostic?: (chunk: string) => void;
    }
  ): Promise<LaneCommandResult> {
    const startedAt = Date.now();
    const cwd = options?.cwd ?? process.cwd();
    if (options?.signal?.aborted) {
      return {
        exitCode: 130,
        output: "[fake] interrupted before execution",
        errorOutput: "",
        durationMs: Date.now() - startedAt,
      };
    }

    // Capture the invocation that WOULD reach spawn, the argv override reshapes
    // the command/args, and the SAME defensive `sanitizeGuardedArgs` backstop the
    // real BaseLaneAdapter applies is run here, so a test can assert on exactly
    // what would have been spawned (e.g. that no `--strict-mcp-config` survives).
    const base = this.taskCommand(input.brief);
    const invocation = options?.argvOverride
      ? {
          command: options.argvOverride.command ?? base.command,
          args: options.argvOverride.args,
        }
      : base;
    const guarded = sanitizeGuardedArgs([
      ...invocation.args,
      ...(options?.profile?.extraArgs ?? []),
    ]);
    fakeInvocations.push({
      taskId: input.taskId,
      command: invocation.command,
      args: guarded.args,
      profile: options?.profile,
    });

    const emit = (
      kind: LaneEventKind,
      message: string,
      metadata: Record<string, unknown> = {}
    ): void => {
      onEvent({
        id: randomUUID(),
        laneId: this.id,
        taskId: input.taskId,
        kind,
        message,
        timestamp: new Date().toISOString(),
        metadata,
      });
    };

    const lines: string[] = [];
    const say = (line: string): void => {
      lines.push(line);
    };

    emit("task.started", `[fake] engaged for task ${input.taskId}`);
    say(`[fake] engaged for task ${input.taskId}`);
    emit(
      "task.progress",
      `[fake] read the brief (${input.brief.length} chars); planning one additive edit`
    );
    say("[fake] read the brief; planning one additive edit");

    // ── the ADDITIVE workspace edit ──────────────────────────────────────────
    // Append-only (flag: "a") so a re-run never destroys prior content, this is
    // strictly additive, mirroring how a real coding agent would leave a marker.
    const artifact = path.join(cwd, FAKE_ARTIFACT_FILENAME);
    const stamp = new Date().toISOString();
    const block = [
      `<!-- muon-fake-vendor -->`,
      `- task: ${input.taskId}`,
      `- at: ${stamp}`,
      `- ${FAKE_MEMORY_SENTINEL}: deterministic additive edit by the fake vendor`,
      ``,
    ].join("\n");
    try {
      mkdirSync(cwd, { recursive: true });
      writeFileSync(artifact, block, { flag: "a" });
      emit("task.progress", `[fake] wrote additive artifact ${FAKE_ARTIFACT_FILENAME}`);
      say(`[fake] wrote additive artifact ${FAKE_ARTIFACT_FILENAME}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      emit("task.blocked", `[fake] could not write artifact: ${detail}`);
      return {
        exitCode: 1,
        output: `${lines.join("\n")}\n[fake] FAILED: ${detail}`,
        errorOutput: detail,
        durationMs: Date.now() - startedAt,
      };
    }

    const descendantFile =
      process.env.MUON_FAKE_VENDOR_DESCENDANT_FILE?.trim();
    if (fakeVendorEnabled() && descendantFile) {
      mkdirSync(path.dirname(descendantFile), { recursive: true });
      const descendant = spawn(
        process.execPath,
        [
          "-e",
          "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000)",
        ],
        {
          cwd,
          detached: false,
          stdio: "ignore",
        }
      );
      descendant.unref();
      if (!Number.isInteger(descendant.pid) || (descendant.pid ?? 0) <= 0) {
        throw new Error("fake cleanup descendant started without a positive PID");
      }
      writeFileSync(descendantFile, String(descendant.pid), { mode: 0o600 });
      emit(
        "task.progress",
        `[fake] left cleanup-proof descendant ${descendant.pid}`
      );
      say(`[fake] left cleanup-proof descendant ${descendant.pid}`);
    }

    // ── the deterministic verdict (feeds the real captureMemories path) ──────
    // Under the `review` harness, execute.ts turns a `VERDICT: CONCERNS …` line
    // into a durable, dedup-aware, unconfirmed note, no model in the loop.
    const verdict =
      `VERDICT: CONCERNS ${FAKE_MEMORY_SENTINEL}: the fake vendor deterministically ` +
      `flags a durable follow-up for task ${input.taskId} (self-filling-brain proof).`;
    emit("task.progress", verdict);
    say(verdict);

    emit("task.completed", `[fake] completed task ${input.taskId}`, { exitCode: 0 });
    say(`[fake] completed task ${input.taskId}`);

    return {
      exitCode: 0,
      output: lines.join("\n"),
      errorOutput: "",
      durationMs: Date.now() - startedAt,
    };
  }
}
