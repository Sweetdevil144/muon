import {
  createDefaultAdapters,
  type BaseLaneAdapter,
  type LaneCommandResult,
} from "@muon/adapters";
import type { AgentRole, LaneEvent, LaneProfile } from "@muon/protocol";

// Re-exported so @muon/runner (which reaches adapters only through core) can
// type its injected pty factory without adding a package dependency.
export type { LanePtyOptions, LanePtySpawn } from "@muon/adapters";
// The pty-child teardown the runner's exit handlers must call: node-pty
// setsids, so these children escape every process-group sweep MUON performs.
export {
  liveLanePtyChildCount,
  terminateLanePtyChildren,
} from "@muon/adapters";
// The one shape a vendor session id may take. Shared so the runner refuses a
// malformed id at the report site rather than 400ing the brain's backlink
// route and silently losing the job's resume handle.
export { isVendorSessionId } from "@muon/adapters";

export type RunLaneTaskInput = {
  laneKey: string;
  taskId: string;
  brief: string;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  profile?: LaneProfile;
  onEvent: (event: LaneEvent) => void;
  /**
   * ADR-0013 #52, a resolved vendor action's dispatch inputs. `briefPrefix`
   * prepends to the brief (the one-shot analog of a slash-command); `argvOverride`
   * replaces the adapter's default `taskCommand` (e.g. the `ultrareview`
   * subcommand). The profile patch is merged by the CALLER before this point, so
   * the compiler seam is unchanged.
   */
  briefPrefix?: string;
  argvOverride?: { command?: string; args: string[] };
  /**
   * The crew role this run executes as (ADR-0020), forwarded to the adapter so a
   * lane can refuse a role it must never hold.
   *
   * This is DEFENCE IN DEPTH, not the primary control: the dispatch route
   * refuses a vendor/role mismatch (`assertVendorMayHoldRole`) and the runner
   * narrows-then-asserts the composed profile before spawning. But
   * `CursorAdapter.runTask` carries its own read-only assertion, and without
   * this field that assertion received `undefined` on every dispatch and was
   * silently inert — a guard that cannot see its input is not a guard.
   */
  role?: AgentRole;
  /**
   * Live view of the vendor child's stderr, forwarded to the adapter seam. The
   * runner's liveness watchdog subscribes so a stall can report what the vendor
   * ITSELF said inside the watchdog window (a quota/billing rejection can take
   * minutes to reach stdout), instead of asserting a cause nobody observed.
   * Optional: omitting it leaves the run byte-identical.
   */
  onDiagnostic?: (chunk: string) => void;
  /**
   * Live console-byte sink, forwarded to the adapter spawn seam so the runner
   * can relay what the vendor's terminal actually showed. Observational only:
   * omitting it leaves the run byte-identical, and a lane that runs through an
   * in-process SDK simply never calls it.
   */
  onBytes?: (frame: { stream: "stdout" | "stderr"; data: string }) => void;
  /**
   * REAL-terminal transport for the spawn seam, forwarded verbatim. Only a
   * lane that opts in (`prefersPtyConsole`) uses it; every pipes-contract lane
   * ignores it by construction. The runner injects the platform factory —
   * this module never touches the native module.
   */
  pty?: import("@muon/adapters").LanePtyOptions;
  /** Vendor session id at first knowledge — the resume/backlink handle. */
  onVendorSessionId?: (vendorSessionId: string) => void;
};

/**
 * Whether this lane's one-shot child actually runs on an injected pty (it
 * opted in via `prefersPtyConsole`). The runner asks THIS instead of spelling
 * vendor names, so its stderr-evidence accounting can never drift from the
 * adapter's real transport: a pipes-contract lane (claude SDK, cursor) keeps
 * its stderr observer even when a pty factory is available.
 */
export function laneUsesPtyConsole(
  laneKey: string,
  adapters: BaseLaneAdapter[] = createDefaultAdapters() as BaseLaneAdapter[]
): boolean {
  return (
    adapters.find((entry) => entry.id === laneKey)?.prefersPtyConsole === true
  );
}

export async function runLaneTask(
  input: RunLaneTaskInput,
  adapters: BaseLaneAdapter[] = createDefaultAdapters() as BaseLaneAdapter[]
): Promise<LaneCommandResult> {
  const adapter = adapters.find((entry) => entry.id === input.laneKey);
  if (!adapter) {
    throw new Error(
      `Unknown lane '${input.laneKey}'. Available: ${adapters
        .map((entry) => entry.id)
        .join(", ")}`
    );
  }

  const brief = input.briefPrefix
    ? `${input.briefPrefix}\n\n${input.brief}`
    : input.brief;

  return adapter.runTask(
    {
      taskId: input.taskId,
      brief,
      ...(input.role ? { role: input.role } : {}),
    },
    input.onEvent,
    {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      profile: input.profile,
      argvOverride: input.argvOverride,
      ...(input.onDiagnostic ? { onDiagnostic: input.onDiagnostic } : {}),
      ...(input.onBytes ? { onBytes: input.onBytes } : {}),
      ...(input.pty ? { pty: input.pty } : {}),
      ...(input.onVendorSessionId
        ? { onVendorSessionId: input.onVendorSessionId }
        : {}),
    }
  );
}
