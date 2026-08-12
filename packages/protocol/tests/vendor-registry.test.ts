import { describe, expect, it } from "vitest";
import { AGENT_ROLES, ROLE_SPECS, type AgentRole } from "../src/agent-role.js";
import {
  DEFAULT_COORDINATOR_PREFERENCE,
  SESSION_DRIVERS_THAT_CAN_INTERRUPT,
  SESSION_DRIVER_UNENFORCEABLE_CONTROLS,
  VENDOR_IDS,
  VENDOR_REGISTRY,
  VENDOR_ROUTING_POLICY,
  coordinatorPreference,
  coordinatorVendorIds,
  defaultCoordinatorVendor,
  delegatableVendorIds,
  dispatchableVendorIds,
  evaluatorVendorIds,
  fleetVendorIds,
  isVendorId,
  plannerVendorIds,
  publicVendorIds,
  sessionCapability,
  terminalTakeoverVendorIds,
  vendorEntry,
  vendorIdSchema,
  vendorRoleCeiling,
  vendorRoutingLines,
  vendorMayHoldWriteAuthority,
  vendorUnenforceableControls,
  vendorsWhere,
  type VendorId,
} from "../src/vendor.js";

/**
 * ADR-0022 mechanism 5 — the governance backstop.
 *
 * The mapped type on `VENDOR_REGISTRY` catches an OMISSION at compile time. It
 * cannot catch a WRONG VALUE, and a wrong value in this table now widens
 * authority everywhere at once. So this file holds its OWN hand-written literal
 * posture table and asserts the registry equals it: two independent statements
 * that must agree. Adding a vendor fails here until its posture is stated twice.
 *
 * DO NOT derive anything below from `VENDOR_REGISTRY`. The moment an expectation
 * reads the registry it stops being a second statement and becomes a tautology.
 */

const ALL_SEVEN_ROLES: readonly AgentRole[] = [
  "orchestrator",
  "architect",
  "implementer",
  "reviewer",
  "qa",
  "scout",
  "docs",
];

type ExpectedPosture = {
  displayName: string;
  shortLabel: string;
  iconKey: string;
  provider: string;
  visibility: "public" | "dev-test";
  cost: number;
  supportedRoles: readonly AgentRole[];
  coordinatorSeat: boolean;
  dispatchable: boolean;
  delegatable: boolean;
  fleetSizeable: boolean;
  evaluator: boolean;
  planner: boolean;
  terminalTakeover: boolean;
  sessionDriver: "claude-sdk" | "codex-app-server" | "none";
  canSend: boolean;
  canInterrupt: boolean;
  canResume: boolean;
  persistsSessionHandle: boolean;
  modes: readonly ("one-shot" | "interactive" | "background")[];
  commandCandidates: readonly string[];
  hasRuntimeRequirement: boolean;
  compiler: "claude" | "codex" | "opencode" | "cursor" | "passthrough";
  strictMcpConfigFlag: boolean;
  wideningFlags: readonly string[];
  /**
   * TODO 1.16. `hasNativeFanOut: false` is the POSITIVE claim that the vendor
   * ships no sub-agent mechanism, not an unfilled slot — which is why it is
   * written here per vendor rather than derived. `suppression` is how far the
   * claim is proven, in the same three-way honesty used elsewhere in this
   * codebase.
   */
  hasNativeFanOut: boolean;
  fanOutSuppression: "enforced" | "declared" | "none";
  /**
   * TODO 1.15. `[]` is the POSITIVE claim that the vendor reads only its own hook
   * layers — the same shape as `hasNativeFanOut: false`, and written per vendor
   * for the same reason. This entry exists because the field was ADDED without
   * this table noticing: `tsc` refused a registry row missing it, and every
   * assertion here still passed, so the independent statement that is supposed to
   * disagree had nothing to say about the new one.
   */
  foreignHookSources: readonly string[];
  foreignHookContainment: "owned" | "partial" | "none";
  installedCandidates: readonly string[];
  connectKind: "account" | "local-runtime";
  envKeys: readonly string[];
  ownedKeys: readonly string[];
  forwardToRunner: boolean;
  /**
   * `null` means "MUON can verify NOTHING about an id for this lane", which must
   * stay legal — and since TODO 3.4 that is all it means. `idShape` is pinned
   * here too: it is the column that decides whether a lane with an
   * unenumerable catalogue (`known: []`) accepts a per-dispatch override at all,
   * so leaving it out of this second statement would let it drift unwatched.
   */
  models: {
    known: readonly string[];
    allowCustom: boolean;
    idShape: "provider-qualified" | null;
  } | null;
};

