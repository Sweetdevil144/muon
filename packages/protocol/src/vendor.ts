import { z } from "zod";
import { ROLE_SPECS, type AgentRole } from "./agent-role.js";

/**
 * THE vendor registry (ADR-0022). One vendor id enum, one entry per vendor, and
 * every other vendor set in the repo becomes a derived, positively-predicated
 * projection of this table.
 *
 * Three rules make that hold, and they are the whole point of the module:
 *
 * 1. IDENTITY IS DATA; AUTHORITY IS OPT-IN AND STATED POSITIVELY. A
 *    `VendorEntry` carries no defaults. Every field under `authority`,
 *    `session`, `execution.guards` and `credentials` is REQUIRED with no `?`,
 *    so a new entry does not compile until its author has typed `false` (or
 *    `[]`) for each one. Registering a vendor grants nothing; it only makes the
 *    vendor NAMEABLE. "A new vendor defaults to no authority" is therefore a
 *    compile-time property rather than a convention someone has to remember.
 *
 * 2. NEVER DERIVE AN ALLOWED SET BY SUBTRACTION. Every derived set below is
 *    `VENDOR_IDS.filter((id) => VENDOR_REGISTRY[id].authority.X === true)`.
 *    `ALLOWED = SUPERSET − FORBIDDEN` has broken this codebase three times: a
 *    new member of the superset silently lands on the permitted side. There is
 *    exactly one documented exemption in the tree (`COMMON_LANE_ENV_KEYS` in
 *    `packages/adapters/src/lane-runner.ts`, where the superset is itself a
 *    closed allowlist and the subtraction NARROWS), and it is not here.
 *
 * 3. DRIFT IS A COMPILE ERROR. `VENDOR_REGISTRY` is typed
 *    `{ readonly [K in VendorId]: VendorEntry }`, so a missing key AND an extra
 *    key both fail `tsc`.
 *
 * PURITY: this module is data + `zod` only. No `node:` imports, no behaviour.
 * The adapter classes, session drivers, profile compilers and auth interpreters
 * stay in `@muon/adapters`; the registry NAMES them, it never encodes them (see
 * ADR-0022 §6 for the eight places per-vendor divergence is correct).
 *
 * WAVE A: nothing reads this table for behaviour yet. It is drift-locked
 * against every existing copy by `backend/tests/vendor-registry-drift.test.ts`
 * and independently pinned by `packages/protocol/tests/vendor-registry.test.ts`.
 */

/**
 * Every vendor MUON can name. Order is the canonical presentation order and is
 * load-bearing for the derived sets below (a projection preserves it).
 *
 * `fake` is listed because `Record<VendorId, …>` must cover it; it is fenced off
 * from production by `visibility: "dev-test"` PLUS the live `MUON_FAKE_VENDOR`
 * env read in `fakeVendorEnabled()`. That env read deliberately stays where it
 * is: folding it in here would freeze the seam at module load.
 */
export const VENDOR_IDS = [
  "claude-code",
  "codex",
  "cursor",
  "opencode",
  "fake",
] as const;

export type VendorId = (typeof VENDOR_IDS)[number];

export const vendorIdSchema = z.enum(VENDOR_IDS);

/** Narrowing predicate. An id MUON has never heard of is not a vendor. */
export function isVendorId(value: unknown): value is VendorId {
  return (
    typeof value === "string" && (VENDOR_IDS as readonly string[]).includes(value)
  );
}

/** How MUON drives a live vendor session, if it can drive one at all.
 *
 * `"acp"` (ADR-0007, TODO 1.2): the vendor speaks the Agent Client Protocol
 * over stdio and is served by the ONE shared `AcpSessionDriver` — declared
 * here as data (plus `session.acp.{command,args}`), never as a bespoke
 * driver name. Tier-1 lanes (claude-code / codex / cursor) may never declare
 * it; the driver's constructor refuses them and the registry test pins it. */
export type VendorSessionDriverKind =
  | "claude-sdk"
  | "codex-app-server"
  | "acp"
  | "none";

/**
 * TODO 1.4, as an invariant rather than a review habit: the driver kinds through
 * which MUON can actually deliver an interrupt.
 *
 * There was already a structural rule that a `driver: "none"` vendor holds every
 * session boolean `false`, and it happens to give 1.4 the right answer today. It
 * would not KEEP giving it: the rule keys on the absence of a driver, so the
 * moment someone adds a kind for a session MUON merely watches — `"attached"`,
 * `"human-terminal"`, a pty tail — that vendor is no longer `"none"` and the
 * all-false rule stops applying, leaving `canInterrupt: true` reachable for a
 * lane whose only stop is a person pressing Ctrl-C. That is exactly the default
 * 1.4 says not to let happen, so the allow-list is stated POSITIVELY: a new
 * driver kind is non-interrupting until someone adds it here and says why.
 *
 * Each entry names a real channel. `claude-sdk` and `codex-app-server` are
 * bespoke drivers with an abort path; `acp` earns it through `session/cancel`
 * (TODO 1.3), which settles the turn and reports exit 130.
 */
export const SESSION_DRIVERS_THAT_CAN_INTERRUPT: readonly VendorSessionDriverKind[] =
  ["claude-sdk", "codex-app-server", "acp"];

/**
 * The `LaneProfile` fields that are LEAST-PRIVILEGE controls — the ones whose
 * whole job is to hand the agent less than it could otherwise take.
 *
 * Deliberately not every profile field. `model`, `addDirs`, `contextFiles` and
 * `extraArgs` shape a run without bounding it, and folding them in would let a
 * lane that merely cannot pin a model read as a lane that cannot be constrained.
 */
export type LeastPrivilegeControl =
  | "sandbox"
  | "permissionMode"
  | "allowedTools"
  | "deniedTools";

/**
 * TODO 1.5 — ACP's least-privilege delta, as DATA rather than an ADR paragraph.
 *
 * ACP standardizes the permission REQUEST (`session/request_permission`) and
 * nothing upstream of it. There is no place in `initialize` or `session/new` to
 * state a sandbox mode, an approval policy, or a tool allow/deny list — which is
 * the entire vocabulary `profile-compiler` uses to bound a lane BEFORE the agent
 * starts. So an ACP lane's least-privilege is REACTIVE where a compiled lane's is
 * PRESET, and the difference is not a nuance: a preset denial means the action is
 * never attempted, while a request-time gate fires only if the agent chooses to
 * ask. MUON's own guardrails (single-allow, default-deny, no advertised fs or
 * terminal capability) make the reactive half as strong as it can be; they cannot
 * manufacture the preset half.
 *
 * Keyed by DRIVER KIND, not by vendor: the delta is a property of the channel, so
 * a vendor inherits it by declaring `session.driver: "acp"` rather than by
 * remembering to copy a list into its own row.
 *
 * `[]` for the other kinds is a claim, not a blank: the bespoke drivers and the
 * one-shot compiler path both apply all four before the child exists.
 */
export const SESSION_DRIVER_UNENFORCEABLE_CONTROLS: Record<
  VendorSessionDriverKind,
  readonly LeastPrivilegeControl[]
> = {
  "claude-sdk": [],
  "codex-app-server": [],
  acp: ["sandbox", "permissionMode", "allowedTools", "deniedTools"],
  none: [],
};

/** Which per-vendor compiler turns a `LaneProfile` into argv/config. */
export type VendorCompilerKind =
  | "claude"
  | "codex"
  | "opencode"
  | "cursor"
  | "passthrough";

/** Where an execution can be reached from. Mirrors `PreflightExecutionMode`. */
export type VendorExecutionMode = "one-shot" | "interactive" | "background";

/** How a human CONNECTS a lane. Copy-only; it grants and withholds nothing. */
export type VendorConnectKind = "account" | "local-runtime";

/**
 * A NAMED model-id form (`models.idShape`), never a regex.
 *
 * The registry is data an operator reads and a drift-lock scans, so a pattern
 * living here would be an unreviewable second implementation of validation (and
 * a ReDoS surface reachable from a config edit). Naming the shape keeps the
 * check in ONE reviewed function — `modelIdMatchesShape` in the adapters — and
 * makes adding a form a deliberate two-file edit instead of a regex tweak.
 *
 * `provider-qualified`: `provider/model`, opencode's own form (its ids come
 * from models.dev, e.g. `anthropic/claude-sonnet-5`). The `model` half may
 * itself contain `/` — an aggregator provider re-exports upstream ids that way
 * (`openrouter/qwen/qwen3-coder`) — so the form is "at least one separator, no
 * empty segment", not "exactly one slash". It additionally excludes control and
 * separator characters (NUL and zero-width space are not `\s`) and anything
 * path-shaped (`.`/`..` segments, a leading `~`/`$`), because a model id is not
 * a path and a form check that called `../../etc/passwd` well-formed would be
 * theatre. The exact rule lives in `modelIdMatchesShape`.
 */
export type VendorModelIdShape = "provider-qualified";

