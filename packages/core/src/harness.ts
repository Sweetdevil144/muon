import {
  harnessConfigSchema,
  laneProfileSchema,
  type HarnessConfig,
  type LaneProfile,
} from "@muon/protocol";

export type SeededHarness = {
  key: string;
  name: string;
  config: HarnessConfig;
};

/**
 * The harness library MUON seeds (VISION §6.3), defined HERE rather than in the
 * backend's bootstrap so the rows a user gets and the rows a test reasons about
 * cannot drift apart. `implement`'s single `npm test` check plus a root vitest
 * `include` that reached two packages of fifteen is exactly what produced a
 * `tests:pass` on a mission whose only changed file was never collected; a
 * regression fixture that hand-copies that check would go on passing while the
 * seed moved. The backend seeds THIS array; check-coverage tests read THIS
 * array. One source of truth, by construction.
 */
export const DEFAULT_HARNESSES: SeededHarness[] = [
  {
    key: "implement",
    name: "Implement",
    config: harnessConfigSchema.parse({
      description:
        "Build changes in an isolated worktree; tests are the success check.",
      profileOverlay: { permissionMode: "default", sandbox: "workspace-write" },
      // NOTE: intentionally NO preauthorizedTools. Auto-preauthorizing Write
      // is unsafe while `checks` run `npm test` host-side via a shell
      // (loop-runner runShellCheck) with no sandbox, a silent Write could
      // rewrite package.json's test script into arbitrary host code that
      // MUON then executes. Until the check runner is sandboxed (R5), edits
      // stay must-ask so the human sees them; a user who accepts the risk
      // can preauthorize tools on the lane profile explicitly.
      //
      // The declared command stays repo-wide on purpose: it is the DEFAULT and
      // the fallback. When it provably collects nothing from a run's changed
      // files, the loop derives the changed packages' own test scripts from the
      // repository's manifests (derived-checks.ts) instead of blocking on it.
      checks: [{ name: "tests", command: "npm test" }],
      // Completion already fails closed when preflight coverage is missing, so
      // a session without `preflight_edit` is guaranteed to fail LATE and
      // confusingly. Saying so up front turns that into a clear early fact.
      requires: {
        interactive: false,
        worktree: true,
        tools: ["preflight_edit", "memory_preedit"],
      },
    }),
  },
  {
    key: "review",
    name: "Review",
    config: harnessConfigSchema.parse({
      description: "Read-only review; verdict only, no edits.",
      profileOverlay: { permissionMode: "strict", sandbox: "read-only" },
      // Feature #10. THE harness the field notes were about: a reviewer whose
      // allowlist excluded MCP still produced a confident verdict, reached by
      // grep, and only a human reading closely caught it. Declaring the tools
      // here does not grant them — it makes their absence a named line in the
      // brief instead of an invisible downgrade in method.
      requires: {
        interactive: false,
        worktree: false,
        tools: ["review_diff", "code_query", "code_impact"],
      },
    }),
  },
  {
    key: "planner",
    name: "Planner",
    config: harnessConfigSchema.parse({
      description:
        "Bounded read-only workflow planning through the lease-fenced dispatch spine.",
      profileOverlay: { permissionMode: "strict", sandbox: "read-only" },
      budget: { maxWallMs: 120_000 },
      requires: { interactive: false, worktree: false },
    }),
  },
  {
    // Wave 0: a first-class read-only investigation harness so a research crew
    // never falls back to a harness-less profile (which emits lane-unsupported
    // fields). Broad reads via `read-only` sandbox; no edits, no worktree.
    key: "research",
    name: "Research",
    config: harnessConfigSchema.parse({
      description:
        "Read-only investigation across the workspace; broad reads, no edits, no worktree.",
      // "No edits" is enforced two ways: the read-only sandbox blocks OS-level
      // writes, AND the edit tools are WITHHELD so the agent can't even attempt
      // one — otherwise a must-ask Write approval fires before the sandbox ever
      // runs (the cause of the spurious "approve muon-test.ts" on the quickstart
      // first task). Denies the edit tools across vendors (claude + codex).
      profileOverlay: {
        permissionMode: "strict",
        sandbox: "read-only",
        deniedTools: [
          "Write",
          "Edit",
          "MultiEdit",
          "NotebookEdit",
          "apply_patch",
        ],
      },
      budget: { maxWallMs: 600_000 },
      requires: { interactive: false, worktree: false },
    }),
  },
  {
    key: "security-audit",
    name: "Security audit",
    config: harnessConfigSchema.parse({
      description: "Read-only audit with network tools denied.",
      profileOverlay: {
        permissionMode: "strict",
        sandbox: "read-only",
        deniedTools: ["WebFetch", "WebSearch"],
      },
      // An audit that cannot ask who calls a symbol, or where data crosses a
      // boundary, is a text search wearing an audit's name.
      requires: {
        interactive: false,
        worktree: false,
        tools: ["code_impact", "data_boundaries"],
      },
    }),
  },
  {
    key: "repair",
    name: "Repair",
    config: harnessConfigSchema.parse({
      description:
        "Fix failing checks; the loop runner appends the failure tail to each iteration's brief.",
      profileOverlay: { permissionMode: "default", sandbox: "workspace-write" },
      // No preauthorizedTools, same reason as `implement`: the repair loop's
      // checks run host-side shell, so a silently-preauthorized Write is a
      // host-RCE vector. Edits stay must-ask until checks are sandboxed (R5).
      checks: [{ name: "tests", command: "npm test" }],
      requires: {
        interactive: false,
        worktree: true,
        tools: ["preflight_edit", "memory_preedit"],
      },
    }),
  },
];