const EXPECTED: Record<VendorId, ExpectedPosture> = {
  "claude-code": {
    displayName: "Claude Code",
    shortLabel: "Claude",
    iconKey: "claude-code",
    provider: "anthropic",
    visibility: "public",
    cost: 0.9,
    supportedRoles: ALL_SEVEN_ROLES,
    coordinatorSeat: true,
    dispatchable: true,
    delegatable: true,
    fleetSizeable: true,
    evaluator: true,
    planner: true,
    terminalTakeover: true,
    sessionDriver: "claude-sdk",
    canSend: false,
    canInterrupt: true,
    canResume: true,
    persistsSessionHandle: true,
    modes: ["one-shot", "interactive", "background"],
    commandCandidates: ["claude"],
    hasRuntimeRequirement: false,
    compiler: "claude",
    strictMcpConfigFlag: true,
    wideningFlags: [],
    // The `Task` tool, denied CATEGORICALLY: the compiler unions it into
    // `--disallowedTools` and the session driver unions it into the rules snapshot
    // that feeds both the SDK's `disallowedTools` and the local `canUseTool`
    // verdict. Absence from the coordinator's exact allowedTools is still true and
    // still helps, but it was a property of ONE SEAT being reported as a property
    // of the vendor — a worker gets no allow-list at all.
    hasNativeFanOut: true,
    fanOutSuppression: "enforced",
    // Reads only its OWN settings layers. The direction that matters for claude is
    // the reverse one: cursor executes the `.claude/settings.json` sitting beside
    // MUON's claude write, which is why `compileClaudeProfile` refuses a `hooks`
    // key in `rawConfig` rather than trusting that asymmetry.
    foreignHookSources: [],
    foreignHookContainment: "none",
    installedCandidates: ["claude"],
    connectKind: "account",
    envKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR"],
    ownedKeys: ["ANTHROPIC_API_KEY"],
    forwardToRunner: true,
    models: {
      known: ["fable", "opus", "sonnet", "haiku"],
      allowCustom: true,
      idShape: null,
    },
  },
  codex: {
    displayName: "Codex",
    shortLabel: "Codex",
    iconKey: "codex",
    provider: "openai",
    visibility: "public",
    cost: 0.8,
    supportedRoles: ALL_SEVEN_ROLES,
    coordinatorSeat: true,
    dispatchable: true,
    delegatable: true,
    fleetSizeable: true,
    evaluator: true,
    planner: true,
    terminalTakeover: true,
    sessionDriver: "codex-app-server",
    canSend: true,
    canInterrupt: true,
    canResume: false,
    persistsSessionHandle: false,
    modes: ["one-shot", "interactive", "background"],
    commandCandidates: ["codex"],
    hasRuntimeRequirement: false,
    compiler: "codex",
    strictMcpConfigFlag: false,
    // Flags that widen authority, defeat MUON's ambient-config guard, or send
    // the run off-machine. `--disable` is absent because it can only narrow.
    wideningFlags: [
      "--oss",
      "--local-provider",
      "--profile",
      "-p",
      "--enable",
      "--dangerously-bypass-approvals-and-sandbox",
      "--dangerously-bypass-hook-trust",
      "--remote",
      "--remote-auth-token-env",
      "--search",
    ],
    // `features.multi_agent`, on by DEFAULT, so silence would have left it live.
    // `declared` rather than `enforced`, against this repo's OWN measurement:
    // codex 0.145 reports `multiAgentMode: explicitRequestOnly` for every thread
    // with the suppression flags set and without them. MUON emits it; the vendor is
    // not observed honouring it (codex-capability-preflight.ts).
    hasNativeFanOut: true,
    fanOutSuppression: "declared",
    // Speaks claude's hook PROTOCOL (`PreToolUse`, `CLAUDE_PLUGIN_ROOT`) and reads
    // claude/cursor paths only inside its `external-agent-migration` command, which
    // MUON never runs. Its one hook layer is `$CODEX_HOME/hooks.json`, and MUON
    // already owns `CODEX_HOME`.
    foreignHookSources: [],
    foreignHookContainment: "none",
    installedCandidates: ["codex"],
    connectKind: "account",
    // `CODEX_HOME` is deliberately GONE. It is the vendor's config ROOT, not a
    // credential, and forwarding it handed every dispatched Codex child the
    // operator's entire `~/.codex` — measured as 7 MCP servers and 206 tools,
    // including a Node REPL and desktop control, none of it in MUON's grant.
    // It is now a lane-guard key MUON sets itself (adapters/lane-guard-env.ts).
    envKeys: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
    ownedKeys: ["OPENAI_API_KEY"],
    forwardToRunner: true,
    models: {
      known: [
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.4-mini",
      ],
      allowCustom: true,
      idShape: null,
    },
  },
  cursor: {
    displayName: "Cursor",
    shortLabel: "Cursor",
    iconKey: "cursor",
    provider: "cursor",
    visibility: "public",
    cost: 0.4,
    supportedRoles: ["reviewer", "qa", "architect", "scout"],
    coordinatorSeat: false,
    dispatchable: true,
    delegatable: true,
    fleetSizeable: true,
    evaluator: false,
    planner: false,
    terminalTakeover: true,
    sessionDriver: "none",
    canSend: false,
    canInterrupt: false,
    canResume: false,
    persistsSessionHandle: false,
    modes: ["one-shot", "background"],
    commandCandidates: ["cursor-agent", "agent"],
    hasRuntimeRequirement: false,
    compiler: "cursor",
    strictMcpConfigFlag: false,
    // Three groups, and the grouping is the point — only the first is the kind of
    // flag `--help` makes look dangerous:
    //  - blanket allows: `-f`/`--force`/`--yolo`/`--auto-review`/`--approve-mcps`.
    //  - relocate or extend the run rather than loosen a permission:
    //    `--plugin-dir` loads local code into the governed review, `-w`/
    //    `--worktree` moves the run out of the cwd whose `.cursor/cli.json`
    //    carries MUON's deny table (`--worktree-base` is listed so a stripped
    //    pair leaves no value behind).
    //  - HIDDEN (`.hideHelp()`), re-derived from the shipped bundle by TODO 1.16:
    //    `--disable-project-configs` is the literal undo of MUON's permission
    //    write; the endpoint/base-url family retargets the run at another server;
    //    `--auth-token`/`--api-key` put a credential on argv; `-H`/`--header`
    //    injects headers; `-k`/`--insecure`/`--http-version` weaken the transport.
    // Those last twelve were stripped by the guard but went UNDECLARED here until
    // TODO 2.6 synced the two, which is why this table is written out in full.
    //
    // `--trust` is NOT here, and that is TODO 2.6's answer rather than an
    // omission: an untrusted `--print` run REFUSES to start, so trust is a
    // precondition MUON must satisfy (it emits the flag itself) and not a grant
    // of tool authority. `--yolo`/`-f`, cursor's only other ways to satisfy it,
    // ARE widenings and are listed above.
    wideningFlags: [
      "-f",
      "--force",
      "--yolo",
      "--auto-review",
      "--approve-mcps",
      "--plugin-dir",
      "-w",
      "--worktree",
      "--worktree-base",
      "--disable-project-configs",
      "-e",
      "--endpoint",
      "--agent-endpoint",
      "--base-url",
      "--auth-token",
      "--api-key",
      "-H",
      "--header",
      "-k",
      "--insecure",
      "--http-version",
    ],
    // Native subagents, measured to arrive holding write and shell tools even
    // from a `--mode plan` parent. Suppressed by a `failClosed` `preToolUse` hook
    // matched on `Task` — NOT by a permission entry, which was measured to do
    // nothing in all three spellings.
    hasNativeFanOut: true,
    fanOutSuppression: "enforced",
    // THE replayer. Its hook loader takes seven sources and three are Claude
    // Code's; a repo-committed `.claude/settings.json` was measured EXECUTING its
    // `SessionStart` and `PreToolUse` commands under MUON's exact argv, `--mode
    // plan` included. `partial`, not `owned`: MUON writes both project paths, and
    // the user-global one cannot be reached by a run-scoped write.
    foreignHookSources: [
      ".claude/settings.json",
      ".claude/settings.local.json",
      "~/.claude/settings.json",
    ],
    foreignHookContainment: "partial",
    installedCandidates: ["agent", "cursor-agent", "cursor"],
    connectKind: "account",
    envKeys: ["CURSOR_API_KEY"],
    ownedKeys: ["CURSOR_API_KEY"],
    forwardToRunner: true,
    models: {
      known: [
        "auto",
        "gpt-5.6-sol-high",
        "claude-opus-5-thinking-high",
        "claude-fable-5-thinking-high",
        "kimi-k3-high",
        "cursor-grok-4.5-high",
        "composer-2.5",
      ],
      allowCustom: true,
      idShape: null,
    },
  },
  opencode: {
    displayName: "OpenCode",
    shortLabel: "OpenCode",
    iconKey: "opencode",
    provider: "opencode",
    visibility: "public",
    cost: 0.3,
    // ONE role. Written out rather than referenced so a widening has to be typed
    // here as well as in the registry — two independent statements, per ADR-0022
    // mechanism 5. A compile error catches an omitted field; only this catches a
    // wrong VALUE.
    supportedRoles: ["scout"],
    coordinatorSeat: false,
    dispatchable: true,
    delegatable: true,
    fleetSizeable: true,
    evaluator: false,
    planner: false,
    // Human-terminal UI capability only — dispatch stays scout-only above.
    terminalTakeover: true,
    sessionDriver: "none",
    canSend: false,
    canInterrupt: false,
    canResume: false,
    persistsSessionHandle: false,
    modes: ["one-shot", "background"],
    commandCandidates: ["opencode"],
    hasRuntimeRequirement: false,
    compiler: "opencode",
    strictMcpConfigFlag: false,
    // `--auto` widens permissions; `--share`/`--attach` leak the run
    // off-machine; `--agent` swaps the permission table MUON compiled; the rest
    // turn a one-shot into a network listener.
    wideningFlags: [
      "--auto",
      "--share",
      "--attach",
      "--agent",
      "--port",
      "--hostname",
      "--cors",
      "--mdns",
      "--mdns-domain",
    ],
    // The `task` permission token, denied BY NAME (a wildcard alone loses to
    // opencode's specificity-first resolution). `declared` for the same reason as
    // cursor: the table is written and resolves, enforcement is 1.11's gate.
    hasNativeFanOut: true,
    fanOutSuppression: "declared",
    // Reads foreign INSTRUCTIONS (`.claude/skills/`, `.cursor/rules/`) and no
    // foreign hook config. Its own executable layer is plugins, already dropped by
    // `--pure` since TODO 1.8.
    foreignHookSources: [],
    foreignHookContainment: "none",
    installedCandidates: ["opencode"],
    connectKind: "account",
    // Empty on BOTH counts, and both are statements. opencode is BYO-provider
    // and reads its own auth.json, so there is nothing to forward — and naming a
    // provider key here would hand one vendor's credential to another vendor's
    // binary (ADR-0022 G5).
    envKeys: [],
    ownedKeys: [],
    forwardToRunner: false,
    // TODO 3.4: a catalogue that is a SHAPE, not a list. `known` is empty
    // because opencode's live model set is whichever providers THIS operator
    // authed, which no committed list can track — but the ids are
    // `provider/model`, so the FORM is checkable and the per-dispatch override
    // is admitted on it. Empty `known` is therefore a statement here, exactly
    // like `envKeys` above, and NOT the same fact as `models: null`.
    models: {
      known: [],
      allowCustom: true,
      idShape: "provider-qualified",
    },
  },
  fake: {
    displayName: "Fake Vendor (dev/test)",
    shortLabel: "Fake",
    iconKey: "fake",
    provider: "muon-fake",
    visibility: "dev-test",
    cost: 0.5,
    supportedRoles: ALL_SEVEN_ROLES,
    coordinatorSeat: false,
    dispatchable: true,
    delegatable: true,
    fleetSizeable: true,
    evaluator: false,
    planner: false,
    terminalTakeover: false,
    sessionDriver: "none",
    canSend: false,
    canInterrupt: false,
    canResume: false,
    persistsSessionHandle: false,
    modes: ["one-shot", "background"],
    commandCandidates: ["muon-fake-vendor"],
    hasRuntimeRequirement: false,
    compiler: "passthrough",
    strictMcpConfigFlag: false,
    wideningFlags: [],
    // No child process is ever spawned, so there is nothing to fan out. Stated
    // rather than left blank: a future real vendor copying this row must not
    // inherit an exemption it has not earned.
    hasNativeFanOut: false,
    fanOutSuppression: "none",
    // No child process, so no hook file of anyone's is ever read. Stated for the
    // same reason as the row above it.
    foreignHookSources: [],
    foreignHookContainment: "none",
    installedCandidates: [],
    connectKind: "local-runtime",
    envKeys: [],
    ownedKeys: [],
    forwardToRunner: false,
    models: {
      known: ["fake-model-1", "fake-model-2"],
      allowCustom: false,
      idShape: null,
    },
  },
};