export type VendorEntry = {
  readonly id: VendorId;
  /** ONE label source. Collapses the ~17 hand-written label tables. */
  readonly displayName: string;
  /** Compact label for dense surfaces (cockpit rows, budget overlays). */
  readonly shortLabel: string;
  /** Glyph key the desktop/TUI icon maps resolve; unknown falls back. */
  readonly iconKey: string;
  /** The upstream provider, as the adapter declares it. */
  readonly provider: string;
  /** "dev-test" entries are NAMEABLE but never production-dispatchable. */
  readonly visibility: "public" | "dev-test";
  /**
   * 0 = free/local … 1 = premium frontier. Feeds role-assignment's cost term,
   * which prefers cheap lanes for `scout` and expensive ones for roles where a
   * weak model is actively harmful. Ranks; never admits.
   */
  readonly cost: number;

  /**
   * EVERY field REQUIRED. No optionals, no defaults, no `?`. This is the
   * mechanism, not the documentation, for "a new vendor has no authority".
   */
  readonly authority: {
    /** The role ceiling. `[]` is meaningful: this vendor holds no role. */
    readonly supportedRoles: readonly AgentRole[];
    /** May seat the super-orchestrator at reserved ordinal 0. */
    readonly coordinatorSeat: boolean;
    /** May be targeted by `POST /api/dispatch`. */
    readonly dispatchable: boolean;
    /** May be named by a worker's `delegate`. */
    readonly delegatable: boolean;
    /** Appears in the 0–3 worker fleet. */
    readonly fleetSizeable: boolean;
    /** May run the ADR-0018 critique loop. */
    readonly evaluator: boolean;
    /** May run the workflow planner. */
    readonly planner: boolean;
    /** May be spawned into a desktop pty by the (untrusted) renderer. */
    readonly terminalTakeover: boolean;
    /**
     * A tier-1 MOAT vendor (bespoke driver + profile fidelity ACP lacks). Such
     * a lane may NEVER be driven over ACP (ADR-0007 Decision 2). This is the
     * SINGLE source of that fact: `AcpSessionDriver` derives its refusal set
     * from this flag rather than a hardcoded literal, so a new moat vendor is
     * protected by its own declaration — not by remembering to edit a list in
     * the adapter. There is no `tier` concept anywhere else in protocol; this
     * boolean is it.
     */
    readonly tier1: boolean;
  };

  /**
   * The adapter's own opinion, 0..1. Ranks among ALREADY-AUTHORIZED lanes and
   * can never grant one. Partial on purpose: a missing role falls back to the
   * capability-derived default in `role-assignment.ts`.
   */
  readonly roleAffinity: Partial<Record<AgentRole, number>>;

  readonly session: {
    readonly driver: VendorSessionDriverKind;
    readonly canSend: boolean;
    /**
     * TODO 1.4 — DECIDED: **can MUON stop this work**, not "can this work be
     * stopped". The two differ exactly where it matters.
     *
     * The question was whether a HUMAN-ATTACHED session counts: the operator can
     * press Ctrl-C in their own terminal, so the work is interruptible, and
     * declaring `true` would be arguably truthful. It is refused, for three
     * reasons that are each sufficient.
     *
     * First, this field is READ AS A LEVER MUON HOLDS. `vendorRoutingLines()`
     * renders it to an orchestrating agent as "watch + interrupt" — a promise
     * about what MUON can do on the operator's behalf, which evaporates if the
     * only stop is a person pressing Ctrl-C. (Do not confuse this with
     * `LaneCapabilities.canInterrupt`, the PROCESS-level AbortSignal / child-kill
     * flag that `ROLE_SPECS.orchestrator.requiredCapabilities` actually names —
     * that is a different boolean on a different type. This field is the
     * session-driver channel.)
     *
     * Second, a human terminal is not a lane. Attach labels live in a keyspace
     * the drift-lock pins DISJOINT from this registry (ADR-0022 §8,
     * backend/tests/vendor-registry-drift.test.ts), precisely so an attach-only
     * affordance cannot acquire lane authority by sharing an id. Reading a lane
     * capability off a human's terminal merges the two by the back door.
     *
     * Third, MUON has a real answer already: `session/cancel` → `interrupt()`
     * (TODO 1.3). A lane earns this flag by having a CHANNEL, which is why
     * `SESSION_DRIVERS_THAT_CAN_INTERRUPT` gates it structurally rather than
     * leaving it to a reviewer to notice.
     */
    readonly canInterrupt: boolean;
    readonly canResume: boolean;
    /** MUON persists a chat-continuity handle bound to this vendor. */
    readonly persistsSessionHandle: boolean;
    /**
     * REQUIRED when `driver === "acp"`, absent otherwise: how MUON launches
     * this vendor's ACP surface (`command` must appear in
     * `execution.commandCandidates`; `args` put the binary into ACP mode).
     * Data, not code — a new ACP vendor is a registry entry, not a driver.
     */
    readonly acp?: {
      readonly command: string;
      readonly args: readonly string[];
    };
  };

  readonly execution: {
    readonly modes: readonly VendorExecutionMode[];
    /** Binaries MUON may SPAWN for a dispatch. */
    readonly commandCandidates: readonly string[];
    /**
     * A second binary MUON actually spawns instead of (or as well as) the
     * vendor's own CLI. `null` for every vendor today; the field survives the
     * Ollama removal because it is the only place a "this lane runs THROUGH
     * another runtime" vendor can state that honestly.
     */
    readonly runtimeRequirement: {
      readonly candidates: readonly string[];
      readonly detail: string;
      readonly fixHint: string;
    } | null;
    readonly compiler: VendorCompilerKind;
    readonly guards: {
      /** This vendor HAS `--strict-mcp-config`, so MUON sanitizes it. */
      readonly strictMcpConfigFlag: boolean;
      /**
       * ADR-0022 §9.3.1 follow-on — the NON-ARGV boundary, as registry data.
       *
       * The environment variables this vendor's launch guard sets to make
       * MUON's deny table the last word. These are exactly as
       * governance-bearing as `wideningFlags`, and until this field existed
       * they lived only inside the adapter where the drift-lock could not see
       * them ("the biggest gap Wave F found"). NAMES + purposes, not values:
       * values are per-run (paths, JSON tables) and stay the adapter's;
       * the drift-lockable statement is WHICH keys carry authority. An empty
       * list is the statement "this vendor's boundary is argv-only", not an
       * omission — the conformance test compares this list against the
       * adapter's actual guard-env builder for every vendor.
       */
      readonly launchEnv: readonly {
        readonly name: string;
        readonly purpose: string;
      }[];
      /**
       * Vendor-specific authority-widening flags stripped at spawn by THIS
       * vendor's own guard. Deliberately per-vendor data: one generic list
       * applied to everything would strip flags Codex legitimately needs.
       */
      readonly wideningFlags: readonly string[];
      /**
       * TODO 1.16 — THE VENDOR-NATIVE FAN-OUT AUDIT, AS DATA.
       *
       * Several vendors ship their own sub-agent mechanism. A child spawned that
       * way is invisible to MUON: outside the job lineage, the budget, the
       * worktree, and the token gates — and per Cursor's own docs a native
       * subagent INHERITS the parent's tools, MCP tools included, with no
       * per-subagent allowlist. So seating a lane without auditing this hands
       * MUON's governed brain to ungoverned children.
       *
       * It is a REGISTRY FIELD rather than a checklist because "every new lane
       * needs this audit before it is seated" is not enforceable by memory. A
       * vendor added without a `nativeFanOut` entry fails `tsc`, and the
       * drift-lock test pins each declared suppression against the code that
       * actually performs it.
       *
       * `mechanism: null` is a positive claim that the vendor ships none — not
       * an unfilled slot — and `suppression.state` says how far the claim is
       * proven, in the same three-way honesty this codebase uses everywhere
       * else: `enforced` (MUON emits it and a test pins it), `declared`
       * (MUON emits it; the vendor's ENFORCEMENT is not observed), `none`.
       */
      readonly nativeFanOut: {
        /** What the vendor ships, or `null` for "it ships none". */
        readonly mechanism: string | null;
        readonly suppression: {
          readonly state: "enforced" | "declared" | "none";
          /** How MUON suppresses it, or why it cannot. */
          readonly detail: string;
        };
      };
      /**
       * TODO 1.15 — WHOSE HOOKS DOES THIS VENDOR RUN? AS DATA.
       *
       * A vendor that executes ANOTHER vendor's hook files turns MUON's careful
       * per-vendor containment into a shared surface: the net MUON writes over
       * one vendor's hook path is not the net that vendor actually reads. It is
       * a field for the same reason `nativeFanOut` is — "audit this before you
       * seat a lane" is not enforceable by memory, and a vendor added without an
       * entry fails `tsc`.
       *
       * MEASURED, and it is not the vendor the item guessed: cursor-agent
       * 2026.07.23-e383d2b loads SEVEN hook sources and three of them are Claude
       * Code's. A repo-committed `.claude/settings.json` executed its
       * `SessionStart` and `PreToolUse` commands inside a run carrying MUON's
       * exact argv — `--print --output-format json --mode plan --trust
       * --skip-worktree-setup` — so `--mode plan` bounds the MODEL's tools and
       * says nothing about what the vendor itself spawns. It also sets
       * `CLAUDE_PROJECT_DIR` on every hook exec, which is the identity half the
       * item predicted.
       *
       * `sources: []` is a positive claim that the vendor reads only its own
       * layers, not an unfilled slot. `containment.state` keeps the same
       * three-way honesty used elsewhere: `owned` (MUON writes every listed
       * path), `partial` (MUON owns some and the rest is named, not hidden),
       * `none`.
       *
       * SCOPE: hooks, i.e. commands the VENDOR spawns. Foreign INSTRUCTION files
       * (opencode reads `.claude/skills/`, cursor reads `.claude/agents/`) are a
       * prompt-injection surface, not an execution one, and belong to the
       * instruction-provenance question rather than here.
       */
      readonly foreignHookReplay: {
        /** Foreign hook config paths this vendor executes, `[]` for none. */
        readonly sources: readonly string[];
        readonly containment: {
          readonly state: "owned" | "partial" | "none";
          /** What MUON writes over, and what it cannot reach. */
          readonly detail: string;
        };
      };
    };
  };

  readonly readiness: {
    /**
     * Binaries that count as INSTALLED — deliberately WIDER than
     * `execution.commandCandidates`. For cursor the bare `cursor` IDE launcher
     * counts as installed but must NEVER be spawned for a dispatch. Do not
     * collapse these two fields.
     */
    readonly installedCandidates: readonly string[];
    readonly authCandidates: readonly string[];
    readonly authArgs: readonly string[];
    readonly versionArgs: readonly string[];
    /** `{bin}` placeholder, same convention as the ADR-0013 channels. */
    readonly loginHint: string;
    readonly installHint: string;
    readonly connectKind: VendorConnectKind;
  };

  readonly credentials: {
    /** Forwarded to THIS lane's child only (lane-runner's per-lane filter). */
    readonly envKeys: readonly string[];
    /** API-key names this vendor OWNS (provider-credentials evidence). */
    readonly ownedKeys: readonly string[];
    /** Resolved into the sandboxed runner env by the launcher. */
    readonly forwardToRunner: boolean;
  };

  /**
   * THE model catalogue — TODO 3.3 collapsed the adapters' second hand-written
   * copy into a projection of this field (`registryModelPolicy`), so a vendor
   * bump is one edit here rather than two that a drift-lock had to keep married.
   *
   * `null` must stay legal: a vendor has to be usable before someone curates
   * its catalogue, and the "no declared policy → accept any non-guarded id with
   * a warning" degrade is what makes that true. It is ALSO what
   * `assertVendorHasModelCatalog` refuses a per-dispatch override on, so `null`
   * is a live authority statement and not merely an empty slot.
   *
   * TODO 3.4 SPLIT THAT STATEMENT IN TWO, because it had been carrying two
   * different facts. `null` now means only "MUON can check NOTHING about an id
   * for this lane, so refuse the override". A vendor whose ids are checkable in
   * FORM but not in MEMBERSHIP says so with `known: []` + `idShape`, and gets
   * the override — see opencode below. The three-way is deliberate:
   *   - `null`                        → no override (nothing is verifiable).
   *   - `known: []` + `idShape`       → override, form verified, membership not.
   *   - `known: [...]`                → override, membership verified.
   */
  readonly models: {
    readonly known: readonly string[];
    readonly allowCustom: boolean;
    /**
     * A validatable FORM for this vendor's model ids, for the case TODO 3.4
     * exposed: a catalogue can be unenumerable (operator-dependent) while its
     * ids are still well-shaped. Declaring the shape is what lets MUON accept a
     * per-dispatch override it cannot check for MEMBERSHIP without pretending
     * `sonnet` is a plausible opencode id.
     *
     * `null` means MUON declares no form, and the only checks are the
     * categorical ones every value gets (non-empty, not guarded, not
     * flag-shaped). That is the right answer for a vendor whose ids are bare
     * slugs, where a shape would be indistinguishable from "any word".
     */
    readonly idShape: VendorModelIdShape | null;
  } | null;
};