const READ_ONLY_MUTATION_TOOLS = [
  "Bash",
  "Shell",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "apply_patch",
] as const;

/**
 * Merge precedence (vision-orchestration-brainstorm §5.4): LaneProfile (lane
 * default) ⊕ Harness.profileOverlay, the overlay wins per field, because a
 * harness is authoritative about its constraint set. Exceptions that merge
 * instead of replace:
 * - `env` / `rawConfig` shallow-merge (overlay keys win)
 * - `extraArgs` concatenates (profile first, overlay appended)
 * - `mcpServers` merges by name (overlay wins) so the injected MUON MCP
 *   server survives a harness that adds its own servers
 */
export function mergeHarnessOverlay(
  profile: LaneProfile | undefined,
  overlay: Partial<LaneProfile> | undefined
): LaneProfile {
  const base = profile ?? laneProfileSchema.parse({});
  if (!overlay) {
    return base;
  }

  return {
    ...base,
    ...(overlay.model !== undefined ? { model: overlay.model } : {}),
    ...(overlay.permissionMode !== undefined
      ? { permissionMode: overlay.permissionMode }
      : {}),
    ...(overlay.sandbox !== undefined ? { sandbox: overlay.sandbox } : {}),
    ...(overlay.contextFiles !== undefined
      ? { contextFiles: overlay.contextFiles }
      : {}),
    ...(overlay.addDirs !== undefined ? { addDirs: overlay.addDirs } : {}),
    ...(overlay.allowedTools !== undefined
      ? { allowedTools: overlay.allowedTools }
      : {}),
    ...(overlay.deniedTools !== undefined
      ? { deniedTools: overlay.deniedTools }
      : {}),
    env: { ...base.env, ...(overlay.env ?? {}) },
    extraArgs: [...base.extraArgs, ...(overlay.extraArgs ?? [])],
    rawConfig: { ...base.rawConfig, ...(overlay.rawConfig ?? {}) },
    mcpServers:
      overlay.mcpServers !== undefined
        ? [
            ...base.mcpServers.filter(
              (server) =>
                !overlay.mcpServers?.some((entry) => entry.name === server.name)
            ),
            ...overlay.mcpServers,
          ]
        : base.mcpServers,
  };
}

/**
 * Applies a full harness to a lane profile: profile overlay plus the
 * pre-authorization contract, `preauthorizedTools` union into
 * `allowedTools` is the ONLY pre-auth path; everything else stays must-ask
 * through the approvals inbox (fail closed).
 */
export function applyHarnessToProfile(
  profile: LaneProfile | undefined,
  harness: HarnessConfig
): LaneProfile {
  const merged = mergeHarnessOverlay(profile, harness.profileOverlay);
  if (harness.preauthorizedTools.length > 0) {
    merged.allowedTools = [
      ...new Set([...merged.allowedTools, ...harness.preauthorizedTools]),
    ];
  }
  if (merged.sandbox === "read-only") {
    // A normalized "read-only" profile must stay read-only even on a lane
    // whose native CLI has no filesystem sandbox flag. Deny every common
    // mutation/shell surface and remove an exact conflicting preauthorization.
    // This only narrows authority; vendor-native sandboxes remain an additional
    // boundary where available.
    merged.deniedTools = [
      ...new Set([...merged.deniedTools, ...READ_ONLY_MUTATION_TOOLS]),
    ];
    const denied = new Set(merged.deniedTools);
    merged.allowedTools = merged.allowedTools.filter(
      (tool) => !denied.has(tool)
    );
  }
  return merged;
}

export type HarnessDispatchContext = {
  laneKey: string;
  /** Whether this dispatch path can run an interactive session. */
  interactiveAvailable: boolean;
  /** Whether the dispatch runs in an isolated worktree. */
  worktree: boolean;
};

/**
 * Fails fast when a harness needs what the dispatch cannot provide,
 * honest lane asymmetry instead of silent degradation.
 */
export function assertHarnessRequirements(
  harness: HarnessConfig,
  context: HarnessDispatchContext
): void {
  if (harness.laneKey && harness.laneKey !== context.laneKey) {
    throw new Error(
      `Harness is lane-specific ('${harness.laneKey}') but dispatching on '${context.laneKey}'.`
    );
  }
  if (harness.requires.interactive && !context.interactiveAvailable) {
    throw new Error(
      `Harness requires an interactive session; lane '${context.laneKey}' dispatch here is one-shot. Use \`muon session start\` on a peer lane.`
    );
  }
  if (harness.requires.worktree && !context.worktree) {
    throw new Error(
      "Harness requires an isolated worktree; re-run with --worktree."
    );
  }
}