/** Hand-written, in registry order. Never `.filter(...)` over the registry. */
const EXPECTED_VENDOR_IDS: readonly string[] = [
  "claude-code",
  "codex",
  "cursor",
  "opencode",
  "fake",
];
const EXPECTED_PUBLIC: readonly string[] = [
  "claude-code",
  "codex",
  "cursor",
  "opencode",
];
const EXPECTED_FLEET: readonly string[] = [
  "claude-code",
  "codex",
  "cursor",
  "opencode",
];
const EXPECTED_DISPATCHABLE: readonly string[] = [
  "claude-code",
  "codex",
  "cursor",
  "opencode",
  "fake",
];
const EXPECTED_DELEGATABLE: readonly string[] = [
  "claude-code",
  "codex",
  "cursor",
  "opencode",
  "fake",
];
const EXPECTED_COORDINATOR: readonly string[] = ["claude-code", "codex"];
const EXPECTED_EVALUATOR: readonly string[] = ["claude-code", "codex"];
const EXPECTED_PLANNER: readonly string[] = ["claude-code", "codex"];
const EXPECTED_TERMINAL_TAKEOVER: readonly string[] = [
  "claude-code",
  "codex",
  "cursor",
  // Human-terminal UI capability only (no dispatch authority): granted once
  // Wave F removed `opencode` from the desktop attach-label table, closing
  // the ADR-0022 §8 keyspace-merge hazard the old `false` guarded against.
  "opencode",
];