const ALL_ROLES: readonly AgentRole[] = [
  "orchestrator",
  "architect",
  "implementer",
  "reviewer",
  "qa",
  "scout",
  "docs",
];

/**
 * MAPPED TYPE — a missing key AND an extra key are both `tsc` errors.
 *
 * Every value below states TODAY'S behaviour verbatim. The drift-lock exists
 * precisely so a disagreement with a downstream surface is fixed in the COPY
 * rather than papered over here.
 *
 * ADR-0022 §1.2(a) — the `opencode` divergence this comment used to name — is
 * CLOSED by TODO 3.3: every vendor has a capability descriptor now, and this
 * `models` column is the one hand-maintained catalogue that the descriptor
 * derives from. `models: null` still appears below, but it is a curation
 * statement ("MUON validates no id for this lane"), not a missing row.
 */
export const VENDOR_REGISTRY: { readonly [K in VendorId]: VendorEntry } = {
  "claude-code": {
    id: "claude-code",
    displayName: "Claude Code",
    shortLabel: "Claude",
    iconKey: "claude-code",
    provider: "anthropic",
    visibility: "public",
    cost: 0.9,
    authority: {
      supportedRoles: ALL_ROLES,
      coordinatorSeat: true,
      dispatchable: true,
      delegatable: true,
      fleetSizeable: true,
      evaluator: true,
      planner: true,
      terminalTakeover: true,
      tier1: true,
    },
    roleAffinity: {
      orchestrator: 0.9,
      architect: 0.92,
      implementer: 0.9,
      docs: 0.88,
      reviewer: 0.8,
      qa: 0.7,
      scout: 0.5,
    },
    session: {
      driver: "claude-sdk",
      canSend: false,
      canInterrupt: true,
      canResume: true,
      persistsSessionHandle: true,
    },
    execution: {
      modes: ["one-shot", "interactive", "background"],
      commandCandidates: ["claude"],
      runtimeRequirement: null,
      compiler: "claude",
      // The only vendor whose CLI has `--strict-mcp-config`, which would evict
      // MUON's own governed MCP server, so the only one MUON sanitizes for it.
      guards: {
        strictMcpConfigFlag: true,
        // Boundary is argv-only (allowedTools + launch assertion); no env lever.
        launchEnv: [],
        wideningFlags: [],
        // TODO 1.16: Claude Code's own `Task` tool is the sub-agent spawner, and
        // it is suppressed the same way every other native tool is — by ABSENCE
        // from the coordinator's exact `allowedTools`, which `execute.ts` builds
        // from `MUON_ORCHESTRATOR_TOOL_NAMES` alone and then asserts against an
        // over-capability check at launch. There is no `features.*` key to turn
        // off, which is why this vendor carries no config override where codex
        // does.
        nativeFanOut: {
          mechanism: "the `Task` tool (spawns a sub-agent in-session)",
          suppression: {
            state: "enforced",
            detail:
              "`Task` is unioned into `--disallowedTools` / SDK `disallowedTools` by the compiler on EVERY claude lane, coordinator and worker alike, where deny beats allow. The coordinator additionally never receives it: its allowedTools is exactly the governed MCP inventory and the launch-time over-capability assertion refuses a profile that re-widens it. Governed fan-out is `mcp__muon__dispatch`.",
          },
        },
        // TODO 1.15: claude reads only its OWN settings layers. It is the vendor
        // being replayed, not one that replays — and that is the direction that
        // matters here, because MUON's own claude write is a document another
        // vendor executes. `compileClaudeProfile` therefore refuses a `hooks` key
        // in `rawConfig`; see `CLAUDE_RAW_CONFIG_FORBIDDEN_KEYS` in @muon/adapters.
        foreignHookReplay: {
          sources: [],
          containment: {
            state: "none",
            detail:
              "No foreign hook path in the shipped bundle: its `hooks.json` hits are its OWN plugin layer (`~/.claude/plugins/*/hooks/hooks.json`), and the `.codex/` strings are its settings-import feature, not a hook source. The exposure runs the other way — cursor executes the `.claude/settings.json` MUON's claude lane writes near — so MUON keeps its own claude document hook-free by construction rather than relying on that asymmetry.",
          },
        },
      },
    },
    readiness: {
      installedCandidates: ["claude"],
      authCandidates: ["claude"],
      authArgs: ["auth", "status", "--json"],
      versionArgs: ["--version"],
      loginHint:
        "log into Claude Code first: run `claude` and sign in (or `claude auth login`; API-key alternative: set ANTHROPIC_API_KEY)",
      installHint:
        "install the Claude Code CLI (`npm i -g @anthropic-ai/claude-code`), then run `claude` and sign in",
      connectKind: "account",
    },
    credentials: {
      envKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR"],
      ownedKeys: ["ANTHROPIC_API_KEY"],
      forwardToRunner: true,
    },
    // Bare tier aliases (`opus`), plus dated ids (`claude-sonnet-4-5-20250929`)
    // under allowCustom. No declarable form: any word is a candidate.
    models: {
      known: ["fable", "opus", "sonnet", "haiku"],
      allowCustom: true,
      idShape: null,
    },
  },
  codex: {
    id: "codex",
    displayName: "Codex",
    shortLabel: "Codex",
    iconKey: "codex",
    provider: "openai",
    visibility: "public",
    cost: 0.8,
    authority: {
      supportedRoles: ALL_ROLES,
      coordinatorSeat: true,
      dispatchable: true,
      delegatable: true,
      fleetSizeable: true,
      evaluator: true,
      planner: true,
      terminalTakeover: true,
      tier1: true,
    },
    roleAffinity: {
      implementer: 0.9,
      qa: 0.88,
      orchestrator: 0.85,
      reviewer: 0.8,
      architect: 0.75,
      docs: 0.6,
      scout: 0.55,
    },
    session: {
      driver: "codex-app-server",
      canSend: true,
      canInterrupt: true,
      canResume: false,
      // No chat-continuity handle: `chats.ts` binds only claude-code today.
      persistsSessionHandle: false,
    },
    execution: {
      modes: ["one-shot", "interactive", "background"],
      commandCandidates: ["codex"],
      runtimeRequirement: null,
      compiler: "codex",
      guards: {
        strictMcpConfigFlag: false,
        launchEnv: [
          {
            name: "CODEX_HOME",
            purpose:
              "Isolated guard home: config, sessions, and rollouts resolve under MUON's own directory, never ~/.codex (one verified lever; see codex-guard.ts).",
          },
        ],
        // Flags that widen authority, defeat MUON's ambient-config guard, or
        // send the run off-machine. `--profile`/`-p` layers a config file from
        // the Codex home; `--enable` is the exact undo of MUON's own feature
        // suppression. The `-c features.*` overrides that would undo it by
        // config key are judged BY KEY at the guard, not by name, so they are
        // deliberately not in this flat list. Kept in sync with
        // `CODEX_WIDENING_FLAGS` in @muon/adapters by
        // `packages/adapters/tests/codex-guard.test.ts` (protocol cannot import
        // adapters, so agreement is asserted rather than shared).
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
        // TODO 1.16: codex's native multi-agent fleet is stable and ON BY
        // DEFAULT, and it is the one fan-out MUON suppresses by CONFIG KEY. Two
        // halves, both pinned: the adapter passes the `-c features.*=false`
        // overrides on every codex run, and `execute.ts` refuses to launch a
        // codex coordinator whose profile does not carry
        // `features.multi_agent: false`. `--enable` (its exact undo) is in the
        // widening list above, and a `-c features.*` re-widen is judged by KEY at
        // the guard.
        nativeFanOut: {
          mechanism: "features.multi_agent / features.multi_agent_v2 (default ON)",
          suppression: {
            state: "declared",
            detail:
              "`-c features.multi_agent=false` + `-c features.multi_agent_v2=false` on every run and both transports, plus a launch refusal for a codex coordinator profile missing `features.multi_agent: false`. `declared`, NOT `enforced`, and deliberately: codex 0.145 reports `multiAgentMode: explicitRequestOnly` for every thread — measured identical with and without those flags, and unchanged even asking for `none` at `thread/start` (see UNGOVERNABLE_MULTI_AGENT_MODES in codex-capability-preflight.ts). MUON emits the suppression; the vendor is not observed honouring it. The preflight surfaces the residue so the exposure is named rather than discarded.",
          },
        },
        // TODO 1.15: codex adopted claude's hook PROTOCOL wholesale — its engine
        // speaks `PreToolUse`/`PostToolUse`/`PermissionRequest`/`SubagentStop` and
        // exports `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` to handlers — which is
        // what makes it look like a replayer on a strings pass. It is not one: the
        // claude and cursor paths in the 0.146 binary all sit in its
        // `external-agent-migration` service (`codex.external_agent_config.detect`
        // / `.import`), an explicit operator command, not a per-run load.
        foreignHookReplay: {
          sources: [],
          containment: {
            state: "none",
            detail:
              "Its own hook layer is `$CODEX_HOME/hooks.json`, and `CODEX_HOME` is already MUON's (see codex-guard.ts: pointed at a MUON directory the whole ambient layer — MCP servers, plugins, hooks.json, profiles, `[features]` — resolves empty at once). So the one hook surface codex has is owned by the same lever that owns everything else, and the foreign paths are reachable only by running the migration command, which MUON never does.",
          },
        },
      },
    },
    readiness: {
      installedCandidates: ["codex"],
      authCandidates: ["codex"],
      authArgs: ["login", "status"],
      versionArgs: ["--version"],
      loginHint: "log into Codex first: `codex login`",
      installHint:
        "install the Codex CLI (`npm i -g @openai/codex` or `brew install codex`), then `codex login`",
      connectKind: "account",
    },
    credentials: {
      // `CODEX_HOME` USED TO BE HERE, and that was backwards. It is not a
      // credential: it is the config ROOT, and forwarding the operator's own
      // root handed every dispatched child their entire personal
      // `~/.codex/config.toml` — measured on the founder's machine as seven MCP
      // servers and 206 tools, including a Node REPL and desktop control, none
      // of it in MUON's grant. It is now MUON's lever instead, set to an
      // isolated guard home by `codexGuardEnv` in @muon/adapters, which also
      // links the operator's own `auth.json` so BYO-auth still resolves.
      // Dropping it from this list is what stops the AMBIENT value being
      // inherited in the first place (`buildLaneEnvironment`), so the guard is
      // not merely overriding a value that would otherwise arrive.
      envKeys: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
      ownedKeys: ["OPENAI_API_KEY"],
      forwardToRunner: true,
    },
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
      // Bare slugs. `codex debug models` returns exactly the six above, so the
      // catalogue is ENUMERABLE here — the case `idShape` exists to cover does
      // not arise, and claiming a form would only fence out the next slug.
      idShape: null,
    },
  },
  cursor: {
    id: "cursor",
    displayName: "Cursor",
    shortLabel: "Cursor",
    iconKey: "cursor",
    provider: "cursor",
    visibility: "public",
    cost: 0.4,
    authority: {
      // The read-only slice, and nothing wider. `docs` is excluded HERE and
      // only here — it requires only `canStreamEvents`, which Cursor has, so
      // this list is the entire boundary.
      //
      // TODO 2.2 — DECIDED 2026-07-31: Cursor does NOT hold `implementer` (yet).
      // The previous hard blocker ("no file-write gate") is STALE: on
      // `cursor-agent 2026.07.23-e383d2b`, `preToolUse` fires for `Write` and
      // `deny` is honoured even under `--force`, and `beforeShellExecution`
      // closes the shell bypass (measured live). What remains is PRODUCT
      // wiring, not mechanism absence: MUON strips `--force` as a widening
      // flag today, an implementer seat would need a deliberate path that
      // emits it under MUON control PLUS a maintained write-tool matcher
      // inventory. Until that profile exists, this ceiling stays closed — a
      // registry test pins the absence of every write-authority role.
      supportedRoles: ["reviewer", "qa", "architect", "scout"],
      coordinatorSeat: false,
      dispatchable: true,
      delegatable: true,
      fleetSizeable: true,
      evaluator: false,
      planner: false,
      terminalTakeover: true,
      tier1: true,
    },
    roleAffinity: { reviewer: 0.78, qa: 0.7, architect: 0.72, scout: 0.8 },
    session: {
      // No MUON session driver (ADR-0013/0022). CLI `--resume`/`--continue` and
      // `create-chat` (returns an id) exist for HUMAN take-over — see
      // `apps/tui/src/lib/take-over.ts` — but `canResume` /
      // `persistsSessionHandle` unlock MUON-governed write paths (G7/G8) and
      // MUST stay false until a cursor driver earns them. A structural
      // invariant also pins every `driver:"none"` vendor to all-false session
      // booleans (vendor-registry.test.ts).
      driver: "none",
      canSend: false,
      canInterrupt: false,
      canResume: false,
      persistsSessionHandle: false,
    },
    execution: {
      modes: ["one-shot", "background"],
      // The AGENT CLI only — see `readiness.installedCandidates` for why the
      // bare `cursor` launcher is absent here.
      commandCandidates: ["cursor-agent", "agent"],
      runtimeRequirement: null,
      compiler: "cursor",
      guards: {
        strictMcpConfigFlag: false,
        // Boundary is argv + permissions.json in the workspace; no env lever.
        launchEnv: [],
        // `--sandbox disabled` is judged BY VALUE at the guard, not by name, so
        // it is deliberately not in this flat list.
        //
        // TODO 1.16 added the last two, found by auditing this vendor's ATTACH
        // surfaces rather than its permission surfaces:
        //  - `--plugin-dir <path>` ("Load a local plugin directory") runs
        //    arbitrary code inside the governed review — the same class as the
        //    global opencode plugin that finding 1.8 closed with `--pure`.
        //  - `-w`/`--worktree` starts the run in `~/.cursor/worktrees/<repo>/<name>`
        //    instead of the cwd MUON prepared, which would move it away from the
        //    `.cursor/cli.json` MUON writes there. That does not merely lose
        //    isolation; it DISARMS the permission table, so it is a widening even
        //    though it reads like a workspace preference. `--worktree-base` only
        //    ever accompanies them and is listed so a stripped pair can never
        //    leave its value behind as a stray positional (which cursor reads as
        //    prompt text).
        // `--skip-worktree-setup` is deliberately NOT here: skipping a repo's own
        // `.cursor/worktrees.json` setup SCRIPTS is the safe direction, exactly
        // like `--sandbox enabled`.
        // TODO 2.6 answered the last open question about this list and, in
        // checking, found the list itself had gone stale: it stopped at the nine
        // flags the first `--help` audit found, while the guard (`@muon/adapters`
        // `CURSOR_WIDENING_FLAGS`) had grown to strip twelve more — the hidden
        // ones TODO 1.16 re-derived from the shipped bundle. The registry is the
        // DECLARATION and the guard the behaviour, so a registry that
        // under-declares makes the drift-lock's "declared ⇒ stripped" check read
        // stronger than it was: it was passing over a nine-flag subset of a
        // twenty-one-flag guard. The two now match exactly, asserted BOTH ways.
        //
        // THREE flags are deliberately absent, all for the same reason — they
        // narrow authority, and stripping a narrowing flag widens the run:
        // `--skip-worktree-setup` (decline the repo's own setup scripts),
        // `--sandbox enabled`, and `--trust`. The last is the one that took
        // measuring: it is a PRECONDITION for a non-interactive run, not a grant
        // of tool authority, and MUON emits it itself (see `taskCommand` in
        // @muon/adapters for the full answer and its residue).
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
        // TODO 1.16: cursor ships real subagents behind a `Task` tool, and a
        // spawned one came back holding `Write`, `StrReplace`, `Delete`, `Shell`
        // and the MCP meta-tools from a parent running `--mode plan` — plan mode
        // instructs the PARENT, it does not bound the parent's children. There is
        // no CLI flag (`cursor-agent --help`, 2026.07.23: no subagent option, no
        // subagent subcommand) and the permission table cannot express it either:
        // `Task(**)`, `Task(*)` and bare `Task` all left the spawn working, while
        // `Write(**)` blocked a write in the same fixture. What works, measured, is
        // a `preToolUse` hook matched on `Task` in the run-scoped
        // `.cursor/hooks.json` MUON writes. See `buildCursorHooksConfig` in
        // @muon/adapters for the full measurement record.
        nativeFanOut: {
          mechanism: "the `Task` tool (native subagents, write-capable)",
          suppression: {
            state: "enforced",
            detail:
              "A `failClosed` `preToolUse` hook matched on `Task` in the run-scoped `.cursor/hooks.json`. Proven live 2026-07-31: `Task blocked by preToolUse hook`, zero subagents started, a `Read` in the same turn unaffected.",
          },
        },
        // TODO 1.15 — THIS IS THE VENDOR. Measured on 2026.07.23-e383d2b: its hook
        // loader takes SEVEN sources and three are Claude Code's, mapped event by
        // event (`PreToolUse`→`preToolUse`, `UserPromptSubmit`→`beforeSubmitPrompt`,
        // `Stop`→`stop`, …; `PermissionRequest` and `Notification` map to null).
        // Live proof, MUON's exact argv: a repo-committed `.claude/settings.json`
        // ran its `SessionStart` and `PreToolUse` commands, and `--mode plan` did
        // not stop it, because plan mode bounds the MODEL's tools while a hook is
        // spawned by the VENDOR. Merge precedence is deny > ask > allow, so a
        // hostile `allow` cannot out-vote MUON's `Task` deny — the exposure is
        // arbitrary command execution and context injection, not a widened table.
        //
        // The identity half the item predicted is real too: every hook exec carries
        // `CLAUDE_PROJECT_DIR`, and on this machine the replayed handlers are
        // hardcoded to the wrong vendor (`git-ai checkpoint claude`,
        // `SUPERSET_AGENT_ID=claude`), so a governed CURSOR review was committing
        // git checkpoints attributed to CLAUDE.
        foreignHookReplay: {
          sources: [
            ".claude/settings.json",
            ".claude/settings.local.json",
            "~/.claude/settings.json",
          ],
          containment: {
            state: "partial",
            detail:
              "MUON writes both PROJECT paths as part of `cursorMandatoryConfigWrites` (a neutral `{hooks:{}}`, measured to leave a clean run), which closes the repo-supplied half — the security half. The USER-GLOBAL `~/.claude/settings.json` is NOT closable: it is loaded ungated, cursor offers no disable lever (the only claude-related option in the bundle is `enableClaudeNestedHookSpecificOutputCompatibility`, an output-shape flag), and the only lever that would move the path is `$HOME`, which is also where cursor's own credentials live. `--disable-project-configs` would drop the claude project paths but takes MUON's own `.cursor/` net with them, so it stays refused. Named, not hidden: `cursorForeignHookExposure()` reports it and the cursor preflight surfaces it.",
          },
        },
      },
    },
    readiness: {
      installedCandidates: ["agent", "cursor-agent", "cursor"],
      authCandidates: ["cursor-agent", "agent"],
      authArgs: ["status"],
      versionArgs: ["--version"],
      loginHint: "log into Cursor first: `{bin} login`",
      installHint:
        "install the Cursor agent CLI (`curl https://cursor.com/install -fsS | bash`), then `cursor-agent login`",
      connectKind: "account",
    },
    credentials: {
      envKeys: ["CURSOR_API_KEY"],
      ownedKeys: ["CURSOR_API_KEY"],
      forwardToRunner: true,
    },
    models: {
      // TODO 3.2: live cursor-agent account ids (2026.07.23-e383d2b). allowCustom
      // stays true so the full CLI catalogue from listVendorModels may launch.
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
      // Bare slugs with an effort suffix (`-high`), not provider-qualified.
      idShape: null,
    },
  },
  opencode: {
    id: "opencode",
    displayName: "OpenCode",
    shortLabel: "OpenCode",
    iconKey: "opencode",
    provider: "opencode",
    visibility: "public",
    // BYO-provider: the operator's own account pays, and the lane is pointed at
    // whatever model they configured. Ranked below Cursor so that removing the
    // free local lane does not silently re-order an existing crew's `scout`.
    cost: 0.3,
    authority: {
      // `scout` AND NOTHING ELSE — the narrowest role in the taxonomy (the only
      // one with no required capabilities, `maxSandbox: read-only`,
      // `maxPermissionMode: strict` and `allowsWriteTools: false`).
      //
      // This is deliberately NARROWER than Cursor, because live probing of
      // opencode 1.18.5 knocked out three of the four premises a wider slice
      // would have rested on:
      //   1. there is no `--permissions` CLI flag at all; the ONLY permission
      //      flag is `--auto`, which WIDENS. Permissions are config-only.
      //   2. the `plan` agent is NOT read-only. Measured on 1.18.7
      //      (2026-07-31, `opencode debug agent plan`, operator config isolated
      //      out): the resolved table is `{permission:"*", action:"allow"}` at
      //      POSITION 1 — `plan` denies NOTHING; only `question` is denied and
      //      `doom_loop`/`external_directory` are `ask`. (The earlier "edit
      //      denied, bash allowed" reading was wrong; the conclusion — plan is
      //      not a security boundary — stands, harder.) There is no
      //      vendor-defined read-only mode to lean on the way Cursor's
      //      `--mode plan` is leaned on.
      //   3. a workspace `opencode.json` RE-WIDENS whatever MUON narrowed,
      //      unless `OPENCODE_DISABLE_PROJECT_CONFIG=1` is set (proven, see
      //      `opencode-adapter.ts`). The repo under test is attacker-controlled
      //      input, so that is a live re-widening vector, not a theoretical one.
      // What MUON *can* prove is that its own config RESOLVES to a deny table.
      // Enforcement of that table at tool-call time has NOT been observed (it
      // needs a real model turn), so the lane is admitted only where a wrong
      // answer is cheapest and the artifact is text, never a patch or a verdict
      // on someone else's diff. Widening to `qa`, then `reviewer`/`architect`,
      // is a follow-on that must first OBSERVE enforcement live.
      supportedRoles: ["scout"],
      coordinatorSeat: false,
      dispatchable: true,
      delegatable: true,
      fleetSizeable: true,
      evaluator: false,
      planner: false,
      // HUMAN terminal only. This flag gates exactly one thing: the desktop's
      // vendor tab bar / human-owned interactive pty spawn (ADR-0023 §5 — the
      // same trust boundary as the operator running `opencode` in their own
      // shell; MUON strips its own control-plane tokens and claims no OS
      // confinement there). It grants NO governed-dispatch authority, so the
      // scout-only posture above is untouched by it.
      //
      // This was `false` while `opencode` was ALSO a label in the desktop's
      // separate takeover/attach namespace (ADR-0022 §8) — the same id in two
      // keyspaces could have merged them by accident. Wave F removed the id
      // from the attach table when OpenCode became a managed lane, and the
      // drift-lock (backend/tests/vendor-registry-drift.test.ts) now pins the
      // two keyspaces DISJOINT, so the hazard is closed by assertion rather
      // than by withholding the human's own terminal.
      terminalTakeover: true,
      // Not a moat lane: opencode is the long-tail read-only scout, exactly the
      // kind of vendor ACP is FOR — so it is eligible to be driven over ACP
      // once it declares it (ADR-0007). tier1 stays false.
      tier1: false,
    },
    // Below Cursor's 0.8 on purpose: Cursor stays the preferred scout, so this
    // entry cannot change which lane an existing crew picks.
    roleAffinity: { scout: 0.75 },
    session: {
      // `--session`/`--continue`/`--fork` and `opencode serve` all exist, so a
      // driver is BUILDABLE — but every field here is an authority statement
      // (ADR-0022 G7/G8), a scout has nothing to steer, and `serve` is a network
      // listener with its own auth model. v1 is one-shot `run`; all false.
      driver: "none",
      canSend: false,
      canInterrupt: false,
      canResume: false,
      persistsSessionHandle: false,
    },
    execution: {
      modes: ["one-shot", "background"],
      commandCandidates: ["opencode"],
      runtimeRequirement: null,
      compiler: "opencode",
      guards: {
        strictMcpConfigFlag: false,
        launchEnv: [
          {
            name: "OPENCODE_DISABLE_PROJECT_CONFIG",
            purpose:
              "Stops the workspace's own opencode.json / .opencode/agent/*.md from loading — a repo under review cannot re-widen bash to allow.",
          },
          {
            name: "OPENCODE_CONFIG",
            purpose: "Names MUON's own guard config file explicitly instead of relying on discovery.",
          },
          {
            name: "OPENCODE_CONFIG_CONTENT",
            purpose:
              "Carries the same deny table INLINE, loading above project config — containment does not rest on the disable-project lever alone.",
          },
          {
            name: "OPENCODE_PERMISSION",
            purpose:
              "opencode's top-level last word for permissions; merged per key, so MUON must set it or leave the strongest lever to whoever set it last.",
          },
          {
            name: "XDG_CONFIG_HOME",
            purpose:
              "Relocated to the guard dir — the only verified lever that removes ambient user config from the merge.",
          },
        ],
        // `--auto` auto-approves every permission; `--share` publishes the
        // session off-machine; `--attach` sends the whole run to a remote
        // server; `--agent` would select a DIFFERENT permission table than the
        // one MUON compiled (`build` is full-access); the listener flags turn a
        // one-shot into a server. MUON's own invocation emits NONE of these, so
        // the guard can strip them all unconditionally.
        // TODO 1.16: opencode's sub-agent spawner is the `task` permission token,
        // and it is denied BY NAME in the guard config's table
        // (`OPENCODE_DENIED_PERMISSIONS`) — a wildcard alone would lose to
        // opencode's specificity-first resolution. `--agent`, which would select a
        // different table entirely, is in the widening list below.
        nativeFanOut: {
          mechanism: "the `task` tool (spawns a sub-agent)",
          suppression: {
            state: "declared",
            detail:
              "`task: deny` by name in the guard config, carried on all three levers (file, OPENCODE_CONFIG_CONTENT, OPENCODE_PERMISSION). Resolution proven live; enforcement at tool-call time is 1.11's open gate.",
          },
        },
        // TODO 1.15: opencode reads foreign INSTRUCTIONS (`.claude/skills/`,
        // `.cursor/rules/` — the only foreign paths in the 1.18.7 binary) and no
        // foreign hook config. Its executable extension point is its own plugin
        // layer, and that one is already closed by TODO 1.8's `--pure` after a
        // GLOBAL `~/.opencode/plugin/*.ts` was measured attaching to governed runs.
        foreignHookReplay: {
          sources: [],
          containment: {
            state: "none",
            detail:
              "No foreign hook path in the shipped binary. Its own executable layer is plugins, dropped by `--pure` on every governed run (verified `plugin: []`), with `XDG_CONFIG_HOME` redirected and project config disabled on top. The foreign paths it DOES read are instruction files, which is the instruction-provenance question, not this one.",
          },
        },
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
      },
    },
    readiness: {
      installedCandidates: ["opencode"],
      authCandidates: ["opencode"],
      // `auth list` is read-only and prints a COUNT, never a token.
      authArgs: ["auth", "list"],
      versionArgs: ["--version"],
      loginHint: "log into OpenCode first: `{bin} auth login`",
      installHint:
        "install OpenCode (`curl -fsSL https://opencode.ai/install | bash`), then `opencode auth login`",
      connectKind: "account",
    },
    credentials: {
      // NO credential plumbing at all, and that is deliberate on both counts.
      //
      // opencode is BYO-PROVIDER: `opencode auth login` writes its own
      // `auth.json`, which MUON neither reads, writes, nor relocates (the launch
      // guard moves XDG_CONFIG_HOME, never XDG_DATA_HOME, precisely so the
      // operator's own login survives). So there is nothing for MUON to forward.
      //
      // And it would happily USE `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` if it
      // saw them — which is exactly why they are absent here. Forwarding one
      // vendor's key to a different vendor's binary is the BYO-auth breach
      // ADR-0022 G5 names as the worst outcome in the whole design. Empty is the
      // statement that keeps that from happening by omission later.
      envKeys: [],
      ownedKeys: [],
      forwardToRunner: false,
    },
    // TODO 3.4 — THE CATALOGUE IS A SHAPE, NOT A LIST, AND THAT IS THE POINT.
    //
    // This was `null`, which made `assertVendorHasModelCatalog` answer 400 to
    // every per-dispatch override. The refusal was right while MUON could check
    // NOTHING about an opencode id: waving an unvalidatable value onto a vendor
    // argv is worse than refusing the override.
    //
    // It is no longer the only option. opencode's ids are `provider/model`
    // (models.dev-backed, `opencode models` enumerates them), so the FORM is
    // checkable even though the MEMBERSHIP is not — and the membership is not
    // checkable in principle, not merely uncurated: the live list is whatever
    // providers THIS operator ran `opencode auth login` against (121 ids on the
    // author's machine, a different 121 on the next). A hardcoded `known` here
    // would rot per-operator rather than per-release, which is the worst kind.
    //
    // So: `known` is EMPTY and that is a statement (see `idShape`), `allowCustom`
    // is true, and the form check refuses `sonnet` — which would otherwise reach
    // the vendor and fail there, opaquely, after a dispatch had already been
    // created. The desktop's live probe (`opencode models`) supplies the picker;
    // it is a suggestion source, never the authority.
    //
    // What this does NOT grant: the empty ACTION set is untouched, so ADR-0022
    // G10's full-auto gate stays exactly as shut as it was.
    models: {
      known: [],
      allowCustom: true,
      idShape: "provider-qualified",
    },
  },
  fake: {
    id: "fake",
    displayName: "Fake Vendor (dev/test)",
    shortLabel: "Fake",
    iconKey: "fake",
    provider: "muon-fake",
    // The dev/test seam. `visibility` fences it out of every public projection;
    // the LIVE `MUON_FAKE_VENDOR` env read is the second, independent condition
    // and stays in `fakeVendorEnabled()` where it is read per call.
    visibility: "dev-test",
    // Deliberately the neutral midpoint (`role-assignment`'s own `?? 0.5`), so
    // registering the fake can never change which lane a mixed crew picks.
    cost: 0.5,
    authority: {
      // A full-capability double, so the E2E can drive ANY role through the
      // real assignment engine without a vendor binary.
      supportedRoles: ALL_ROLES,
      // No coordinator seat: `COORDINATOR_VENDORS` has never included it.
      coordinatorSeat: false,
      dispatchable: true,
      delegatable: true,
      fleetSizeable: true,
      evaluator: false,
      planner: false,
      terminalTakeover: false,
      tier1: false,
    },
    // Flat and neutral ON PURPOSE — keeps role plans deterministic.
    roleAffinity: {
      orchestrator: 0.5,
      architect: 0.5,
      implementer: 0.5,
      reviewer: 0.5,
      qa: 0.5,
      scout: 0.5,
      docs: 0.5,
    },
    session: {
      driver: "none",
      canSend: false,
      canInterrupt: false,
      canResume: false,
      persistsSessionHandle: false,
    },
    execution: {
      modes: ["one-shot", "background"],
      // Never spawned: `FakeLaneAdapter` overrides `runTask` entirely.
      commandCandidates: ["muon-fake-vendor"],
      runtimeRequirement: null,
      compiler: "passthrough",
      guards: {
        strictMcpConfigFlag: false,
        // The test double asserts the WIRING; it has no boundary of its own.
        launchEnv: [],
        wideningFlags: [],
        // TODO 1.16: no binary is spawned at all, so there is nothing to fan out.
        // Stated rather than left blank, because "the fake is exempt" is exactly
        // the kind of gap a future real vendor would inherit by copying this row.
        nativeFanOut: {
          mechanism: null,
          suppression: {
            state: "none",
            detail:
              "No child process exists: FakeLaneAdapter overrides runTask entirely.",
          },
        },
        // TODO 1.15: same reasoning as above, and stated for the same reason — a
        // future real vendor copying this row must copy an ANSWER, not a blank.
        foreignHookReplay: {
          sources: [],
          containment: {
            state: "none",
            detail:
              "No child process exists, so no hook file of anyone's is ever read.",
          },
        },
      },
    },
    readiness: {
      // Empty is a STATEMENT: the fake has no readiness probe at all, which is
      // why `probeVendorReadiness('fake')` answers "unknown vendor".
      installedCandidates: [],
      authCandidates: [],
      authArgs: [],
      versionArgs: [],
      loginHint: "the dev/test fake vendor never authenticates",
      installHint:
        "set MUON_FAKE_VENDOR=1 to register the dev/test fake lane; there is no binary to install",
      connectKind: "local-runtime",
    },
    credentials: { envKeys: [], ownedKeys: [], forwardToRunner: false },
    models: {
      known: ["fake-model-1", "fake-model-2"],
      allowCustom: false,
      idShape: null,
    },
  },
};

