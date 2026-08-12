/**
 * P0-2 — the GitHub identity gate, enforced in TRUSTED MAIN.
 *
 * The founder launch requirement: a packaged MUON asks the operator to verify
 * a GitHub identity (device flow) before it will start work. The gate is a
 * property of the IPC boundary, not of React: `installGitHubIpcGate` wraps
 * `ipcMain.handle` itself, so EVERY channel — including one added next month —
 * refuses while the gate is active unless it is POSITIVELY listed exempt
 * (ADR-0022: sets are defined by what they allow, never by subtraction). A
 * renderer that never draws the gate screen still cannot start work.
 *
 * What the gate is NOT:
 *  - Not a connectivity check. Satisfied means "a credential from a completed
 *    device flow is persisted"; going offline later never re-locks the app.
 *  - Not a safety lock. Observation, evidence reads, updates, stop/interrupt/
 *    steer, approval resolution, and the connect flow itself all stay exempt —
 *    an operator must always be able to see, stop, and recover.
 *  - Not on in development. It arms in packaged builds (or under
 *    MUON_REQUIRE_GITHUB_LOGIN=1 for testing); MUON_REQUIRE_GITHUB_LOGIN=0 is
 *    the explicit packaged-build escape hatch.
 */

// One spelling of a boolean env flag, shared with the CLI's attach
// requirement via @muon/client — two derivations of one policy switch is the
// tier-derivation-drift pattern.
import { booleanEnvFlag } from "@muon/client";

export type GitHubGateState = {
  /** The gate policy is armed for this build/run. */
  required: boolean;
  /** A device-flow credential is persisted; the gate is open. */
  satisfied: boolean;
};

/**
 * Whether this build ARMS the gate.
 *
 * Packaged builds default ON — that is the launch requirement — but ONLY when
 * the GitHub App client id is actually configured: the device flow is the
 * gate's one door, and a gate whose door does not exist must not lock. A
 * packaged build shipped WITHOUT `MUON_GITHUB_CLIENT_ID` would otherwise be a
 * consumer dead end (full-screen gate, disabled connect button, an env-var
 * instruction as the only copy). Such a build degrades to UNGATED — and the
 * caller logs it loudly, because it is a release mistake, just not one the
 * user should pay for. The env flag still forces the gate on for testing
 * (you SEE the not-configured state) and off as the packaged escape hatch.
 */
export function githubGateRequired(input: {
  env: Readonly<Record<string, string | undefined>>;
  isPackaged: boolean;
}): boolean {
  const flag = booleanEnvFlag(input.env.MUON_REQUIRE_GITHUB_LOGIN);
  if (flag !== undefined) return flag;
  const clientId = input.env.MUON_GITHUB_CLIENT_ID?.trim() ?? "";
  const clientConfigured = clientId.length >= 8 && clientId.length <= 200;
  return input.isPackaged && clientConfigured;
}

/** True when a packaged build SHOULD be gated but cannot be (no client id) —
 *  the caller must log this as a release defect. */
export function githubGateMisconfigured(input: {
  env: Readonly<Record<string, string | undefined>>;
  isPackaged: boolean;
}): boolean {
  const flag = booleanEnvFlag(input.env.MUON_REQUIRE_GITHUB_LOGIN);
  if (flag !== undefined) return false; // explicit choice, not a mistake
  const clientId = input.env.MUON_GITHUB_CLIENT_ID?.trim() ?? "";
  return input.isPackaged && !(clientId.length >= 8 && clientId.length <= 200);
}

/**
 * The channels a GATED app may still serve. POSITIVE list; everything absent
 * refuses. Four families, each with a reason:
 *
 *  1. The gate's own door — the device flow and the page it must open.
 *  2. Observation — state/evidence reads. Seeing is never gated.
 *  3. Safety and in-flight governance — stop, interrupt, steer, cancel, and
 *     approval decisions. A gate must never strand running work (§11.1:
 *     "offline/revoked state preserves evidence export, interrupt, recovery").
 *  4. Keeping the app updatable and configurable enough to fix itself —
 *     updates, settings, folder picking.
 *
 * Deliberately ABSENT (gated): everything that STARTS work (createChat,
 * sendMessage, runFirstTask, applyWorkflowProposal, continueOrchestration,
 * resumeObjectiveLoop, shipTask, mcpAttach/Install), everything that widens
 * standing authority (setFullAuto*, setFleet, raiseDispatchBudget), and
 * memory writes.
 */