/** Ids that are NOT vendors. Every one must fail closed on every accessor. */
const NON_VENDOR_IDS = [
  "ollama",
  "kiro",
  "kimi",
  "copilot",
  "gemini",
  "amp",
  "vibe",
  "claude",
  "Claude-Code",
  "",
];

describe("vendor registry — shape", () => {
  it("has exactly the expected ids, in order", () => {
    expect([...VENDOR_IDS]).toEqual([...EXPECTED_VENDOR_IDS]);
  });

  it("has an entry for every id and no extra keys", () => {
    expect(Object.keys(VENDOR_REGISTRY).sort()).toEqual(
      [...EXPECTED_VENDOR_IDS].sort()
    );
  });

  it("keys its entries by their own id", () => {
    for (const id of VENDOR_IDS) {
      expect(VENDOR_REGISTRY[id].id).toBe(id);
      expect(vendorEntry(id)).toBe(VENDOR_REGISTRY[id]);
    }
  });

  it("accepts every id and rejects every non-id through the schema", () => {
    for (const id of EXPECTED_VENDOR_IDS) {
      expect(vendorIdSchema.parse(id)).toBe(id);
      expect(isVendorId(id)).toBe(true);
    }
    for (const other of NON_VENDOR_IDS) {
      expect(vendorIdSchema.safeParse(other).success).toBe(false);
      expect(isVendorId(other)).toBe(false);
    }
    expect(isVendorId(undefined)).toBe(false);
    expect(isVendorId(null)).toBe(false);
    expect(isVendorId(42)).toBe(false);
  });
});

describe("vendor registry — posture matches the independent expectation table", () => {
  for (const id of Object.keys(EXPECTED) as VendorId[]) {
    const want = EXPECTED[id];

    it(`${id}: identity`, () => {
      const entry = VENDOR_REGISTRY[id];
      expect(entry.displayName).toBe(want.displayName);
      expect(entry.shortLabel).toBe(want.shortLabel);
      expect(entry.iconKey).toBe(want.iconKey);
      expect(entry.provider).toBe(want.provider);
      expect(entry.visibility).toBe(want.visibility);
      expect(entry.cost).toBe(want.cost);
    });

    it(`${id}: authority`, () => {
      const authority = VENDOR_REGISTRY[id].authority;
      expect([...authority.supportedRoles]).toEqual([...want.supportedRoles]);
      expect(authority.coordinatorSeat).toBe(want.coordinatorSeat);
      expect(authority.dispatchable).toBe(want.dispatchable);
      expect(authority.delegatable).toBe(want.delegatable);
      expect(authority.fleetSizeable).toBe(want.fleetSizeable);
      expect(authority.evaluator).toBe(want.evaluator);
      expect(authority.planner).toBe(want.planner);
      expect(authority.terminalTakeover).toBe(want.terminalTakeover);
    });

    it(`${id}: session`, () => {
      const session = VENDOR_REGISTRY[id].session;
      expect(session.driver).toBe(want.sessionDriver);
      expect(session.canSend).toBe(want.canSend);
      expect(session.canInterrupt).toBe(want.canInterrupt);
      expect(session.canResume).toBe(want.canResume);
      expect(session.persistsSessionHandle).toBe(want.persistsSessionHandle);
    });

    it(`${id}: execution`, () => {
      const execution = VENDOR_REGISTRY[id].execution;
      expect([...execution.modes]).toEqual([...want.modes]);
      expect([...execution.commandCandidates]).toEqual([
        ...want.commandCandidates,
      ]);
      expect(execution.runtimeRequirement !== null).toBe(
        want.hasRuntimeRequirement
      );
      expect(execution.compiler).toBe(want.compiler);
      expect(execution.guards.strictMcpConfigFlag).toBe(
        want.strictMcpConfigFlag
      );
      expect([...execution.guards.wideningFlags]).toEqual([
        ...want.wideningFlags,
      ]);
      const fanOut = execution.guards.nativeFanOut;
      expect(fanOut.mechanism !== null).toBe(want.hasNativeFanOut);
      expect(fanOut.suppression.state).toBe(want.fanOutSuppression);
      const replay = execution.guards.foreignHookReplay;
      expect([...replay.sources]).toEqual([...want.foreignHookSources]);
      expect(replay.containment.state).toBe(want.foreignHookContainment);
    });

    it(`${id}: readiness and credentials`, () => {
      const entry = VENDOR_REGISTRY[id];
      expect([...entry.readiness.installedCandidates]).toEqual([
        ...want.installedCandidates,
      ]);
      expect(entry.readiness.connectKind).toBe(want.connectKind);
      expect([...entry.credentials.envKeys]).toEqual([...want.envKeys]);
      expect([...entry.credentials.ownedKeys]).toEqual([...want.ownedKeys]);
      expect(entry.credentials.forwardToRunner).toBe(want.forwardToRunner);
    });

    it(`${id}: models`, () => {
      const models = VENDOR_REGISTRY[id].models;
      if (want.models === null) {
        expect(models).toBeNull();
        return;
      }
      expect(models).not.toBeNull();
      expect([...models!.known]).toEqual([...want.models.known]);
      expect(models!.allowCustom).toBe(want.models.allowCustom);
      expect(models!.idShape).toBe(want.models.idShape);
      // TODO 3.4: the two halves of a policy must not contradict each other. An
      // EMPTY `known` is only honest when something else does the verifying, so
      // it REQUIRES a declared shape — otherwise the lane would advertise a
      // catalogue that admits every non-guarded string, which is what `null`
      // already says and says more clearly.
      if (models!.known.length === 0) {
        expect(
          models!.idShape,
          `${id} has an empty catalogue and no declared shape: it verifies nothing but does not say so`
        ).not.toBeNull();
      }
    });
  }
});