/** Total lookup. Throws on an unknown id — callers that must not throw use the
 *  fail-closed accessors below instead. */
export function vendorEntry(id: VendorId): VendorEntry {
  return VENDOR_REGISTRY[id];
}

/**
 * The ONE way a derived set is built. Positive predicate, registry order.
 * Never `VENDOR_IDS.filter((id) => !FORBIDDEN.has(id))` — see rule 2 above.
 */
export function vendorsWhere(
  predicate: (entry: VendorEntry) => boolean
): readonly VendorId[] {
  return VENDOR_IDS.filter((id) => predicate(VENDOR_REGISTRY[id]));
}

/** Vendors an operator can see at all (the fake seam is excluded). */
export const publicVendorIds = (): readonly VendorId[] =>
  vendorsWhere((entry) => entry.visibility === "public");

/**
 * The ceiling on WORKER seats an operator may size one vendor to (the "3" in
 * "the 0–3 worker fleet"). Declared here, beside the projection that says WHICH
 * lanes are sizeable, so the route that enforces it, the preflight that
 * publishes it, and the tool that bounds its echoed agent list all read ONE
 * value — a tool whose own bound is smaller than the fleet silently drops seats
 * the coordinator needs to see.
 */
export const FLEET_MAX_AGENTS_PER_VENDOR = 3;