export const GITHUB_GATE_EXEMPT_CHANNELS: ReadonlySet<string> = new Set([
  // 1 — the gate's own door
  "muon:startGitHubDeviceFlow",
  "muon:pollGitHubDeviceFlow",
  "muon:disconnectGitHub",
  "muon:openGitHubUrl",
  // 2 — observation
  "muon:getState",
  "muon:getChat",
  "muon:listChats",
  "muon:selectChat",
  "muon:streams",
  "muon:jobTerminal",
  "muon:jobResumeProbe",
  "muon:terminalScrollback",
  "muon:getHumanTerminalRestore",
  "muon:workspaceReview",
  "muon:reviewDiff",
  "muon:githubReview",
  "muon:memoryLibrary",
  "muon:getMemoryNote",
  "muon:memoryNeighbors",
  "muon:memoryExplain",
  "muon:autoContext",
  "muon:preEditContext",
  "muon:dataBoundaries",
  "muon:crewRoles",
  "muon:coordination",
  "muon:getDispatchBudget",
  "muon:mcpStatus",
  "muon:reconMap",
  "muon:gitnexusGraph",
  "muon:listCustomAgents",
  "muon:listVendorModels",
  "muon:resolveVendorModel",
  "muon:refreshReadiness",
  "muon:getAutoConfirmAgentMemory",
  // 3 — safety and in-flight governance. This family also includes every
  // NARROWING verb: an operator must be able to withdraw standing consent,
  // detach a coordinator seat, and decline a proposal while locked. The same
  // channels can widen (setFullAuto can arm), but a gated profile is an
  // unauthenticated one whose autonomy engines are ALSO gate-checked in main,
  // so the widen direction is inert until the gate opens.
  "muon:stopAll",
  "muon:cancelChat",
  "muon:interruptDispatch",
  "muon:steerDispatch",
  "muon:resolveApproval",
  "muon:reviewApproval",
  "muon:pauseAutonomyCommitment",
  "muon:closeTerminal",
  "muon:setFullAuto",
  "muon:setFullAutoVendors",
  "muon:mcpDetach",
  "muon:dismissWorkflowProposal",
  "muon:setPortPreviewEnabled",
  // 4 — self-maintenance
  "muon:checkForUpdates",
  "muon:downloadUpdate",
  "muon:installUpdate",
  "muon:saveSettings",
  "muon:savePresets",
  "muon:saveCrewConfig",
  "muon:setAutoContinue",
  "muon:setAutoUpdate",
  "muon:setTelemetryEnabled",
  "muon:pickFolder",
]);

export function githubGateRefusal(channel: string): string {
  return (
    `MUON is locked until a GitHub identity is verified (${channel} is gated). ` +
    "Sign in with GitHub on the gate screen — observation, stops, approvals, " +
    "and updates remain available while locked."
  );
}

/** The minimal ipcMain surface the installer needs (injectable for tests). */
export type GateableIpc = {
  handle(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ): void;
  /** Fire-and-forget channels (`ipcRenderer.send`). The terminal byte relay
   *  registers this way — leaving `on` unwrapped let `muon:openTerminal`
   *  spawn a shell in the workspace while the gate screen was up. */
  on(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => void
  ): unknown;
};

/**
 * Wrap `ipc.handle` AND `ipc.on` so every LATER registration is gate-checked.
 * Must be installed BEFORE the app registers its handlers. `isActive` is read
 * per call, so completing the device flow unlocks every channel immediately —
 * no restart, no re-registration.
 *
 * `handle` refusals throw back to the renderer's invoke. `on` has no reply
 * path, so a gated send is DROPPED with a main-side log — for the terminal
 * relay that means keystrokes and opens go nowhere, which is the fail-closed
 * shape a locked app wants.
 */
export function installGitHubIpcGate(
  ipc: GateableIpc,
  isActive: () => boolean
): void {
  const rawHandle = ipc.handle.bind(ipc);
  ipc.handle = (channel, listener) =>
    rawHandle(channel, (event, ...args) => {
      if (isActive() && !GITHUB_GATE_EXEMPT_CHANNELS.has(channel)) {
        throw new Error(githubGateRefusal(channel));
      }
      return listener(event, ...args);
    });
  const rawOn = ipc.on.bind(ipc);
  ipc.on = (channel, listener) =>
    rawOn(channel, (event, ...args) => {
      if (isActive() && !GITHUB_GATE_EXEMPT_CHANNELS.has(channel)) {
        console.error(`[github-gate] dropped gated send: ${channel}`);
        return;
      }
      listener(event, ...args);
    });
}