describe("vendor registry — derived sets are positive predicates", () => {
  it("publicVendorIds excludes the dev/test seam", () => {
    expect([...publicVendorIds()]).toEqual([...EXPECTED_PUBLIC]);
  });

  it("fleetVendorIds is the sizeable public set", () => {
    expect([...fleetVendorIds()]).toEqual([...EXPECTED_FLEET]);
  });

  it("dispatchableVendorIds", () => {
    expect([...dispatchableVendorIds()]).toEqual([...EXPECTED_DISPATCHABLE]);
  });

  it("delegatableVendorIds", () => {
    expect([...delegatableVendorIds()]).toEqual([...EXPECTED_DELEGATABLE]);
  });

  it("coordinatorVendorIds", () => {
    expect([...coordinatorVendorIds()]).toEqual([...EXPECTED_COORDINATOR]);
  });

  it("evaluatorVendorIds", () => {
    expect([...evaluatorVendorIds()]).toEqual([...EXPECTED_EVALUATOR]);
  });

  it("plannerVendorIds", () => {
    expect([...plannerVendorIds()]).toEqual([...EXPECTED_PLANNER]);
  });

  it("terminalTakeoverVendorIds", () => {
    expect([...terminalTakeoverVendorIds()]).toEqual([
      ...EXPECTED_TERMINAL_TAKEOVER,
    ]);
  });

  it("vendorsWhere admits nothing under a false predicate", () => {
    // The shape of every derived set. If a predicate says no, the set is empty
    // — there is no superset that leaks members in by subtraction.
    expect(vendorsWhere(() => false)).toEqual([]);
    expect([...vendorsWhere(() => true)]).toEqual([...EXPECTED_VENDOR_IDS]);
  });

  it("every derived set preserves registry order", () => {
    const order = (ids: readonly string[]) =>
      ids.map((id) => EXPECTED_VENDOR_IDS.indexOf(id));
    for (const set of [
      publicVendorIds(),
      fleetVendorIds(),
      dispatchableVendorIds(),
      delegatableVendorIds(),
      coordinatorVendorIds(),
      evaluatorVendorIds(),
      plannerVendorIds(),
      terminalTakeoverVendorIds(),
    ]) {
      const positions = order(set);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      expect(positions).not.toContain(-1);
    }
  });
});

describe("vendor registry — accessors fail closed", () => {
  it("vendorRoleCeiling returns [] for anything that is not a vendor", () => {
    // `[]` REFUSES every role. `undefined` would ADMIT every role on three of
    // the four surfaces that read a ceiling today — that is the bug this
    // accessor exists to remove, so the empty array is load-bearing.
    for (const other of NON_VENDOR_IDS) {
      expect(vendorRoleCeiling(other)).toEqual([]);
    }
  });

  it("sessionCapability returns an all-false posture for a non-vendor", () => {
    for (const other of NON_VENDOR_IDS) {
      expect(sessionCapability(other)).toEqual({
        driver: "none",
        canSend: false,
        canInterrupt: false,
        canResume: false,
        persistsSessionHandle: false,
      });
    }
  });

  it("a registered vendor still gets its real posture", () => {
    expect(vendorRoleCeiling("cursor")).toEqual([
      "reviewer",
      "qa",
      "architect",
      "scout",
    ]);
    expect(sessionCapability("codex").canSend).toBe(true);
    expect(sessionCapability("cursor").canSend).toBe(false);
  });
});