/** The 0–3 worker fleet. */
export const fleetVendorIds = (): readonly VendorId[] =>
  vendorsWhere(
    (entry) => entry.visibility === "public" && entry.authority.fleetSizeable
  );

/** May be targeted by `POST /api/dispatch` (the fake still needs its env seam). */
export const dispatchableVendorIds = (): readonly VendorId[] =>
  vendorsWhere((entry) => entry.authority.dispatchable);

/** May be named by a worker's `delegate` (same env seam caveat). */
export const delegatableVendorIds = (): readonly VendorId[] =>
  vendorsWhere((entry) => entry.authority.delegatable);

/** May seat the super-orchestrator at reserved ordinal 0. */
export const coordinatorVendorIds = (): readonly VendorId[] =>
  vendorsWhere((entry) => entry.authority.coordinatorSeat);

/** May run the ADR-0018 critique loop. */
export const evaluatorVendorIds = (): readonly VendorId[] =>
  vendorsWhere((entry) => entry.authority.evaluator);

/** May run the workflow planner. */
export const plannerVendorIds = (): readonly VendorId[] =>
  vendorsWhere((entry) => entry.authority.planner);

/** May be spawned into a desktop pty. The renderer is untrusted, so this is an
 *  authority boolean and not a label lookup. */
export const terminalTakeoverVendorIds = (): readonly VendorId[] =>
  vendorsWhere((entry) => entry.authority.terminalTakeover);

/**
 * The ONE label source (WAVE D). These three collapse the ~17 hand-written
 * label/icon tables ADR-0022 §1 counted, each of which had drifted from at least
 * one other.
 *
 * HONEST IDENTITY FALLBACK. An unknown id renders as ITSELF, never as a
 * neighbour and never as blank. That matters because two of these are reached by
 * ids outside the managed-lane namespace: the desktop's separate takeover/attach
 * namespace (`copilot`, `amp`, `gemini`, `vibe` — ADR-0022 §8) and provider keys
 * (`anthropic`, `openai`). Those call sites keep their own extra rows and defer
 * to these for anything the registry names.
 *
 * Presentation only. ADR-0022 §7 classes every one of these as MECHANICAL: a
 * mistake here is cosmetic, and none of them admits, ranks, or gates anything.
 */
export function vendorLabel(vendor: string): string {
  return isVendorId(vendor) ? VENDOR_REGISTRY[vendor].displayName : vendor;
}

/** Compact label for dense surfaces (cockpit rows, budget overlays, tabs). */
export function vendorShortLabel(vendor: string): string {
  return isVendorId(vendor) ? VENDOR_REGISTRY[vendor].shortLabel : vendor;
}

/** Glyph key an icon map resolves. Unknown ids fall through to their own id,
 *  so the icon map decides the fallback rather than this function. */