describe("vendor registry — structural invariants", () => {
  it("every supportedRoles entry is a real role, with no duplicates", () => {
    for (const id of VENDOR_IDS) {
      const roles = VENDOR_REGISTRY[id].authority.supportedRoles;
      expect(new Set(roles).size).toBe(roles.length);
      for (const role of roles) {
        expect(AGENT_ROLES).toContain(role);
      }
    }
  });

  it("roleAffinity only ranks roles the vendor may actually hold", () => {
    // Affinity RANKS among authorized lanes; it can never grant. An affinity
    // for a role outside the ceiling would be a number nothing may ever use.
    for (const id of VENDOR_IDS) {
      const entry = VENDOR_REGISTRY[id];
      const ceiling = new Set<string>(entry.authority.supportedRoles);
      for (const [role, value] of Object.entries(entry.roleAffinity)) {
        expect(AGENT_ROLES).toContain(role as AgentRole);
        expect(ceiling.has(role)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it("cost is a 0..1 ranking term", () => {
    for (const id of VENDOR_IDS) {
      expect(VENDOR_REGISTRY[id].cost).toBeGreaterThanOrEqual(0);
      expect(VENDOR_REGISTRY[id].cost).toBeLessThanOrEqual(1);
    }
  });

  it("a vendor with no session driver declares no session capability", () => {
    for (const id of VENDOR_IDS) {
      const session = VENDOR_REGISTRY[id].session;
      if (session.driver !== "none") {
        continue;
      }
      expect(session.canSend).toBe(false);
      expect(session.canInterrupt).toBe(false);
      expect(session.canResume).toBe(false);
      expect(session.persistsSessionHandle).toBe(false);
    }
  });

  it("TODO 1.4: canInterrupt requires a driver MUON can send an interrupt ON", () => {
    // The test directly above already forces every session boolean false when the
    // driver is `"none"`, and that happens to give 1.4 the right answer for the
    // five vendors here. It is the wrong RULE to rely on: it keys on the ABSENCE
    // of a driver, so a future kind for a session MUON only watches — an attached
    // pty, a log tail — is not `"none"`, skips that loop entirely, and may then
    // claim `canInterrupt: true` while the only way to stop the work is a human
    // pressing Ctrl-C. `ROLE_SPECS.orchestrator` would seat a coordinator on it
    // and `vendorRoutingLines()` would advertise "watch + interrupt" to an agent
    // that has neither. So the rule is stated the other way round: interrupt
    // authority is granted per driver kind, and an unlisted kind is refused.
    for (const id of VENDOR_IDS) {
      const session = VENDOR_REGISTRY[id].session;
      if (!session.canInterrupt) {
        continue;
      }
      expect(
        SESSION_DRIVERS_THAT_CAN_INTERRUPT,
        `${id} claims canInterrupt on driver "${session.driver}", which has no interrupt channel — a human's Ctrl-C is not MUON's lever`
      ).toContain(session.driver);
    }
  });

  it("TODO 1.4: the interrupt allow-list is not vacuous, and not everything", () => {
    // Two ways the invariant above could pass while meaning nothing: an empty
    // allow-list (no vendor claims interrupt, so the loop never runs) or one
    // holding every driver kind (nothing is ever refused). Pin both ends. The
    // second assertion is the load-bearing one — `"none"` must stay OUT, because
    // that is the kind every non-driven lane already carries.
    expect(
      VENDOR_IDS.filter((id) => VENDOR_REGISTRY[id].session.canInterrupt).length
    ).toBeGreaterThan(0);
    expect(SESSION_DRIVERS_THAT_CAN_INTERRUPT).not.toContain("none");
  });

  it("TODO 1.5: a lane that cannot PRE-SET least-privilege holds no write role", () => {
    // ADR-0007's open question, closed as data. ACP standardizes the permission
    // REQUEST and nothing upstream of it — there is nowhere in `initialize` or
    // `session/new` to state a sandbox, an approval policy, or a tool allow/deny
    // list, which is the whole vocabulary `profile-compiler` bounds a lane with.
    // A preset denial means the action is never attempted; a request-time gate
    // fires only if the agent chooses to ask. So write authority requires the
    // preset half, and `vendorRoleCeiling` subtracts it rather than trusting the
    // declaration. Vacuously true over the registry today (no vendor is `acp`),
    // so the direct table check below is what actually holds the rule.
    for (const id of VENDOR_IDS) {
      if (vendorMayHoldWriteAuthority(id)) {
        continue;
      }
      expect(
        vendorRoleCeiling(id).filter(
          (role) => ROLE_SPECS[role].authority === "write"
        ),
        `${id} cannot pre-set ${vendorUnenforceableControls(id).join("/")} yet reaches a write role`
      ).toEqual([]);
    }
  });

  it("TODO 1.5: acp is the kind with the delta, and the delta is the four controls", () => {
    // Written as a literal rather than derived: this is the second independent
    // statement of ADR-0007's finding, and a derivation would agree with the
    // registry by construction. `[]` on the other three kinds is a CLAIM — the
    // bespoke drivers and the one-shot compiler path both apply all four before
    // the child exists.
    expect(SESSION_DRIVER_UNENFORCEABLE_CONTROLS).toEqual({
      "claude-sdk": [],
      "codex-app-server": [],
      acp: ["sandbox", "permissionMode", "allowedTools", "deniedTools"],
      none: [],
    });
  });

  it("TODO 2.2: cursor holds no write-authority role until a governed coder profile exists", () => {
    // The decision is "not yet", not "never". The mechanism that used to make
    // "never" look inevitable (no file-write gate) is gone — see the registry
    // comment on cursor.authority.supportedRoles. What this pins is the
    // CURRENT ceiling: every write role stays off until someone ships the
    // deliberate `--force` + write/shell-hook profile and edits BOTH this
    // expectation and the registry in the same change.
    const roles = VENDOR_REGISTRY.cursor.authority.supportedRoles;
    expect(roles).not.toContain("implementer");
    expect(
      roles.filter((role) => ROLE_SPECS[role].authority === "write")
    ).toEqual([]);
    expect(vendorRoleCeiling("cursor")).not.toContain("implementer");
  });

  it("TODO 1.5: the ceiling would actually narrow an acp lane — proven, not assumed", () => {
    // The loop above is vacuous today and will stay vacuous until someone ships
    // an ACP vendor, which is exactly when the rule needs to already work. So
    // exercise the subtraction directly on the pure function: give it the roles a
    // hopeful registry row might declare and confirm only the read-only ones
    // survive. `implementer` is the one ADR-0007 named.
    const declared = [...ALL_SEVEN_ROLES];
    const survivors = declared.filter(
      (role) => ROLE_SPECS[role].authority !== "write"
    );
    expect(survivors).not.toContain("implementer");
    expect(survivors).toContain("reviewer");
    expect(survivors.length).toBeLessThan(declared.length);
    // And read-only roles are deliberately UNAFFECTED: a reviewer that cannot be
    // pre-sandboxed is still a reviewer, because `allowsWriteTools: false` and
    // the driver's default-deny bridge hold with no preset at all.
    expect(SESSION_DRIVER_UNENFORCEABLE_CONTROLS.acp.length).toBeGreaterThan(0);
  });

  it("interactive is offered only where a session driver exists", () => {
    for (const id of VENDOR_IDS) {
      const entry = VENDOR_REGISTRY[id];
      if (entry.execution.modes.includes("interactive")) {
        expect(entry.session.driver).not.toBe("none");
      }
    }
  });

  it("ADR-0007: the moat set is exactly the tier1 vendors, and a tier1 lane never declares ACP", () => {
    // One spec assertion of WHAT the moat is (here), and one derivation of the
    // REFUSAL from it (`ACP_TIER1_REFUSED` reads `authority.tier1`). The driver
    // no longer restates the literal, so adding a fourth moat vendor is
    // protected by its own `tier1: true` — this test would then require it to
    // be in the moat set, and the driver would refuse it, with no edit to
    // either list.
    const tier1 = VENDOR_IDS.filter((id) => VENDOR_REGISTRY[id].authority.tier1);
    expect([...tier1].sort()).toEqual(["claude-code", "codex", "cursor"]);
    for (const id of tier1) {
      expect(VENDOR_REGISTRY[id].session.driver).not.toBe("acp");
    }
  });

  it("ADR-0007: an ACP lane carries its launch data; a non-ACP lane carries none", () => {
    for (const id of VENDOR_IDS) {
      const session = VENDOR_REGISTRY[id].session;
      if (session.driver === "acp") {
        // Launch data present, and the command is one MUON may spawn.
        expect(session.acp?.command).toBeTruthy();
        expect(
          VENDOR_REGISTRY[id].execution.commandCandidates
        ).toContain(session.acp?.command);
      } else {
        // No dormant launch data on a non-ACP lane — the field means one thing.
        expect(session.acp).toBeUndefined();
      }
    }
  });

  it("only an owned credential key may be a vendor env key", () => {
    // BYO-auth blast radius (ADR-0022 G5): a key a vendor OWNS must be one it
    // is also allowed to receive, or the launcher would resolve a credential
    // the per-lane filter then refuses to deliver.
    for (const id of VENDOR_IDS) {
      const { envKeys, ownedKeys } = VENDOR_REGISTRY[id].credentials;
      for (const key of ownedKeys) {
        expect(envKeys).toContain(key);
      }
    }
  });

  it("no credential key is claimed by two vendors", () => {
    // The whole point of the per-lane env filter: ANTHROPIC_API_KEY must never
    // be resolvable for a third-party binary.
    const seen = new Map<string, VendorId>();
    for (const id of VENDOR_IDS) {
      for (const key of VENDOR_REGISTRY[id].credentials.envKeys) {
        expect(seen.has(key)).toBe(false);
        seen.set(key, id);
      }
    }
  });

  it("only a vendor with credentials to forward sets forwardToRunner", () => {
    for (const id of VENDOR_IDS) {
      const credentials = VENDOR_REGISTRY[id].credentials;
      if (credentials.forwardToRunner) {
        expect(credentials.ownedKeys.length).toBeGreaterThan(0);
      }
    }
  });

  it("cursor keeps two distinct binary lists (ADR-0022 §6.7)", () => {
    // The bare `cursor` IDE launcher counts as INSTALLED but must never be
    // spawned for a dispatch. Collapsing these two fields would make it
    // spawnable, which is why they are modelled separately.
    const cursor = VENDOR_REGISTRY.cursor;
    expect(cursor.readiness.installedCandidates).toContain("cursor");
    expect(cursor.execution.commandCandidates).not.toContain("cursor");
  });

  it("no vendor declares a second-binary runtime requirement", () => {
    // The Ollama lane was the only one that ever did (it spawned `codex` for a
    // `--oss` run) and it has been removed. Every surviving vendor spawns its
    // OWN binary, so `commandCandidates` is self-contained everywhere. The field
    // stays modelled — asserting `null` for all five is what makes a future
    // through-another-runtime lane declare itself rather than arrive silently.
    for (const id of VENDOR_IDS) {
      expect(VENDOR_REGISTRY[id].execution.runtimeRequirement).toBeNull();
    }
  });

  it("exactly one vendor is the dev/test seam", () => {
    const devTest = VENDOR_IDS.filter(
      (id) => VENDOR_REGISTRY[id].visibility === "dev-test"
    );
    expect([...devTest]).toEqual(["fake"]);
    // The seam is TWO conditions. The registry supplies visibility; the live
    // `MUON_FAKE_VENDOR` read stays in `fakeVendorEnabled()` and is deliberately
    // NOT mirrored here — a module-load evaluation would freeze it.
    expect(VENDOR_REGISTRY.fake.authority.coordinatorSeat).toBe(false);
  });

  it("TODO 1.16: a vendor that CAN fan out natively never declares zero suppression", () => {
    // The one combination that must be unreachable. `mechanism` names a way to
    // spawn a child outside MUON's job lineage, budget, worktree, and token
    // gates — and for cursor and claude that child inherits the parent's MCP
    // tools, MUON's own governed brain included. So a named mechanism with
    // `state: "none"` would be an audit that recorded the hole and shipped it.
    // The reverse pairing is legal and deliberate: no mechanism, no suppression.
    for (const id of VENDOR_IDS) {
      const fanOut = VENDOR_REGISTRY[id].execution.guards.nativeFanOut;
      if (fanOut.mechanism === null) {
        expect(fanOut.suppression.state).toBe("none");
        continue;
      }
      expect(fanOut.mechanism.trim().length).toBeGreaterThan(0);
      expect(fanOut.suppression.state).not.toBe("none");
      // A suppression that cannot say HOW is not reviewable, and this field is
      // the only place a human reads the answer.
      expect(fanOut.suppression.detail.trim().length).toBeGreaterThan(20);
    }
  });

  it("TODO 1.15: a vendor that replays a foreign hook file never declares zero containment", () => {
    // The same unreachable-combination rule as fan-out, for the same reason: a
    // named foreign source with `state: "none"` would be an audit that FOUND
    // arbitrary command execution reaching a governed run and shipped it anyway.
    // `owned` additionally has to mean it — every listed source must be one a
    // run-scoped write can actually reach, so a user-global path in an `owned` row
    // is a contradiction rather than a rounding error.
    for (const id of VENDOR_IDS) {
      const replay = VENDOR_REGISTRY[id].execution.guards.foreignHookReplay;
      if (replay.sources.length === 0) {
        expect(replay.containment.state).toBe("none");
        continue;
      }
      expect(replay.containment.state).not.toBe("none");
      for (const source of replay.sources) {
        expect(source.trim().length).toBeGreaterThan(0);
        // Relative to the run cwd, or explicitly user-global. An absolute path
        // that is neither would be a claim MUON's run-scoped write cannot honour.
        expect(
          source.startsWith("~/") || !source.startsWith("/"),
          `${id} declares an unreachable-by-construction source: ${source}`
        ).toBe(true);
      }
      if (replay.containment.state === "owned") {
        expect(
          replay.sources.filter((source) => source.startsWith("~/")),
          `${id} claims 'owned' while listing a user-global source`
        ).toEqual([]);
      }
      // A containment claim that cannot say WHAT it covers is not reviewable, and
      // for `partial` it is the only place the residue is written down at all.
      expect(replay.containment.detail.trim().length).toBeGreaterThan(20);
    }
  });

  it("the coordinator seat is a strict subset of the role ceiling", () => {
    // Seating a coordinator needs BOTH the seat boolean and `orchestrator` in
    // the ceiling. A vendor with the seat but not the role would be a seat
    // nothing can occupy; a vendor with neither is simply not a coordinator.
    for (const id of coordinatorVendorIds()) {
      expect(VENDOR_REGISTRY[id].authority.supportedRoles).toContain(
        "orchestrator"
      );
    }
  });
});

describe("coordinator preference — a preference is never a grant (ADR-0022 §4)", () => {
  it("intersects with the seated set; a preference naming an ineligible vendor grants nothing", () => {
    // THE trap this design exists to avoid. If the list were UNIONED into the
    // coordinator set, naming a vendor in a settings file would hand it the
    // super-orchestrator seat — an operator preference silently becoming an
    // authority grant.
    const ineligible = VENDOR_IDS.filter(
      (id) => !VENDOR_REGISTRY[id].authority.coordinatorSeat
    );
    expect(ineligible.length).toBeGreaterThan(0);
    const preferred = coordinatorPreference(ineligible);
    for (const id of ineligible) {
      expect(preferred).not.toContain(id);
    }
    // …and what survives is exactly the seated set, in registry order, because
    // nothing the operator named was rankable.
    expect([...preferred]).toEqual([...coordinatorVendorIds()]);
  });

  it("reorders the seated set and keeps unranked seats at the tail", () => {
    const seats = coordinatorVendorIds();
    const last = seats[seats.length - 1]!;
    const preferred = coordinatorPreference([last]);
    expect(preferred[0]).toBe(last);
    expect([...preferred].sort()).toEqual([...seats].sort());
  });

  it("ignores an id MUON has never heard of, and dedupes", () => {
    expect([...coordinatorPreference(["kiro", "kiro"])]).toEqual([
      ...coordinatorVendorIds(),
    ]);
    const seats = coordinatorVendorIds();
    expect([...coordinatorPreference([seats[0]!, seats[0]!])]).toEqual([
      ...seats,
    ]);
  });

  it("the default preference names only seated vendors", () => {
    for (const id of DEFAULT_COORDINATOR_PREFERENCE) {
      expect(VENDOR_REGISTRY[id].authority.coordinatorSeat).toBe(true);
    }
  });

  it("defaultCoordinatorVendor() is the head of the preference and holds the seat", () => {
    const first = defaultCoordinatorVendor();
    expect(first).toBe(coordinatorPreference()[0]);
    expect(VENDOR_REGISTRY[first].authority.coordinatorSeat).toBe(true);
    // The invariant that keeps `defaultCoordinatorVendor()` total. If this ever
    // fails, the throw it guards is the correct behaviour — seating an
    // unauthorized vendor is not.
    expect(coordinatorVendorIds().length).toBeGreaterThan(0);
  });
});

describe("routing prose is generated, and names no vendor as a default (ADR-0022 §5 Wave E)", () => {
  it("renders one line per public vendor, and nothing for the dev/test seam", () => {
    expect(vendorRoutingLines()).toHaveLength(publicVendorIds().length);
    for (const line of vendorRoutingLines()) {
      expect(line).not.toContain("fake");
    }
  });

  it("states each vendor's real ceiling, write posture, and steerability", () => {
    for (const id of publicVendorIds()) {
      const entry = VENDOR_REGISTRY[id];
      const line = vendorRoutingLines().find((candidate) =>
        candidate.startsWith(`${id} `)
      );
      expect(line).toBeDefined();
      for (const role of entry.authority.supportedRoles) {
        expect(line).toContain(role);
      }
      const writes = entry.authority.supportedRoles.some(
        (role) => ROLE_SPECS[role].authority !== "read-only"
      );
      expect(line).toContain(writes ? "may write" : "READ-ONLY");
      if (entry.session.canSend) {
        expect(line).toContain("steerable mid-run");
      } else {
        expect(line).not.toContain("steerable mid-run");
      }
    }
  });

  it("the policy sentence names NO vendor — the §1.2(i) bias is gone", () => {
    // The prose it replaced said "implementation/repair loops → claude-code …
    // cheap one-shot triage → cursor", which was both biased and contradicted by
    // the role ceiling (cursor cannot hold a write role at all).
    for (const id of VENDOR_IDS) {
      expect(VENDOR_ROUTING_POLICY).not.toContain(id);
      expect(VENDOR_ROUTING_POLICY).not.toContain(
        VENDOR_REGISTRY[id].shortLabel
      );
    }
  });

  it("a vendor that cannot write is never described as able to", () => {
    for (const id of publicVendorIds()) {
      const entry = VENDOR_REGISTRY[id];
      const writes = entry.authority.supportedRoles.some(
        (role) => ROLE_SPECS[role].authority !== "read-only"
      );
      if (writes) continue;
      const line = vendorRoutingLines().find((candidate) =>
        candidate.startsWith(`${id} `)
      )!;
      expect(line).not.toContain("implementer");
      expect(line).toContain("READ-ONLY");
    }
  });
});