export function vendorIconKey(vendor: string): string {
  return isVendorId(vendor) ? VENDOR_REGISTRY[vendor].iconKey : vendor;
}

/**
 * The credential env keys forwarded to THIS vendor's child, and nothing else.
 *
 * Fail-closed for any string: an id outside the registry receives no credential
 * at all. That matters more here than anywhere else in this file — ADR-0022 G5
 * names "a wrong entry forwards `ANTHROPIC_API_KEY` to a third-party vendor
 * binary" as the worst outcome in the whole design, and it is the worst because
 * it is SILENT. The key is simply handed over, the receiving vendor may even
 * accept it, and nothing fails.
 */
export function vendorCredentialEnvKeys(vendor: string): readonly string[] {
  return isVendorId(vendor) ? VENDOR_REGISTRY[vendor].credentials.envKeys : [];
}

/**
 * The UNION of every vendor's credential env keys, in registry order, deduped.
 *
 * Exists so the two consumers that need the union — the lane child's deny-first
 * filter and the sandboxed runner's allowlist — derive it from ONE place. Two
 * hand-maintained unions is how a key ends up denied to its owner on one side
 * and forwarded to a stranger on the other.
 *
 * This is a POSITIVE construction (a union of stated keys), not a subtraction.
 * The one legitimate subtraction in the tree consumes this list rather than
 * competing with it — see `COMMON_LANE_ENV_KEYS` in
 * `packages/adapters/src/lane-runner.ts` and ADR-0022 §6.8.
 */
export function allVendorCredentialEnvKeys(): readonly string[] {
  return [
    ...new Set(
      VENDOR_IDS.flatMap((id) => [...VENDOR_REGISTRY[id].credentials.envKeys])
    ),
  ];
}

// ───────────────────── the coordinator preference (ADR-0022 §4) ─────────────────────

/**
 * The operator's DEFAULT quality ordering among already-authorized coordinators.
 *
 * A PREFERENCE, not a grant. Before this, three independent tie-breaks had to
 * agree by hand — the adapter affinity numbers, `input.lanes.indexOf` fed by
 * `createDefaultAdapters()` construction order, and `PLANNER_LANE_PREFERENCE[0]`
 * — and a fourth default was spelled four different ways across `apps/**`.
 */
export const DEFAULT_COORDINATOR_PREFERENCE: readonly VendorId[] = [
  "claude-code",
  "codex",
];

/**
 * INTERSECT, NEVER UNION. This is the whole safety property of §4.
 *
 * A preference list is operator input. If it were unioned into the coordinator
 * set, naming a vendor in a settings file would GRANT it the super-orchestrator
 * seat — an operator preference silently becoming an authority grant, which is
 * the exact failure mode this ADR exists to remove. So a configured id that is
 * not already `coordinatorSeat: true` is DROPPED, and the conformance test
 * asserts that a preference naming an ineligible vendor yields a list without
 * it.
 *
 * Authorized-but-unranked vendors keep registry order at the tail, so a new
 * coordinator is reachable the moment it earns the boolean — it just is not
 * preferred until an operator says so.
 */
export function coordinatorPreference(
  configured?: readonly string[]
): readonly VendorId[] {
  const allowed = new Set<string>(coordinatorVendorIds());
  const ranked: VendorId[] = [];
  for (const candidate of configured ?? DEFAULT_COORDINATOR_PREFERENCE) {
    if (allowed.has(candidate) && !ranked.includes(candidate as VendorId)) {
      ranked.push(candidate as VendorId);
    }
  }
  return [
    ...ranked,
    ...coordinatorVendorIds().filter((id) => !ranked.includes(id)),
  ];
}

/**
 * The single default coordinator seat, replacing every `?? "claude-code"`.
 *
 * THROWS when the registry names no coordinator at all. That is a registry
 * misconfiguration, not user input — it cannot be reached by anything an
 * operator or an agent types, and it is pinned by the conformance test. The
 * alternative (fall back to some id) would seat a vendor that has NOT earned the
 * seat, which is precisely the grant-by-accident this design refuses. A loud
 * failure on an impossible branch beats a silent wrong coordinator.
 */
export function defaultCoordinatorVendor(): VendorId {
  const [first] = coordinatorPreference();
  if (!first) {
    throw new Error(
      "vendor registry names no coordinator seat; refusing to seat an unauthorized vendor"
    );
  }
  return first;
}

// ───────────────────────── routing prose (ADR-0022 §5 Wave E) ─────────────────────────

/**
 * ONE routing-prose source, rendered from the registry.
 *
 * MUON used to state its own routing advice in two places that DISAGREED
 * (ADR-0022 §1.2(i)): the MCP `dispatch` tool description said
 * "implementation/repair loops → claude-code … cheap one-shot triage → cursor",
 * while the orchestrator system prompt said "a ready claude-code or codex
 * worker". The MCP copy was both more biased AND wrong about cursor, which the
 * role ceiling refuses a write role entirely. No code path enforced either.
 *
 * Rendered rather than written, so:
 *   - a new vendor appears in both surfaces with no edit, and
 *   - NO VENDOR IS NAMED AS A DEFAULT. The policy sentence talks about roles,
 *     cost and adversarial separation; the per-vendor lines are facts about what
 *     each lane may hold, not a recommendation to prefer one.
 *
 * It stays advice: nothing here admits anything. The role ceiling
 * (`assertVendorMayHoldRole`) is what actually refuses.
 */
export function vendorRoutingLines(): readonly string[] {
  return publicVendorIds().map((id) => {
    const entry = VENDOR_REGISTRY[id];
    // TODO 1.5: the CEILING, not the declared list. These two now differ for a
    // lane whose channel cannot pre-set least-privilege, and the brief must
    // advertise what `assertVendorMayHoldRole` will actually admit — telling an
    // orchestrator a lane "may hold implementer" and then refusing the dispatch
    // is worse than not offering it, because the plan is already built by then.
    const roles = vendorRoleCeiling(id);
    const roleText =
      roles.length === 0
        ? "holds NO role and cannot be dispatched work"
        : `may hold ${[...roles].join(", ")}`;
    const writes = roles.some(
      (role) => ROLE_SPECS[role].authority !== "read-only"
    );
    const sessionText = !entry.session.canSend
      ? vendorCanBeInterruptedByMuon(id)
        ? "watch + interrupt, no mid-run steer"
        : "one-shot only, nothing to steer"
      : "steerable mid-run";
    return `${id} (${entry.shortLabel}): ${roleText}; ${
      writes ? "may write" : "READ-ONLY"
    }; ${sessionText}; cost ${entry.cost}.`;
  });
}

/**
 * The vendor-neutral policy sentence that accompanies the lines above. Names no
 * vendor and needs no edit when the fleet changes.
 */
export const VENDOR_ROUTING_POLICY =
  "Route by ROLE first, then by evidence: a lane is refused any role outside its list, so match the work to a role and the role to a lane that holds it. Put review and security-audit on a DIFFERENT ready lane than the one that wrote the code, so the second opinion is adversarial. Prefer a lower-cost lane for reconnaissance and a higher-cost one where a weak model is actively harmful. Ground every choice in capability_preflight readiness rather than assumption; a lane that is not ready is not an option.";

/** The lines + the policy, as one block for a tool description or a prompt. */
export function vendorRoutingBrief(): string {
  return `${VENDOR_ROUTING_POLICY} Lanes: ${vendorRoutingLines().join(" ")}`;
}

/**
 * ABSENCE MEANS NO CAPABILITY. An unknown vendor gets a session posture with
 * every boolean `false`, so a lookup miss can never read as "steerable".
 */
const NO_SESSION_CAPABILITY = {
  driver: "none",
  canSend: false,
  canInterrupt: false,
  canResume: false,
  persistsSessionHandle: false,
} as const satisfies VendorEntry["session"];

/** Fail-closed session posture for any string. */
export function sessionCapability(vendor: string): VendorEntry["session"] {
  return isVendorId(vendor)
    ? VENDOR_REGISTRY[vendor].session
    : NO_SESSION_CAPABILITY;
}

/**
 * Does this vendor have a live session driver at all?
 *
 * This is the "interactive vs one-shot" question for a `kind: "auto"` dispatch,
 * asked ONCE here. It used to be spelled name-derived — `vendor ===
 * "claude-code" || vendor === "codex"` — in BOTH `packages/runner/src/execute.ts`
 * and `backend/src/routes/dispatch.ts` (ADR-0022 §1.2(c)), where the two copies
 * had to be kept in step by hand. Fail-closed by construction: an id outside the
 * registry has no session posture, so it has no driver.
 */
export function vendorSupportsInteractive(vendor: string): boolean {
  return sessionCapability(vendor).driver !== "none";
}

/**
 * TODO 1.4 — "watch + interrupt" is a promise, so ask it through the conjunction
 * that makes it true rather than off the boolean alone.
 *
 * `vendorRoutingLines()` puts this sentence in front of an orchestrating agent,
 * which then plans around being able to stop a lane it started. The flag says the
 * lane claims interrupt authority; the driver kind says whether MUON has a
 * channel to deliver it on. Both are required, and reading only the first is how
 * a session MUON merely WATCHES — a human's attached terminal, where the stop is
 * the operator's Ctrl-C and not MUON's — would end up advertised as one MUON can
 * stop. Fail-closed for an unknown id, via `sessionCapability`.
 */
/**
 * TODO 1.5 — the least-privilege controls this lane's channel CANNOT pre-set.
 *
 * Empty for every vendor today, and that is the honest answer rather than a
 * placeholder: no vendor declares `driver: "acp"` yet. Fail-closed for an unknown
 * id only in the sense that it has no driver and therefore no delta — an
 * unregistered id is already refused every role by `vendorRoleCeiling`, so this
 * accessor is not the thing standing between it and authority.
 */
export function vendorUnenforceableControls(
  vendor: string
): readonly LeastPrivilegeControl[] {
  return SESSION_DRIVER_UNENFORCEABLE_CONTROLS[sessionCapability(vendor).driver];
}

/**
 * TODO 1.5 — may this lane hold a role that WRITES?
 *
 * The rule is one sentence: a lane that cannot pre-set its own least-privilege
 * may not be given write authority. `implementer` is the role this bites, and
 * ADR-0007 named it explicitly — an ACP lane is weaker than a compiled one, so
 * promoting one to implementer had to wait for the delta to be stated. It is
 * stated now, and the answer it produces is no.
 *
 * Read-only roles are unaffected, and deliberately so. A reviewer that cannot be
 * pre-sandboxed is still a reviewer: `allowsWriteTools: false` on the role and
 * the driver's default-deny bridge both hold without any preset, because there is
 * no write for a missing preset to have permitted.
 */
export function vendorMayHoldWriteAuthority(vendor: string): boolean {
  return vendorUnenforceableControls(vendor).length === 0;
}

export function vendorCanBeInterruptedByMuon(vendor: string): boolean {
  const session = sessionCapability(vendor);
  return (
    session.canInterrupt &&
    SESSION_DRIVERS_THAT_CAN_INTERRUPT.includes(session.driver)
  );
}

/**
 * Fail-closed role ceiling. `[]` REFUSES every role — the opposite of the
 * `undefined`-admits-everything default that `assertVendorMayHoldRole` and
 * `roleFit` carry today (ADR-0022 §1.2(b), closed in Wave C1).
 *
 * TODO 1.5: the declared list is INTERSECTED with what the lane's channel can
 * actually bound, so a lane that cannot pre-set sandbox, approval policy, or tool
 * lists loses its write-authority roles here rather than in a reviewer's head.
 * The subtraction runs on the accessor every surface already calls, which is what
 * makes it a ceiling and not a lint: flipping a vendor to `driver: "acp"` narrows
 * it in the same commit, and adding `implementer` to an ACP lane's
 * `supportedRoles` has no effect at all. A registry test also fails, so the
 * mistake is reported as well as contained.
 */
export function vendorRoleCeiling(vendor: string): readonly AgentRole[] {
  if (!isVendorId(vendor)) {
    return [];
  }
  const declared = VENDOR_REGISTRY[vendor].authority.supportedRoles;
  return vendorMayHoldWriteAuthority(vendor)
    ? declared
    : declared.filter((role) => ROLE_SPECS[role].authority !== "write");
}

/**
 * The NEUTRAL cost, and the reason this accessor exists at all.
 *
 * `role-assignment.ts` has always read `lane.cost ?? 0.5`, so 0.5 is the value
 * every lane silently carried while `cost` went unsupplied. Returning it for an
 * unregistered id makes this accessor a strict no-op for anything the registry
 * does not name: an unknown lane keeps exactly the ranking it had before.
 */
const NEUTRAL_VENDOR_COST = 0.5;

/**
 * Relative running cost, 0 = free/local … 1 = premium frontier.
 *
 * RANKS, NEVER ADMITS. `roleFit` folds this into a small ± adjustment on top of
 * an affinity the lane has ALREADY been authorized for, so a cheap lane can
 * never reach a role its ceiling refuses and an expensive one can never lose a
 * role it is the only holder of. This is the one field in the registry whose
 * wrong value is a worse *plan*, never a wider *boundary* (ADR-0022 §7,
 * "borderline").
 *
 * Deliberately NOT fail-closed-to-zero: 0 is "free/local", which for `scout`
 * is the STRONGEST possible bonus. An unknown id must not out-rank a registered
 * lane by being unknown, so the miss returns the neutral midpoint instead.
 */
export function vendorCost(vendor: string): number {
  return isVendorId(vendor) ? VENDOR_REGISTRY[vendor].cost : NEUTRAL_VENDOR_COST;
}

/** Placeholder until TODO 5.3 ships dollar/token metering — never fake dollars. */
export const COST_ACCOUNTING_NOT_METERED =
  "cost accounting not yet metered" as const;

/** The honest answer everywhere MUON surfaces a lane's relative cost ordinal. */
export const CREW_COST_ACCOUNTING = {
  metered: false as const,
  notice: COST_ACCOUNTING_NOT_METERED,
};

export type VendorCostOrdinalView = typeof CREW_COST_ACCOUNTING & {
  /** Relative running cost ordinal from {@link vendorCost}, 0…1 — not dollars. */
  ordinal: number;
};

/** Relative cost ordinal plus the not-yet-metered placeholder (TODO 5.3). */
export function vendorCostOrdinalView(vendor: string): VendorCostOrdinalView {
  return {
    ...CREW_COST_ACCOUNTING,
    ordinal: vendorCost(vendor),
  };
}
